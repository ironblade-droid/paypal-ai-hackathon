// PayPal Agent Toolkit agent: mocked model (AI SDK MockLanguageModelV1) and mocked toolkit tools. No network, no keys.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockLanguageModelV2 } from 'ai/test';
import { z } from 'zod';
import { guardTools, runAgent, READ_TOOLS, WRITE_TOOLS, TOOLKIT_VERSION } from '../src/ai/agent.js';
import { createApp } from '../src/app.js';
import { createStore } from '../src/lib/store.js';
import { rulesEngine } from '../src/engine/recommend.js';
import { makeRegistry, buildPack, validateClaims } from '../src/engine/evidence.js';
import { capture, order, tracker, dispute, fakeApi } from './fixtures.js';

const TR = `CAP123-${tracker.tracking_number}`;
function rawToolkit(calls) {
  const t = (name, result) => ({ description: `${name} tool`, parameters: z.object({ dispute_id: z.string().optional(), id: z.string().optional() }).passthrough(),
    execute: async (args) => { calls.push({ name, args }); return result; } });
  return {
    get_dispute: t('get_dispute', { dispute_id: 'PP-D-1', status: 'WAITING_FOR_SELLER_RESPONSE', buyer: { email: 'buyer@personal.example.com', name: 'Jane Buyer' }, note: 'contact buyer@personal.example.com' }),
    get_order: t('get_order', { id: 'ORD123', status: 'COMPLETED', purchase_units: [{ shipping: { name: { full_name: 'Jane Buyer' }, address: { address_line_1: '1 Main St' } } }] }),
    accept_dispute_claim: t('accept_dispute_claim', { status: 'ACCEPTED' }),
    create_refund: t('create_refund', { status: 'COMPLETED' }),
    create_invoice: t('create_invoice', { id: 'INV' }),
    send_invoice: t('send_invoice', {}),
  };
}
function ctx() {
  const d = dispute(); const r = makeRegistry(); r.add('dispute', 'PP-D-1', d); r.add('capture', 'CAP123', capture); r.add('order', 'ORD123', order); r.add('tracker', TR, tracker);
  const p = buildPack('PROOF_OF_FULFILLMENT', { dispute: d, capture, order, trackers: [tracker], registry: r }); p.validation = validateClaims(p.claims, r);
  const packs = { PROOF_OF_FULFILLMENT: p };
  return { dispute: d, allowedTypes: ['PROOF_OF_FULFILLMENT'], actions: ['provide_evidence', 'accept_claim'], registry: r, packs,
    rules: rulesEngine.recommend({ dispute: d, allowedTypes: ['PROOF_OF_FULFILLMENT'], packs }), rejectedTypes: [] };
}
const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
function scriptedModel(steps) {
  let i = 0;
  return new MockLanguageModelV2({ doGenerate: async () => {
    const s = steps[Math.min(i++, steps.length - 1)];
    if (s.calls) return { usage, warnings: [], finishReason: 'tool-calls', content: s.calls.map((c, k) => ({ type: 'tool-call', toolCallId: `c${i}-${k}`, toolName: c[0], input: JSON.stringify(c[1]) })) };
    return { usage, warnings: [], finishReason: 'stop', content: [{ type: 'text', text: s.text }] };
  } });
}
const FINAL = JSON.stringify({ action: 'FIGHT', evidence_type: 'PROOF_OF_FULFILLMENT', rationale_facts: ['dispute:PP-D-1:requested', `tracker:${TR}:shipped`],
  narrative_facts: ['capture:CAP123:amount', `tracker:${TR}:shipped`], narrative: ['The buyer admitted receiving it [dispute:PP-D-1].'], offer_amount: null });
const provider = (model) => ({ provider: 'gemini', model: 'mock-gemini', label: 'Mock Gemini (tests only)', languageModel: async () => model });

test('guardTools: allowlist only; reads wrapped and redacted; writes become proposals and never execute', async () => {
  const calls = []; const activity = []; const proposals = [];
  const { tools, held } = guardTools(rawToolkit(calls), { activity, proposals, disputeId: 'PP-D-1' });
  assert.ok(!('create_invoice' in tools) && !('send_invoice' in tools), 'non-allowlisted toolkit tools are dropped');
  assert.deepEqual(Object.keys(held).sort(), ['accept_dispute_claim', 'create_refund']);
  const r = await tools.get_dispute.execute({ dispute_id: 'PP-D-1' }, {});
  assert.equal(r.buyer.email, '[redacted]'); assert.equal(r.buyer.name, '[redacted]'); assert.equal(r.note, 'contact [email]');
  const w = await tools.accept_dispute_claim.execute({ dispute_id: 'PP-D-1' }, {});
  assert.equal(w.status, 'PROPOSED_NOT_EXECUTED');
  assert.deepEqual(calls.map(c => c.name), ['get_dispute'], 'the write tool was not executed');
  assert.equal(proposals[0].status, 'PENDING_SELLER_APPROVAL');
  assert.deepEqual(activity.map(a => a.kind), ['read', 'write-proposed']);
  assert.ok(!JSON.stringify(activity).includes('buyer@personal.example.com'));
  assert.ok(READ_TOOLS.includes('list_disputes') && WRITE_TOOLS.includes('create_shipment_tracking'));
});

test('agent loop (mocked Gemini): reads run, accept is only proposed, final draft goes through the checker', async () => {
  const calls = [];
  const model = scriptedModel([{ calls: [['get_dispute', { dispute_id: 'PP-D-1' }], ['get_order', { id: 'ORD123' }]] },
    { calls: [['accept_dispute_claim', { dispute_id: 'PP-D-1' }]] }, { text: FINAL }]);
  const out = await runAgent({ provider: provider(model), rawTools: rawToolkit(calls), ctx: ctx() });
  assert.equal(out.ok, true); assert.equal(out.mode, 'agent');
  assert.deepEqual(calls.map(c => c.name), ['get_dispute', 'get_order'], 'no write executed');
  assert.deepEqual(out.agent.activity.map(a => `${a.kind}:${a.tool}`), ['read:get_dispute', 'read:get_order', 'write-proposed:accept_dispute_claim']);
  assert.equal(out.agent.proposals[0].tool, 'accept_dispute_claim'); assert.equal(out.agent.proposals[0].status, 'PENDING_SELLER_APPROVAL');
  assert.match(out.agent.toolkit, new RegExp(`@paypal/agent-toolkit ${TOOLKIT_VERSION}`));
  assert.equal(out.recommendation.action, 'FIGHT'); assert.equal(out.recommendation.source, 'llm');
  assert.deepEqual(out.narrative.accepted.map(c => c.text), ['The buyer paid USD 5.50.', `Shipped with USPS, tracking ${tracker.tracking_number}, registered with PayPal (status SHIPPED) [sandbox test tracking number, no real parcel].`]);
  assert.equal(out.narrative.refused[0].reason, 'NOT_A_RECORDED_FACT');
  assert.ok(!JSON.stringify(out.agent).includes('Jane Buyer'));
});

test('agent: no final JSON -> rules fallback; model error -> honest failure; no key -> not available', async () => {
  const a = await runAgent({ provider: provider(scriptedModel([{ text: 'I think you should fight.' }])), rawTools: rawToolkit([]), ctx: ctx() });
  assert.equal(a.recommendation.source, 'rules-fallback'); assert.match(a.flags[0], /did not finish with the JSON/);
  const bad = new MockLanguageModelV2({ doGenerate: async () => { throw new Error('quota exceeded'); } });
  const b = await runAgent({ provider: provider(bad), rawTools: rawToolkit([]), ctx: ctx() });
  assert.equal(b.ok, false); assert.match(b.error, /quota exceeded/); assert.equal(b.fallback.action, ctx().rules.action);
  const c = await runAgent({ provider: null, rawTools: rawToolkit([]), ctx: ctx() });
  assert.equal(c.available, false);
});

test('agent proposals for an action PayPal does not offer, or a refused type, are blocked', async () => {
  const model = scriptedModel([{ calls: [['propose_make_offer', { dispute_id: 'PP-D-1', amount: '2.00' }], ['propose_provide_evidence', { dispute_id: 'PP-D-1', evidence_type: 'PROOF_OF_FULFILLMENT', narrative_fact_ids: [] }]] }, { text: FINAL }]);
  const c = ctx(); c.rejectedTypes = ['PROOF_OF_FULFILLMENT'];
  const out = await runAgent({ provider: provider(model), rawTools: rawToolkit([]), ctx: c });
  assert.deepEqual(out.agent.proposals.map(p => p.status), ['BLOCKED', 'BLOCKED']);
  assert.equal(out.recommendation.source, 'rules-fallback');
});

test('app: agent run is logged; a proposed write runs only after APPROVE (dry run sends nothing)', async () => {
  for (const dryRun of [true, false]) {
    const calls = []; const raw = rawToolkit(calls);
    const model = scriptedModel([{ calls: [['get_dispute', { dispute_id: 'PP-D-1' }], ['accept_dispute_claim', { dispute_id: 'PP-D-1' }]] }, { text: FINAL }]);
    const agentTools = () => raw;
    const app = createApp({ api: fakeApi(), store: createStore(null), engine: rulesEngine, config: { dryRun }, llm: provider(model), agentTools });
    const s = await new Promise(r => { const x = app.listen(0, () => r(x)); }); const base = `http://127.0.0.1:${s.address().port}`;
    const post = async (p, b) => (await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })).json();
    try {
      const cfg = await (await fetch(base + '/api/config')).json();
      assert.match(cfg.ai.agent.toolkit, /@paypal\/agent-toolkit/);
      const ai = await post('/api/disputes/PP-D-1/ai', {});
      assert.equal(ai.mode, 'agent', JSON.stringify(ai).slice(0, 400)); assert.equal(ai._held, undefined, 'held executes never leave the server');
      const runs = (await (await fetch(base + '/api/disputes/PP-D-1/agent')).json()).runs;
      assert.equal(runs[0].activity.length, 2);
      const pid = runs[0].proposals[0].id;
      assert.equal((await post(`/api/agent/proposals/${pid}/approve`, { approved: true, confirm: 'yes' })).error, 'NOT_APPROVED');
      assert.deepEqual(calls.map(c => c.name), ['get_dispute']);
      const ok = await post(`/api/agent/proposals/${pid}/approve`, { approved: true, confirm: 'APPROVE' });
      assert.equal(ok.dryRun, dryRun);
      assert.deepEqual(calls.map(c => c.name), dryRun ? ['get_dispute'] : ['get_dispute', 'accept_dispute_claim']);
      assert.equal((await post(`/api/agent/proposals/${pid}/approve`, { approved: true, confirm: 'APPROVE' })).error, 'NOT_PENDING');
    } finally { s.close(); }
  }
});
