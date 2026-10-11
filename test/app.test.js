import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { createStore } from '../src/lib/store.js';
import { rulesEngine } from '../src/engine/recommend.js';
import { packHash } from '../src/engine/evidence.js';
import { fakeApi, dispute, links } from './fixtures.js';

function start(api, cfg = {}) {
  const app = createApp({ api, store: createStore(null), engine: rulesEngine, config: { clientId: 'test-client', dryRun: false, ...cfg } });
  return new Promise(r => { const s = app.listen(0, () => r({ s, base: `http://127.0.0.1:${s.address().port}` })); });
}
const j = async (base, p, body) => { const r = await fetch(base + p, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}); return { status: r.status, body: await r.json().catch(() => null), text: '' }; };

test('pages and health respond; no credentials -> 503 with guidance', async () => {
  const { s, base } = await start(null);
  for (const p of ['/', '/seller', '/disputes', '/disputes/PP-D-1']) assert.equal((await fetch(base + p)).status, 200, p);
  assert.equal((await j(base, '/healthz')).body.credentials, false);
  const r = await j(base, '/api/disputes'); assert.equal(r.status, 503); assert.equal(r.body.error, 'NO_CREDENTIALS');
  assert.equal((await fetch(base + '/vendor/ag-grid/ag-grid-community.min.js')).status, 200);
  s.close();
});

test('dispute detail: allowed types, cited pack, FIGHT recommendation', async () => {
  const { s, base } = await start(fakeApi());
  const r = await j(base, '/api/disputes/PP-D-1');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.allowedTypes, ['PROOF_OF_FULFILLMENT']);
  assert.equal(r.body.recommendation.action, 'FIGHT');
  assert.ok(r.body.packs.PROOF_OF_FULFILLMENT.validation.ok);
  assert.ok(r.body.packs.PROOF_OF_FULFILLMENT.claims.every(c => c.refs.length > 0));
  assert.equal(r.body._ctx, undefined);
  s.close();
});

test('submit: refused without approval, wrong type, uncited claim, or changed pack; succeeds and shows status change', async () => {
  const api = fakeApi(); const { s, base } = await start(api);
  const a = (await j(base, '/api/disputes/PP-D-1')).body; const p = a.packs.PROOF_OF_FULFILLMENT;
  const ok = { action: 'provide_evidence', evidenceType: 'PROOF_OF_FULFILLMENT', packHash: p.hash, approved: true, confirm: 'APPROVE' };
  assert.equal((await j(base, '/api/disputes/PP-D-1/submit', { ...ok, approved: false })).body.error, 'NOT_APPROVED');
  assert.equal((await j(base, '/api/disputes/PP-D-1/submit', { ...ok, evidenceType: 'OTHER' })).body.error, 'TYPE_NOT_REQUESTED');
  const unc = await j(base, '/api/disputes/PP-D-1/submit', { ...ok, customClaims: [{ text: 'Buyer received it', refs: [] }] });
  assert.equal(unc.status, 409); assert.equal(unc.body.error, 'UNCITED_CLAIMS'); assert.equal(unc.body.rejected[0].reason, 'NO_LINKED_RECORD');
  assert.equal((await j(base, '/api/disputes/PP-D-1/submit', { ...ok, packHash: 'stale' })).body.error, 'PACK_CHANGED');
  assert.equal(api.calls.filter(c => c.name === 'provideEvidence').length, 0, 'nothing sent before a valid approval');
  const r = await j(base, '/api/disputes/PP-D-1/submit', ok);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.before.label, 'Your response needed'); assert.equal(r.body.after.label, 'Under PayPal review');
  const call = api.calls.find(c => c.name === 'provideEvidence');
  assert.equal(call.args[1].evidences[0].evidence_type, 'PROOF_OF_FULFILLMENT');
  assert.ok(call.args[2][0].data.toString().startsWith('%PDF'));
  s.close();
});

test('submit: custom claim citing a fetched record is accepted (hash includes it)', async () => {
  const api = fakeApi(); const { s, base } = await start(api, { dryRun: true });
  const a = (await j(base, '/api/disputes/PP-D-1')).body; const p = a.packs.PROOF_OF_FULFILLMENT;
  const custom = { id: 'custom-1', text: 'Order paid in full', refs: [{ type: 'order', id: 'ORD123' }], source: 'seller' };
  const hash = packHash('PP-D-1', 'PROOF_OF_FULFILLMENT', [...p.validation.accepted, custom]);
  const r = await j(base, '/api/disputes/PP-D-1/submit', { action: 'provide_evidence', evidenceType: 'PROOF_OF_FULFILLMENT', customClaims: [custom], packHash: hash, approved: true, confirm: 'APPROVE' });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.dryRun, true);
  assert.match(r.body.payloadPreview.evidences[0].notes, /Seller's own statement: Order paid in full \[order ORD123\]/);
  // Without the seller-wording mark, free text must be a rendered fact.
  const { source, ...unmarked } = custom;
  const r2 = await j(base, '/api/disputes/PP-D-1/submit', { action: 'provide_evidence', evidenceType: 'PROOF_OF_FULFILLMENT', customClaims: [unmarked], packHash: hash, approved: true, confirm: 'APPROVE' });
  assert.equal(r2.body.error, 'UNCITED_CLAIMS'); assert.equal(r2.body.rejected[0].reason, 'NOT_A_RECORDED_FACT');
  s.close();
});

test('under review dispute: WAIT, no evidence types, provide_evidence refused', async () => {
  const api = fakeApi({ d: dispute({ status: 'UNDER_REVIEW', dispute_life_cycle_stage: 'CHARGEBACK', seller_response_due_date: undefined, evidences: [], links: links('provide_supporting_info') }) });
  const { s, base } = await start(api);
  const a = (await j(base, '/api/disputes/PP-D-1')).body;
  assert.equal(a.status.label, 'Under PayPal review'); assert.equal(a.recommendation.action, 'WAIT'); assert.deepEqual(a.allowedTypes, []);
  assert.ok(a.supporting);
  const r = await j(base, '/api/disputes/PP-D-1/submit', { action: 'provide_evidence', evidenceType: 'OTHER', approved: true, confirm: 'APPROVE' });
  assert.equal(r.body.error, 'ACTION_NOT_OFFERED');
  s.close();
});

test('queue lists disputes with status label and waiting flag', async () => {
  const api = fakeApi({ d: dispute({ status: 'OPEN', create_time: new Date().toISOString(), links: links(), evidences: [] }) });
  const { s, base } = await start(api);
  const r = await j(base, '/api/disputes');
  assert.equal(r.body.items[0].label, 'Waiting for PayPal'); assert.equal(r.body.items[0].waiting, true);
  s.close();
});

test('ship: risk gate blocks a redirected address unless acknowledged', async () => {
  const api = fakeApi(); const { s, base } = await start(api);
  const shipTo = { address_line_1: '9 Elsewhere', admin_area_2: 'San Jose', admin_area_1: 'CA', postal_code: '95131', country_code: 'US' };
  const r = await j(base, '/api/orders/ORD123/ship', { carrier: 'USPS', trackingNumber: '1', shipTo });
  assert.equal(r.status, 409); assert.equal(r.body.error, 'RISK_BLOCK');
  assert.equal(api.calls.filter(c => c.name === 'addTracking').length, 0);
  const ok = await j(base, '/api/orders/ORD123/ship', { carrier: 'USPS', trackingNumber: '1' });
  assert.equal(ok.status, 200); assert.equal(api.calls.filter(c => c.name === 'addTracking').length, 1);
  s.close();
});

test('webhook endpoint stores events (unverified without webhook id)', async () => {
  const { s, base } = await start(fakeApi());
  const r = await j(base, '/api/webhooks/paypal', { id: 'WH-1', event_type: 'CUSTOMER.DISPUTE.CREATED', resource: { dispute_id: 'PP-D-1' } });
  assert.equal(r.body.verification, 'UNVERIFIED_NO_WEBHOOK_ID');
  assert.equal((await j(base, '/api/webhooks')).body[0].resourceId, 'PP-D-1');
  s.close();
});

test('no AG Grid Enterprise; no outcome wording (won/win/winning/winner/seller favour) in UI, README or user-facing src', () => {
  const NO_WIN = /\b(won|win|wins|winning|winner)\b|seller fav|resolved in (the )?seller|in your favou?r/i;
  const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1').split('\n').filter(l => !l.includes('OUTCOME_WORDS') && !l.includes('NO_WIN')).join('\n');
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
  const root = new URL('..', import.meta.url).pathname;
  const files = [...walk(path.join(root, 'public')), ...walk(path.join(root, 'src')), path.join(root, 'README.md'), ...fs.readdirSync(path.join(root, 'docs')).filter(f => f.endsWith('.md')).map(f => path.join(root, 'docs', f))];
  for (const f of files) {
    const t = fs.readFileSync(f, 'utf8');
    assert.doesNotMatch(t, /ag-grid-enterprise|setLicenseKey|LicenseManager/, f);
    const body = f.endsWith('.md') ? t.replace(/never (claims|says)[^\n]*/gi, '') : strip(t);
    assert.doesNotMatch(body, NO_WIN, f);
  }
});
