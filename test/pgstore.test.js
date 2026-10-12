import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { createStore } from '../src/lib/store.js';
import { createPgMirror, attachPgMirror } from '../src/lib/pgMirror.js';
import { loadConfig } from '../src/config.js';

// In-memory fake of the two SQL statements the mirror uses.
function fakePool({ failWrites = false } = {}) {
  const rows = new Map(); const calls = [];
  return { rows, calls, async query(sql, params = []) {
    calls.push(sql.trim().split(/\s+/)[0]);
    if (/^CREATE/.test(sql.trim())) return { rows: [] };
    if (/^SELECT/.test(sql.trim())) return { rows: rows.has(params[0]) ? [{ data: JSON.parse(rows.get(params[0])) }] : [] };
    if (failWrites) throw Object.assign(new Error('boom'), { code: 'ECONNRESET' });
    rows.set(params[0], params[1]); return { rows: [] };
  } };
}
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pp-pg-')), 'store.json');

test('DATABASE_URL unset: config has no databaseUrl and the store works as before', () => {
  assert.equal(loadConfig({}).databaseUrl, '');
  const s = createStore(tmpFile()); s.audit({ type: 'X' }); assert.equal(s.data.audit.length, 1); assert.equal(s.pgMirror, undefined);
});
test('DATABASE_URL set: read from env only', () => {
  assert.equal(loadConfig({ DATABASE_URL: 'postgres://u:p@h/db' }).databaseUrl, 'postgres://u:p@h/db');
});
test('saves (orders, webhooks, agent runs, ledger transactions) are mirrored and survive a "restart" with a wiped file', async () => {
  const pool = fakePool();
  const s1 = await attachPgMirror(createStore(tmpFile()), createPgMirror({ pool }));
  s1.upsertOrder('O1', { status: 'COMPLETED' });
  s1.addWebhook({ id: 'WH-1', type: 'CUSTOMER.DISPUTE.CREATED' });
  s1.data.agentRuns = { 'PP-D-1': [{ at: 't', proposals: [{ id: 'P1' }] }] }; s1.save();
  s1.transaction(() => { s1.data.disputeWrites = { 'PP-D-1': [{ id: 'w1', at: 't' }] }; });
  await s1.pgMirror.flush();
  // Restart: new process, /tmp wiped (fresh file), same database.
  const s2 = await attachPgMirror(createStore(tmpFile()), createPgMirror({ pool }));
  assert.equal(s2.getOrder('O1').status, 'COMPLETED');
  assert.equal(s2.data.webhooks[0].id, 'WH-1');
  assert.equal(s2.data.agentRuns['PP-D-1'][0].proposals[0].id, 'P1');
  assert.equal(s2.data.disputeWrites['PP-D-1'][0].id, 'w1');
});
test('writes are serialised and the latest snapshot wins', async () => {
  const pool = fakePool();
  const s = await attachPgMirror(createStore(null), createPgMirror({ pool }));
  for (let i = 0; i < 20; i++) s.audit({ type: 'T', i });
  await s.pgMirror.flush();
  assert.equal(JSON.parse(pool.rows.get('default')).audit.length, 20);
  assert.ok(pool.calls.filter(c => c === 'INSERT').length < 21);
});
test('a failing database write never throws into the app', async () => {
  const pool = fakePool({ failWrites: true });
  const s = await attachPgMirror(createStore(null), createPgMirror({ pool }));
  assert.doesNotThrow(() => s.audit({ type: 'X' }));
  await s.pgMirror.flush();
  assert.equal(s.data.audit.length, 1);
});

import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { guardPool, createPgPool, mergeSaved } from '../src/lib/pgMirror.js';

test('fix 2: idle-connection error on the pool is handled, not thrown', () => {
  const pool = guardPool(new EventEmitter());
  assert.doesNotThrow(() => pool.emit('error', Object.assign(new Error('terminated'), { code: '57P01' })));
});
test('fix 3: real pg pool has a 5 s connect timeout and an error listener', async () => {
  const pool = await createPgPool('postgres://u:p@db.invalid:5432/x');
  assert.equal(pool.options.connectionTimeoutMillis, 5000);
  assert.ok(pool.listenerCount('error') >= 1);
  await pool.end();
});
test('fix 3: server answers /healthz while the database host hangs', async () => {
  const port = 41000 + Math.floor(Math.random() * 1000);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-srv-'));
  // 10.255.255.1 is non-routable: the TCP connect hangs until the 5 s timeout.
  const child = spawn(process.execPath, ['src/server.js'], { cwd: new URL('..', import.meta.url).pathname, stdio: 'ignore',
    env: { PATH: process.env.PATH, PORT: String(port), DATABASE_URL: 'postgres://u:p@10.255.255.1:5432/x', PROOFPILOT_DATA_FILE: path.join(dir, 's.json') } });
  try {
    let ok = false; const until = Date.now() + 4000;
    while (!ok && Date.now() < until) { try { ok = (await fetch(`http://127.0.0.1:${port}/healthz`)).ok; } catch { await new Promise(r => setTimeout(r, 100)); } }
    assert.ok(ok, 'healthz should respond within 4 s, before the DB connect timeout');
  } finally { child.kill('SIGKILL'); }
});
test('fix 4: older database copy does not overwrite newer local data; ledgers merged; saved after load', async () => {
  const pool = fakePool();
  pool.rows.set('default', JSON.stringify({ orders: { O1: { id: 'O1', status: 'OLD', updatedAt: '2026-01-01T00:00:00Z' }, O2: { id: 'O2', updatedAt: '2026-01-01T00:00:00Z' } },
    disputeWrites: { D: [{ id: 'w-db', at: '2026-01-01' }] }, webhooks: [{ id: 'WH-db', at: '2026-01-01' }], approvals: [], audit: [] }));
  const file = tmpFile();
  const local = createStore(file);
  local.data.orders.O1 = { id: 'O1', status: 'NEW', updatedAt: '2026-06-01T00:00:00Z' };
  local.data.disputeWrites = { D: [{ id: 'w-local', at: '2026-06-01' }] };
  const s = await attachPgMirror(local, createPgMirror({ pool }));
  assert.equal(s.data.orders.O1.status, 'NEW');
  assert.ok(s.data.orders.O2);
  assert.deepEqual(s.data.disputeWrites.D.map(w => w.id).sort(), ['w-db', 'w-local']);
  assert.equal(s.data.webhooks[0].id, 'WH-db');
  await s.pgMirror.flush();
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).orders.O1.status, 'NEW');
  assert.equal(JSON.parse(pool.rows.get('default')).orders.O1.status, 'NEW');
  const d = { orders: { A: { updatedAt: '2' } } }; mergeSaved(d, { orders: { A: { updatedAt: '3', v: 1 } } }); assert.equal(d.orders.A.v, 1);
});
test('fix 5: a failed table setup is retried by the next write', async () => {
  let creates = 0; const rows = new Map();
  const pool = { async query(sql, params) { if (/^CREATE/.test(sql)) { if (++creates === 1) throw new Error('down'); return { rows: [] }; }
    if (/^INSERT/.test(sql.trim())) rows.set(params[0], params[1]); return { rows: [] }; } };
  const m = createPgMirror({ pool });
  m.schedule({ a: 1 }); await m.flush(); assert.equal(rows.size, 0);
  m.schedule({ a: 2 }); await m.flush(); assert.equal(creates, 2); assert.equal(JSON.parse(rows.get('default')).a, 2);
});
test('fix 6: flushWithin returns within the limit when the database hangs', async () => {
  const m = createPgMirror({ pool: { query: () => new Promise(() => {}) } });
  m.schedule({ a: 1 }); const t = Date.now(); await m.flushWithin(200); assert.ok(Date.now() - t < 1000);
});
