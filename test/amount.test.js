// "At stake" is the dispute's own dispute_amount; sandbox disputes are never opened with a default amount.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { createStore } from '../src/lib/store.js';
import { rulesEngine } from '../src/engine/recommend.js';
import { analyseDispute } from '../src/disputeService.js';
import { capture, dispute, fakeApi } from './fixtures.js';

const cap18 = { ...capture, id: '81V20330HJ8023806', amount: { currency_code: 'USD', value: '18.00' } };
const withCap = (api, c = cap18) => { api.getCapture = async () => c; return api; };

test('at stake = dispute_amount (USD 18.00), not a default or the fixture 5.50', async () => {
  const api = withCap(fakeApi({ d: dispute({ dispute_amount: { currency_code: 'USD', value: '18.00' } }) }));
  const a = await analyseDispute({ api, store: createStore(null), engine: rulesEngine }, 'PP-D-1');
  assert.deepEqual(a.amount, { currency_code: 'USD', value: '18.00' }); assert.equal(a.partialDispute, false);
});

test('a partial dispute (USD 5.50 on an USD 18.00 payment) is flagged with both amounts', async () => {
  const a = await analyseDispute({ api: withCap(fakeApi()), store: createStore(null), engine: rulesEngine }, 'PP-D-1');
  assert.equal(a.amount.value, '5.50'); assert.equal(a.paymentAmount.value, '18.00'); assert.equal(a.partialDispute, true);
});

test('sandbox dispute helper: amount comes from the capture, is required otherwise, and cannot exceed the capture', async () => {
  process.env.PROOFPILOT_ENABLE_SANDBOX_TOOLS = '1';
  const sent = []; const api = withCap(fakeApi()); api.createSandboxDispute = async (x) => { sent.push(x); return { dispute_id: 'PP-NEW' }; };
  const app = createApp({ api, store: createStore(null), engine: rulesEngine, config: { dryRun: false, writePasscode: 'pc', clientId: 'cid' } });
  const s = await new Promise(r => { const x = app.listen(0, () => r(x)); });
  const post = async (b) => { const r = await fetch(`http://127.0.0.1:${s.address().port}/api/sandbox/disputes`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-proofpilot-passcode': 'pc' }, body: JSON.stringify(b) }); return { status: r.status, body: await r.json() }; };
  try {
    const base = { buyerEmail: 'buyer@example.com', buyerTransactionId: 'BUY1' };
    assert.equal((await post(base)).body.error, 'AMOUNT_REQUIRED');
    assert.equal((await post({ ...base, captureId: cap18.id })).status, 201);
    assert.deepEqual(sent[0].amount, { currency_code: 'USD', value: '18.00' });
    assert.equal((await post({ ...base, captureId: cap18.id, amount: { currency_code: 'USD', value: '20.00' } })).body.error, 'BAD_AMOUNT');
    assert.equal(sent.length, 1);
  } finally { s.close(); delete process.env.PROOFPILOT_ENABLE_SANDBOX_TOOLS; }
});
