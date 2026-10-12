// v0.5.2: successful PayPal writes keep HTTP status + paypal-debug-id; manual offer box never pre-fills the full amount.
// Fake fetch and fake PayPal API only: no network, no keys.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createApp } from '../src/app.js';
import { createStore } from '../src/lib/store.js';
import { rulesEngine } from '../src/engine/recommend.js';
import { createPayPalClient, paypalMeta } from '../src/paypal/client.js';
import { createApi } from '../src/paypal/api.js';
import { dispute, fakeApi, links } from './fixtures.js';

function fakeFetch(seen = []) {
  return async (url, init) => {
    seen.push({ url: String(url), method: init?.method });
    if (String(url).endsWith('/v1/oauth2/token')) return new Response(JSON.stringify({ access_token: 'tok-test-abcdef', expires_in: 3600, scope: 'x' }), { status: 200 });
    return new Response(JSON.stringify({ links: [{ rel: 'self', href: 'x' }] }), { status: 201, headers: { 'paypal-debug-id': 'dbg-ok-123' } });
  };
}

test('client: successful call exposes HTTP status and paypal-debug-id without changing the JSON body', async () => {
  const c = createPayPalClient({ clientId: 'id', clientSecret: 'secret-test-value', fetchImpl: fakeFetch() });
  const r = await c.post('/v1/customer/disputes/D/make-offer', {});
  assert.deepEqual(paypalMeta(r), { status: 201, debugId: 'dbg-ok-123' });
  assert.equal(JSON.stringify(r), JSON.stringify({ links: [{ rel: 'self', href: 'x' }] }));
  assert.deepEqual(paypalMeta(null), { status: null, debugId: null });
});

async function startWith(writeName) {
  const real = createApi(createPayPalClient({ clientId: 'id', clientSecret: 'secret-test-value', fetchImpl: fakeFetch() }));
  const api = { ...fakeApi({ d: dispute({ links: links('provide_evidence', 'make_offer', 'accept_claim') }) }), [writeName]: real[writeName] };
  const store = createStore(null);
  const app = createApp({ api, store, engine: rulesEngine, config: { dryRun: false, writePasscode: 'pc' } });
  const s = await new Promise(r => { const x = app.listen(0, () => r(x)); }); const base = `http://127.0.0.1:${s.address().port}`;
  const req = async (m, p, b) => { const r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json', 'x-proofpilot-passcode': 'pc' }, body: b ? JSON.stringify(b) : undefined });
    return { status: r.status, body: JSON.parse(await r.text()) }; };
  return { s, req, store };
}

for (const [action, fn, extra] of [['make_offer', 'makeOffer', { offerAmount: '2.75' }], ['accept_claim', 'acceptClaim', {}]]) {
  test(`manual ${action}: write record, audit entry, response and agent API carry status + debug id`, async () => {
    const { s, req, store } = await startWith(fn);
    try {
      const r = await req('POST', '/api/disputes/PP-D-1/submit', { action, approved: true, confirm: 'APPROVE', ...extra });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(r.body.paypal, { status: 201, debugId: 'dbg-ok-123' });
      const w = store.data.disputeWrites['PP-D-1'].at(-1);
      assert.equal(w.httpStatus, 201); assert.equal(w.debugId, 'dbg-ok-123');
      const a = store.data.audit.find(x => x.type === 'SUBMIT');
      assert.equal(a.httpStatus, 201); assert.equal(a.debugId, 'dbg-ok-123');
      const ag = await req('GET', '/api/disputes/PP-D-1/agent');
      assert.equal(ag.body.writes.at(-1).debugId, 'dbg-ok-123');
    } finally { s.close(); }
  });
}

test('UI shows the success debug id', () => {
  const html = fs.readFileSync(new URL('../public/dispute.html', import.meta.url), 'utf8');
  assert.match(html, /r\.paypal\?\.debugId/);
  assert.match(html, /p\.paypal\?\.debugId/);
  assert.match(html, /w\.debugId/);
});

function loadPP() { const ctx = { window: {}, sessionStorage: { getItem: () => null } }; vm.runInNewContext(fs.readFileSync(new URL('../public/common.js', import.meta.url), 'utf8'), ctx); return ctx.window.PP; }

test('offer box default: pending/most recent proposal amount, else AI suggestion, else empty, never the full disputed amount', () => {
  const PP = loadPP(); const full = { value: '18.00', currency_code: 'USD' };
  const offer = (value, status, createdAt) => ({ tool: 'propose_make_offer', status, createdAt, canonical: { amount: { value, currency_code: 'USD' } } });
  assert.equal(PP.defaultOfferAmount(full, []), '');
  assert.equal(PP.defaultOfferAmount(full, [], '18.00'), '');
  assert.equal(PP.defaultOfferAmount(full, [], '9.00'), '9.00');
  assert.equal(PP.defaultOfferAmount(full, [offer('7.00', 'EXECUTED_AFTER_APPROVAL', '2026-10-12T10:00:00Z'), offer('9.00', 'PENDING_SELLER_APPROVAL', '2026-10-12T09:00:00Z')]), '9.00');
  assert.equal(PP.defaultOfferAmount(full, [offer('6.00', 'EXPIRED', '2026-10-12T09:00:00Z'), offer('9.00', 'EXPIRED', '2026-10-12T11:00:00Z')]), '9.00');
  assert.equal(PP.defaultOfferAmount(full, [offer('18.00', 'PENDING_SELLER_APPROVAL')]), '');
  assert.equal(PP.defaultOfferAmount(full, [offer('18', 'PENDING_SELLER_APPROVAL')], '18.0'), '');
  const html = fs.readFileSync(new URL('../public/dispute.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /id="offerAmt"[^>]*(placeholder|value)="\$\{PP\.esc\(A\.amount\.value\)\}"/);
  assert.match(html, /id="offerAmt"[^>]*PP\.defaultOfferAmount\(/);
});
