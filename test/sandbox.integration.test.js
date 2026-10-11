// Live PayPal SANDBOX test. Runs only with PROOFPILOT_RUN_SANDBOX_TESTS=1 and the sandbox env vars.
// Read-only except creating one unapproved order (it expires unused).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPayPalClient } from '../src/paypal/client.js';
import { createApi } from '../src/paypal/api.js';
import { createStore } from '../src/lib/store.js';
import { rulesEngine } from '../src/engine/recommend.js';
import { analyseDispute } from '../src/disputeService.js';

const has = Boolean(process.env.PAYPAL_SANDBOX_CLIENT_ID && process.env.PAYPAL_SANDBOX_CLIENT_SECRET);
const DISPUTE = process.env.PROOFPILOT_TEST_DISPUTE_ID || 'PP-R-PGV-10190981';
// Opt-in only: `npm test` never calls the sandbox (it would create an order). Use `npm run test:sandbox`.
const optIn = process.env.PROOFPILOT_RUN_SANDBOX_TESTS === '1';
const skip = !optIn ? 'sandbox test is opt-in: run `npm run test:sandbox`' : has ? false : 'PayPal sandbox env vars not set';

test('sandbox: token, list disputes, analyse known dispute, create order', { skip, timeout: 60000 }, async () => {
  const client = createPayPalClient({ clientId: process.env.PAYPAL_SANDBOX_CLIENT_ID, clientSecret: process.env.PAYPAL_SANDBOX_CLIENT_SECRET });
  const api = createApi(client);
  await client.getToken();
  assert.ok(client.scopes().some(s => s.includes('disputes')), 'token carries a disputes scope');
  const list = await api.listDisputes(10);
  assert.ok(Array.isArray(list.items));
  const a = await analyseDispute({ api, store: createStore(null), engine: rulesEngine }, DISPUTE);
  assert.equal(a.id, DISPUTE);
  assert.ok(a.records.some(r => r.type === 'capture'), 'capture record fetched');
  assert.ok(a.records.some(r => r.type === 'order'), 'order record fetched');
  if (a.paypalStatus === 'UNDER_REVIEW') { assert.equal(a.status.label, 'Under PayPal review'); assert.equal(a.recommendation.action, 'WAIT'); }
  for (const p of Object.values(a.packs)) assert.ok(p.validation.accepted.every(c => c.refs.length));
  const o = await api.createOrder({ items: [{ name: 'Integration test item', sku: 'IT-1', quantity: '1', unit_amount: { currency_code: 'USD', value: '1.00' } }], invoiceId: 'pp-it-' + Date.now() });
  assert.ok(['CREATED', 'PAYER_ACTION_REQUIRED'].includes(o.status), o.status);
  assert.ok((o.links || []).some(l => ['approve', 'payer-action'].includes(l.rel)), 'buyer approval link returned');
  console.log(JSON.stringify({ dispute: a.id, status: a.paypalStatus, label: a.status.label, stage: a.stage, allowedTypes: a.allowedTypes,
    actions: a.status.actions, recommendation: a.recommendation.action, records: a.records.map(r => `${r.type}:${r.id}`), gaps: a.gaps.map(g => g.code), newOrder: o.id }));
});
