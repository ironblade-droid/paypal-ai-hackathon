// Tiny JSON-file store for local seller data (orders we created, risk checks, approvals, webhook events, audit log).
// PayPal stays the source of truth: every record keeps the PayPal id so it can be re-fetched.
//
// Concurrency (review v0.5, finding a). ProofPilot is meant to run as ONE process per data file. To stay safe if two
// processes do share a file anyway:
//   - every save takes a lock file (<file>.lock, created with O_EXCL), re-reads the file and merges the money-write
//     ledger (store.data.disputeWrites) by entry id before writing, so one process cannot erase another's ledger entry;
//   - writes are atomic: temp file in the same folder, fsync, then rename over the old file;
//   - money writes use store.transaction(fn): lock, reload from disk, check, record, save, unlock, all synchronous, so a
//     second process sees the first one's reservation before it can make its own.
// Other collections (orders, audit, ...) are overwritten by whichever process saves last: run a single process.
import fs from 'node:fs';
import path from 'node:path';

const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 5_000;
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function acquireLock(lock) {
  const until = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try { const fd = fs.openSync(lock, 'wx', 0o600); fs.writeSync(fd, String(process.pid)); fs.closeSync(fd); return; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) { fs.rmSync(lock, { force: true }); continue; } } catch { continue; }
      if (Date.now() > until) { const err = new Error(`Store lock ${lock} is held by another process.`); err.code = 'STORE_LOCKED'; throw err; }
      sleepSync(15);
    }
  }
}
const releaseLock = (lock) => { try { fs.rmSync(lock, { force: true }); } catch { /* already gone */ } };

function readFile(file) {
  if (!file || !fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
// Ledger merge: union of entries by id; for the same id the later-updated copy wins.
export function mergeLedgers(mine = {}, disk = {}) {
  const out = {};
  for (const id of new Set([...Object.keys(disk || {}), ...Object.keys(mine || {})])) {
    const byId = new Map();
    for (const w of [...(disk?.[id] || []), ...(mine?.[id] || [])]) {
      const k = w.id || `${w.at}|${w.source}|${w.proposalId || w.action}`;
      const prev = byId.get(k);
      if (!prev || String(w.updatedAt || w.at) >= String(prev.updatedAt || prev.at)) byId.set(k, w);
    }
    out[id] = [...byId.values()].sort((a, b) => String(a.at).localeCompare(String(b.at)));
  }
  return out;
}

export function createStore(file) {
  const data = { orders: {}, approvals: [], webhooks: [], audit: [] };
  const initial = readFile(file); if (initial) Object.assign(data, initial);
  const lock = file ? `${file}.lock` : null;
  let depth = 0; // re-entrant inside transaction()
  const persistHooks = []; // e.g. the optional Postgres mirror (src/lib/pgMirror.js)
  const notify = () => { for (const h of persistHooks) h(); };
  const writeAtomic = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    const fd = fs.openSync(tmp, 'w', 0o600);
    try { fs.writeSync(fd, JSON.stringify(data, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
  };
  // Pull other processes' ledger entries in (never drops ours).
  const reload = () => {
    const disk = readFile(file); if (!disk) return;
    data.disputeWrites = mergeLedgers(data.disputeWrites, disk.disputeWrites);
  };
  const withLock = (fn) => {
    if (!file) return fn();
    if (depth > 0) return fn();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    acquireLock(lock); depth++;
    try { return fn(); } finally { depth--; releaseLock(lock); }
  };
  const save = () => { if (file) withLock(() => { reload(); writeAtomic(); }); notify(); };
  return {
    data,
    save,
    reload: () => withLock(reload),
    // Synchronous critical section for money writes: lock, reload ledger from disk, run fn, save, unlock.
    transaction(fn) { const r = withLock(() => { reload(); const r = fn(); if (file) writeAtomic(); return r; }); notify(); return r; },
    onPersist(fn) { persistHooks.push(fn); },
    upsertOrder(id, patch) { data.orders[id] = { ...(data.orders[id] || { id }), ...patch, updatedAt: new Date().toISOString() }; save(); return data.orders[id]; },
    getOrder(id) { return Object.hasOwn(data.orders, id) ? data.orders[id] : undefined; },
    listOrders() { return Object.values(data.orders).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))); },
    findOrderByCapture(captureId) { return Object.values(data.orders).find(o => o.captureId === captureId); },
    addApproval(a) { data.approvals.push(a); save(); return a; },
    addWebhook(e) { data.webhooks.unshift(e); data.webhooks = data.webhooks.slice(0, 200); save(); return e; },
    audit(entry) { data.audit.unshift({ at: new Date().toISOString(), ...entry }); data.audit = data.audit.slice(0, 500); save(); },
  };
}
