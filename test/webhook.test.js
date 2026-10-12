// Webhook signature verification (POST /api/webhooks/paypal). Fake PayPal API: no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { createStore } from '../src/lib/store.js';
import { rulesEngine } from '../src/engine/recommend.js';
import { fakeApi } from './fixtures.js';

const HEADERS = { 'PAYPAL-AUTH-ALGO': 'SHA256withRSA', 'PAYPAL-CERT-URL': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-test',
  'PAYPAL-TRANSMISSION-ID': 'tx-1', 'PAYPAL-TRANSMISSION-SIG': 'sig==', 'PAYPAL-TRANSMISSION-TIME': '2026-10-12T09:00:00Z' };
const EVT = { id: 'WH-EVT-1', event_type: 'CUSTOMER.DISPUTE.CREATED', resource: { dispute_id: 'PP-D-1' } };

async function start({ status = 'SUCCESS', webhookId = 'WH-ID-TEST', api = fakeApi(), verifyThrows = false } = {}) {
  const verifyCalls = [];
  if (api) api.verifyWebhook = async (p) => { verifyCalls.push(p); if (verifyThrows) throw new Error('ECONNRESET'); return { verification_status: status }; };
  const reads = []; if (api) { const g = api.getDispute; api.getDispute = async (...a) => { reads.push(a[0]); return g(...a); }; }
  const store = createStore(null);
  const app = createApp({ api, store, engine: rulesEngine, config: { dryRun: false, webhookId, writePasscode: 'pc' } });
  const s = await new Promise(r => { const x = app.listen(0, () => r(x)); });
  const post = async (body = EVT, headers = HEADERS) => { const r = await fetch(`http://127.0.0.1:${s.address().port}/api/webhooks/paypal`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() }; };
  return { s, post, store, verifyCalls, reads };
}
const settle = () => new Promise(r => setTimeout(r, 50));

test('webhook SUCCESS: verified with the exact headers + webhook id + event, stored once, dispute analysed read-only', async () => {
  const { s, post, store, verifyCalls, reads } = await start();
  try {
    const r = await post();
    assert.equal(r.status, 200); assert.deepEqual(r.body, { received: true, verification: 'SUCCESS' });
    assert.deepEqual(verifyCalls[0], { auth_algo: 'SHA256withRSA', cert_url: HEADERS['PAYPAL-CERT-URL'], transmission_id: 'tx-1', transmission_sig: 'sig==',
      transmission_time: '2026-10-12T09:00:00Z', webhook_id: 'WH-ID-TEST', webhook_event: EVT });
    await settle();
    assert.equal(store.data.webhooks.length, 1); assert.equal(store.data.webhooks[0].accepted, true); assert.equal(store.data.webhooks[0].resourceId, 'PP-D-1');
    assert.deepEqual(reads, ['PP-D-1']); assert.ok(store.data.webhooks[0].analysis?.recommendation);
    // A repeat delivery of the same event is acknowledged but not stored or analysed again.
    const d = await post();
    assert.equal(d.status, 200); assert.equal(d.body.duplicate, true); await settle();
    assert.equal(store.data.webhooks.length, 1); assert.equal(reads.length, 1);
  } finally { s.close(); }
});

test('webhook FAILURE: 401, nothing stored, no PayPal read', async () => {
  const { s, post, store, reads } = await start({ status: 'FAILURE' });
  try {
    const r = await post();
    assert.equal(r.status, 401); assert.equal(r.body.error, 'WEBHOOK_NOT_VERIFIED'); assert.equal(r.body.verification, 'FAILURE');
    await settle(); assert.equal(store.data.webhooks.length, 0); assert.deepEqual(reads, []); assert.equal(store.data.audit.length, 0);
  } finally { s.close(); }
});

test('webhook: verify call failing is 502 (PayPal retries), nothing stored', async () => {
  const { s, post, store } = await start({ verifyThrows: true });
  try { const r = await post(); assert.equal(r.status, 502); assert.equal(r.body.error, 'WEBHOOK_VERIFY_UNAVAILABLE'); assert.equal(store.data.webhooks.length, 0); }
  finally { s.close(); }
});

test('webhook: any missing transmission header is 400 and PayPal is not called', async () => {
  const { s, post, store, verifyCalls } = await start();
  try {
    for (const k of Object.keys(HEADERS)) {
      const h = { ...HEADERS }; delete h[k];
      const r = await post(EVT, h);
      assert.equal(r.status, 400, k); assert.equal(r.body.error, 'WEBHOOK_HEADERS_MISSING'); assert.deepEqual(r.body.missing, [k.toLowerCase()]);
    }
    assert.equal((await post(EVT, {})).body.missing.length, 5);
    assert.equal(verifyCalls.length, 0); assert.equal(store.data.webhooks.length, 0);
  } finally { s.close(); }
});

test('webhook without PAYPAL_SANDBOX_WEBHOOK_ID: logged as UNVERIFIED, never verified, never analysed', async () => {
  const { s, post, store, verifyCalls, reads } = await start({ webhookId: '' });
  try {
    const r = await post(EVT, {});
    assert.equal(r.status, 200); assert.equal(r.body.verification, 'UNVERIFIED_NO_WEBHOOK_ID');
    await settle();
    assert.equal(verifyCalls.length, 0); assert.deepEqual(reads, []);
    assert.equal(store.data.webhooks[0].accepted, false); assert.equal(store.data.webhooks[0].analysis, undefined);
  } finally { s.close(); }
});

test('webhook id set but no PayPal credentials: 503, nothing accepted', async () => {
  const { s, post, store } = await start({ api: null });
  try { const r = await post(); assert.equal(r.status, 503); assert.equal(r.body.error, 'WEBHOOK_CANNOT_VERIFY'); assert.equal(store.data.webhooks.length, 0); }
  finally { s.close(); }
});
