// Proposal binding, approval codes and Star Fisheries' $999 cross-payment probe (v0.3 review), as asserting tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockLanguageModelV2 } from 'ai/test';
import { z } from 'zod';
import { createApp } from '../src/app.js';
import { createStore } from '../src/lib/store.js';
import { rulesEngine } from '../src/engine/recommend.js';
import { makeRegistry } from '../src/engine/evidence.js';
import { bindProposal, proposalHash, TEMPLATES } from '../src/ai/proposals.js';
import { parseAmount } from '../src/lib/money.js';
import { capture, order, dispute, fakeApi, links } from './fixtures.js';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
function scripted(steps) { let i = 0; return new MockLanguageModelV2({ doGenerate: async () => { const s = steps[Math.min(i++, steps.length - 1)];
  if (s.calls) return { usage, warnings: [], finishReason: 'tool-calls', content: s.calls.map((c, k) => ({ type: 'tool-call', toolCallId: `c${i}-${k}`, toolName: c[0], input: JSON.stringify(c[1]) })) };
  return { usage, warnings: [], finishReason: 'stop', content: [{ type: 'text', text: s.text }] }; } }); }
function toolkit(calls) { const t = (n) => ({ description: n, parameters: z.object({}).passthrough(), execute: async (a) => { calls.push({ n, a }); return { status: 'OK' }; } });
  return { get_dispute: t('get_dispute'), create_refund: t('create_refund'), accept_dispute_claim: t('accept_dispute_claim'), create_shipment_tracking: t('create_shipment_tracking'), pay_order: t('pay_order'), create_invoice: t('create_invoice') }; }
async function server({ steps, api = fakeApi(), config = { dryRun: false, writePasscode: 'pc' } }) {
  const calls = []; const raw = toolkit(calls);
  const app = createApp({ api, store: createStore(null), engine: rulesEngine, config, llm: { provider: 'gemini', model: 'mock', label: 'mock', languageModel: async () => scripted(steps) }, agentTools: () => raw });
  const s = await new Promise(r => { const x = app.listen(0, () => r(x)); }); const base = `http://127.0.0.1:${s.address().port}`;
  const req = async (m, p, b, pc) => { const r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json', ...(pc ? { 'x-proofpilot-passcode': pc } : {}) }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, body: await r.json() }; };
  return { s, req, calls };
}
const ACCEPT = '{"action":"ACCEPT","rationale_facts":["capture:CAP123:amount"]}';
const ctx = (over = {}) => { const r = makeRegistry(); r.add('dispute', 'PP-D-1', dispute()); r.add('capture', 'CAP123', capture); r.add('order', 'ORD123', order);
  return { dispute: dispute(), actions: ['provide_evidence', 'accept_claim', 'make_offer'], allowedTypes: ['PROOF_OF_FULFILLMENT'], rejectedTypes: [], registry: r, final: { action: 'ACCEPT' }, ...over }; };

test("Star Fisheries $999 cross-payment probe: blocked at record time, never approvable, never executed", async () => {
  const { s, req, calls } = await server({ steps: [{ calls: [['create_refund', { capture_id: 'FOREIGN-CAPTURE-9', amount: { value: '999.00', currency_code: 'USD' }, note_to_payer: 'model free text to buyer' }]] },
    { text: '{"action":"WAIT","rationale_facts":["capture:CAP123:amount"]}' }] });
  try {
    assert.equal((await req('POST', '/api/disputes/PP-D-1/ai', {})).status, 401, 'AI run needs the passcode');
    const ai = await req('POST', '/api/disputes/PP-D-1/ai', {}, 'pc');
    const p = ai.body.agent.proposals[0];
    assert.equal(p.status, 'BLOCKED');
    for (const r of ['WAIT_MEANS_NO_ACTION', 'DIFFERENT_CAPTURE', 'AMOUNT_ABOVE_DISPUTED']) assert.ok(p.blockedReasons.includes(r), r);
    assert.equal(p.canonical.capture_id, 'CAP123', 'bound to the dispute\'s own payment'); assert.equal(p.canonical.amount.value, null);
    assert.equal(p.canonical.note_to_payer, TEMPLATES.refundNote('PP-D-1'));
    assert.equal((await req('GET', '/api/disputes/PP-D-1/agent')).status, 401, 'agent runs need the passcode');
    const runs = await req('GET', '/api/disputes/PP-D-1/agent', null, 'pc');
    const dump = JSON.stringify(runs.body);
    for (const bad of ['model free text to buyer', 'FOREIGN-CAPTURE-9', '999.00']) assert.ok(!dump.includes(bad), `${bad} is not stored or shown`);
    assert.equal(runs.body.runs[0].proposals[0].approvalCode, undefined, 'no approval code for a blocked proposal');
    assert.equal((await req('POST', `/api/agent/proposals/${p.id}/approve`, { approved: true, confirm: 'APPROVE' })).status, 401);
    const a = await req('POST', `/api/agent/proposals/${p.id}/approve`, { approved: true, confirm: 'APPROVE', token: 'APPROVE' }, 'pc');
    assert.equal(a.body.error, 'NOT_PENDING');
    assert.equal((await req('POST', '/api/agent/proposals/nope/approve', { approved: true }, 'pc')).body.error, 'UNKNOWN_PROPOSAL');
    assert.equal((await req('POST', `/api/agent/proposals/${p.id}/dismiss`, {})).status, 401);
    assert.deepEqual(calls, [], 'no toolkit write ran');
  } finally { s.close(); }
});

test('refund proposal is bound: own capture, template note, at most the disputed amount; one executable proposal per run', async () => {
  const { s, req, calls } = await server({ steps: [{ calls: [['create_refund', { capture_id: 'CAP123', amount: { value: '2.00', currency_code: 'USD' }, note_to_payer: 'email me at x@y.z' }],
    ['accept_dispute_claim', { dispute_id: 'PP-D-1', note: 'x' }]] }, { text: ACCEPT }] });
  try {
    await req('POST', '/api/disputes/PP-D-1/ai', {}, 'pc');
    const [p, q] = (await req('GET', '/api/disputes/PP-D-1/agent', null, 'pc')).body.runs[0].proposals;
    assert.equal(p.status, 'PENDING_SELLER_APPROVAL');
    assert.deepEqual(p.canonical, { capture_id: 'CAP123', amount: { currency_code: 'USD', value: '2.00' }, note_to_payer: TEMPLATES.refundNote('PP-D-1') });
    assert.equal(q.status, 'BLOCKED'); assert.deepEqual(q.blockedReasons, ['ONE_PROPOSAL_PER_RUN']);
    const r = await req('POST', `/api/agent/proposals/${p.id}/approve`, { approved: true, token: p.approvalCode }, 'pc');
    assert.equal(r.body.dryRun, false, JSON.stringify(r.body));
    assert.deepEqual(calls, [{ n: 'create_refund', a: p.canonical }]);
  } finally { s.close(); }
});

test('approval re-checks fresh PayPal data: a changed dispute blocks the run and consumes the code', async () => {
  const api = fakeApi(); let changed = false; const orig = api.getDispute;
  api.getDispute = async () => changed ? { ...(await orig()), links: links('provide_evidence') } : orig();
  const { s, req, calls } = await server({ api, steps: [{ calls: [['accept_dispute_claim', { dispute_id: 'PP-D-1' }]] }, { text: ACCEPT }] });
  try {
    await req('POST', '/api/disputes/PP-D-1/ai', {}, 'pc');
    const p = (await req('GET', '/api/disputes/PP-D-1/agent', null, 'pc')).body.runs[0].proposals[0];
    assert.equal(p.status, 'PENDING_SELLER_APPROVAL');
    changed = true; // PayPal no longer offers accept_claim
    const r = await req('POST', `/api/agent/proposals/${p.id}/approve`, { approved: true, token: p.approvalCode }, 'pc');
    assert.equal(r.body.error, 'STALE_PROPOSAL'); assert.ok(r.body.reasons.includes('ACTION_NOT_OFFERED'));
    assert.equal((await req('POST', `/api/agent/proposals/${p.id}/approve`, { approved: true, token: p.approvalCode }, 'pc')).body.error, 'NOT_PENDING');
    assert.deepEqual(calls, []);
  } finally { s.close(); }
  // Amount change also invalidates (hash includes the disputed amount).
  const api2 = fakeApi(); let ch2 = false; const o2 = api2.getDispute;
  api2.getDispute = async () => ch2 ? { ...(await o2()), dispute_amount: { currency_code: 'USD', value: '4.00' } } : o2();
  const b = await server({ api: api2, steps: [{ calls: [['accept_dispute_claim', {}]] }, { text: ACCEPT }] });
  try {
    await b.req('POST', '/api/disputes/PP-D-1/ai', {}, 'pc');
    const p = (await b.req('GET', '/api/disputes/PP-D-1/agent', null, 'pc')).body.runs[0].proposals[0];
    ch2 = true;
    const r = await b.req('POST', `/api/agent/proposals/${p.id}/approve`, { approved: true, token: p.approvalCode }, 'pc');
    assert.equal(r.body.error, 'STALE_PROPOSAL'); assert.deepEqual(r.body.reasons, ['PAYPAL_DATA_CHANGED']); assert.deepEqual(b.calls, []);
  } finally { b.s.close(); }
});

test('five wrong approval codes void the proposal', async () => {
  const { s, req, calls } = await server({ steps: [{ calls: [['accept_dispute_claim', {}]] }, { text: ACCEPT }] });
  try {
    await req('POST', '/api/disputes/PP-D-1/ai', {}, 'pc');
    const p = (await req('GET', '/api/disputes/PP-D-1/agent', null, 'pc')).body.runs[0].proposals[0];
    for (let i = 0; i < 5; i++) assert.equal((await req('POST', `/api/agent/proposals/${p.id}/approve`, { approved: true, token: `APPROVE-WRONG-${i}` }, 'pc')).body.error, 'BAD_TOKEN');
    assert.equal((await req('POST', `/api/agent/proposals/${p.id}/approve`, { approved: true, token: p.approvalCode }, 'pc')).body.error, 'NOT_PENDING');
    assert.deepEqual(calls, []);
  } finally { s.close(); }
});

test('bindProposal: recommendation, dispute, payment, order, amount and currency are all bound', () => {
  assert.deepEqual(bindProposal('accept_dispute_claim', {}, ctx({ final: { action: 'WAIT' } })).reasons, ['WAIT_MEANS_NO_ACTION']);
  assert.deepEqual(bindProposal('accept_dispute_claim', {}, ctx({ final: { action: 'FIGHT' } })).reasons, ['ACTION_INCONSISTENT_WITH_RECOMMENDATION']);
  assert.deepEqual(bindProposal('accept_dispute_claim', { dispute_id: 'PP-D-2' }, ctx()).reasons, ['DIFFERENT_DISPUTE']);
  assert.deepEqual(bindProposal('accept_dispute_claim', {}, ctx({ actions: ['provide_evidence'] })).reasons, ['ACTION_NOT_OFFERED']);
  assert.deepEqual(bindProposal('accept_dispute_claim', {}, ctx({ dispute: dispute({ status: 'RESOLVED' }) })).reasons, ['DISPUTE_CLOSED']);
  const refund = (amount) => bindProposal('create_refund', { capture_id: 'CAP123', amount }, ctx()).reasons;
  assert.deepEqual(refund({ value: '5.50', currency_code: 'USD' }), []);
  assert.deepEqual(refund({ value: '5.51', currency_code: 'USD' }), ['AMOUNT_ABOVE_DISPUTED']);
  assert.deepEqual(refund({ value: '5.00', currency_code: 'EUR' }), ['CURRENCY_MISMATCH']);
  for (const v of ['1e-9', '0x5', '5.5e0', '-1', 'Infinity', ' ', '5.499']) assert.deepEqual(refund({ value: v, currency_code: 'USD' }), ['AMOUNT_NOT_A_PLAIN_DECIMAL'], v);
  assert.deepEqual(refund({ value: '0.00', currency_code: 'USD' }), ['AMOUNT_BELOW_0_01']);
  assert.deepEqual(bindProposal('create_refund', { capture_id: 'OTHER-CAPTURE-12345' }, ctx()).reasons, ['DIFFERENT_CAPTURE']);
  assert.ok(bindProposal('create_shipment_tracking', { order_id: 'ORD999', transaction_id: 'CAP123', tracking_number: '1' }, ctx({ final: { action: 'FIGHT' } })).reasons.includes('LATE_TRACKING_NOT_PROOF'));
  assert.ok(bindProposal('create_shipment_tracking', { order_id: 'ORD999' }, ctx()).reasons.includes('DIFFERENT_ORDER'));
  assert.deepEqual(bindProposal('propose_make_offer', { amount: '0.01' }, ctx({ final: { action: 'OFFER' } })).reasons, []);
  assert.deepEqual(bindProposal('propose_make_offer', { amount: '1e-9' }, ctx({ final: { action: 'OFFER' } })).reasons, ['AMOUNT_NOT_A_PLAIN_DECIMAL']);
  assert.deepEqual(bindProposal('propose_provide_evidence', { evidence_type: 'PROOF_OF_FULFILLMENT' }, ctx({ final: { action: 'FIGHT' }, rejectedTypes: ['PROOF_OF_FULFILLMENT'] })).reasons, ['TYPE_REFUSED_BY_PAYPAL']);
  assert.deepEqual(bindProposal('pay_order', {}, ctx()).reasons, ['TOOL_NOT_PROPOSABLE']);
  // Same inputs, same hash; a changed amount changes the hash.
  const b1 = bindProposal('accept_dispute_claim', {}, ctx()); const b2 = bindProposal('accept_dispute_claim', {}, ctx({ dispute: dispute({ dispute_amount: { currency_code: 'USD', value: '4.00' } }) }));
  assert.notEqual(proposalHash({ id: 'x', disputeId: 'PP-D-1', tool: 'accept_dispute_claim', ...b1 }), proposalHash({ id: 'x', disputeId: 'PP-D-1', tool: 'accept_dispute_claim', ...b2 }));
});

test('strict amounts everywhere: seller offers via submit also reject 1e-9, 0x5 and 0.00', async () => {
  const api = fakeApi({ d: dispute({ links: links('make_offer', 'accept_claim') }) });
  const app = createApp({ api, store: createStore(null), engine: rulesEngine, config: { dryRun: true } });
  const s = await new Promise(r => { const x = app.listen(0, () => r(x)); }); const base = `http://127.0.0.1:${s.address().port}`;
  const post = async (b) => (await fetch(base + '/api/disputes/PP-D-1/submit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'make_offer', approved: true, confirm: 'APPROVE', ...b }) })).json();
  try {
    for (const v of ['1e-9', '0x5', '0.00', '5.51', '5.5e0']) assert.equal((await post({ offerAmount: v })).error, 'BAD_OFFER', v);
    assert.equal((await post({ offerAmount: '5', offerCurrency: 'EUR' })).error, 'BAD_OFFER');
    const ok = await post({ offerAmount: '0.01', note: 'model or seller free text' });
    assert.deepEqual(ok.payloadPreview, { note: TEMPLATES.offerNote('PP-D-1'), amount: { currency_code: 'USD', value: '0.01' } });
  } finally { s.close(); }
  assert.equal(parseAmount('5.5').value, '5.50'); assert.equal(parseAmount('0x5'), null); assert.equal(parseAmount('1e-9'), null);
});
