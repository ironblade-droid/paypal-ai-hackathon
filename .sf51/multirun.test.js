import { test } from 'node:test';
import fs from 'node:fs';
import { MockLanguageModelV2 } from 'ai/test';
import { z } from 'zod';
import { createApp } from '../src/app.js';
import { createStore } from '../src/lib/store.js';
import { rulesEngine } from '../src/engine/recommend.js';
import { fakeApi, order, dispute } from '../test/fixtures.js';
const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const R = (v) => ['create_refund', { amount: { value: v, currency_code: 'USD' } }]; const ACC = ['accept_dispute_claim', { dispute_id: 'PP-D-1' }];
function scripted(plan) { let i = 0; return new MockLanguageModelV2({ doGenerate: async () => { const k = i++; const step = plan[Math.floor(k / 2) % plan.length];
  if (k % 2 === 0) return { usage, warnings: [], finishReason: 'tool-calls', content: [{ type: 'tool-call', toolCallId: `c${k}`, toolName: step[0], input: JSON.stringify({ ...step[1], ...(step[0] === 'accept_dispute_claim' ? {} : {}) }) }] };
  return { usage, warnings: [], finishReason: 'stop', content: [{ type: 'text', text: '{"action":"ACCEPT","rationale_facts":["capture:CAP123:amount"]}' }] }; } }); }
async function mk(plan, { api = fakeApi(), failExec = false } = {}) {
  const calls = []; const codes = {};
  const t = (n) => ({ description: n, parameters: z.object({}).passthrough(), execute: async (a) => { calls.push({ n, a }); if (failExec && n !== 'get_dispute') throw new Error('UNPROCESSABLE_ENTITY'); return { status: 'OK' }; } });
  const raw = { get_dispute: t('get_dispute'), accept_dispute_claim: t('accept_dispute_claim'), create_refund: t('create_refund') };
  const store = createStore(null);
  const app = createApp({ api, store, engine: rulesEngine, config: { dryRun: false, writePasscode: 'pc' }, llm: { provider: 'gemini', model: 'mock', label: 'mock', languageModel: async () => scripted(plan) }, agentTools: () => raw, approvalChannel: (c) => { codes[c.proposalId] = c.code; } });
  const s = await new Promise(r => { const x = app.listen(0, () => r(x)); }); const base = `http://127.0.0.1:${s.address().port}`;
  const req = async (m, p, b) => (await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json', 'x-proofpilot-passcode': 'pc' }, body: b ? JSON.stringify(b) : undefined })).json();
  const run = async (id = 'PP-D-1') => { const ai = await req('POST', `/api/disputes/${id}/ai`, {}); const p = ai.agent?.proposals?.[0]; return p ? { id: p.id, tool: p.tool, status: p.status, why: p.blockedReasons } : { none: ai.error || ai.source || Object.keys(ai) }; };
  const approve = async (p) => { const r = await req('POST', `/api/agent/proposals/${p.id}/approve`, { approved: true, token: codes[p.id] }); return r.error || r.proposal?.status; };
  const close = () => { s.closeAllConnections?.(); s.close(); };
  return { run, approve, req, calls, store, close };
}
const sum = (x) => `${x.tool}:${x.status}${x.why ? ':' + x.why.join('+') : ''}`;
test('v0.5 multirun', async () => {
  const o = {};
  // S1: v0.4 sequence refund, refund, accept with approval between runs
  { const X = await mk([R('5.50'), R('5.50'), ACC]); try { const seq = [];
    for (let k = 0; k < 3; k++) { const p = await X.run(); seq.push(sum(p) + (p.status === 'PENDING_SELLER_APPROVAL' ? ' -> ' + await X.approve(p) : '')); }
    o.S1_v04_rerun = seq; o.S1_executions = X.calls.filter(c => c.n !== 'get_dispute').length; } finally { X.close(); } }
  // S2: write executed, then PayPal moves the dispute to CHARGEBACK with a different reason, manual paths too
  { const api = fakeApi(); let over = null; const og = api.getDispute; api.getDispute = async (...a) => ({ ...(await og(...a)), ...(over || {}) });
    const X = await mk([R('2.00'), R('2.00'), ACC], { api }); try { const p1 = await X.run(); const a1 = await X.approve(p1);
    over = { dispute_life_cycle_stage: 'CHARGEBACK', reason: 'UNAUTHORISED', status: 'WAITING_FOR_SELLER_RESPONSE', update_time: '2026-10-12T00:00:00Z' };
    const p2 = await X.run(); const p3 = await X.run();
    const man = await X.req('POST', '/api/disputes/PP-D-1/submit', { action: 'accept_claim' });
    o.S2_stage_change = { first: sum(p1) + ' -> ' + a1, after_stage_change: [sum(p2), sum(p3)], manual_accept: man.error || man.status || man, executions: X.calls.filter(c => c.n !== 'get_dispute').length }; } finally { X.close(); } }
  // S3/S4: PayPal-reported refunds on the order (partial COMPLETED, PENDING not matching the hold)
  for (const [name, refunds, amt] of [['S3_partial_completed_2.00_then_5.50', [{ id: 'RF1', status: 'COMPLETED', amount: { currency_code: 'USD', value: '2.00' }, create_time: '2026-10-11T09:30:00Z' }], '5.50'],
      ['S3b_partial_completed_2.00_then_3.50', [{ id: 'RF1', status: 'COMPLETED', amount: { currency_code: 'USD', value: '2.00' }, create_time: '2026-10-11T09:30:00Z' }], '3.50'],
      ['S4_pending_5.50_then_5.50', [{ id: 'RF2', status: 'PENDING', amount: { currency_code: 'USD', value: '5.50' }, create_time: '2026-10-11T09:40:00Z' }], '5.50'],
      ['S4b_pending_5.50_then_accept', [{ id: 'RF2', status: 'PENDING', amount: { currency_code: 'USD', value: '5.50' }, create_time: '2026-10-11T09:40:00Z' }], null]]) {
    const api = fakeApi(); const od = JSON.parse(JSON.stringify(order)); od.purchase_units[0].payments.refunds = refunds; api.getOrder = async () => od;
    const X = await mk([amt ? R(amt) : ACC], { api }); try { const p = await X.run(); o[name] = sum(p) + (p.status === 'PENDING_SELLER_APPROVAL' ? ' -> ' + await X.approve(p) : ''); } finally { X.close(); } }
  // S5: second dispute id on the same capture after an agent refund of 5.50 on PP-D-1 (PayPal not yet reporting the refund)
  { const api = fakeApi(); const d2 = dispute({ dispute_id: 'PP-D-2', create_time: '2026-10-11T11:00:00Z' }); const og = api.getDispute; api.getDispute = async (id) => id === 'PP-D-2' ? d2 : og(id);
    const X = await mk([R('5.50')], { api }); try { const p1 = await X.run(); const a1 = await X.approve(p1); const p2 = await X.run('PP-D-2'); o.S5_second_dispute_same_capture = { d1: sum(p1) + ' -> ' + a1, d2: sum(p2) + (p2.status === 'PENDING_SELLER_APPROVAL' ? ' -> ' + await X.approve(p2) : ''), executions: X.calls.filter(c => c.n !== 'get_dispute').map(c => c.n + ' ' + (c.a.amount?.value || '') + ' ' + (c.a.capture_id || c.a.dispute_id)) }; } finally { X.close(); } }
  // S6: PayPal rejects the approved write on the agent path; is the dispute locked afterwards?
  { const X = await mk([R('5.50'), R('5.50')], { failExec: true }); try { const p1 = await X.run(); const a1 = await X.approve(p1); const p2 = await X.run();
    o.S6_rejected_write = { first: sum(p1) + ' -> ' + a1, next_run: sum(p2), ledger: X.store.data.disputeWrites?.['PP-D-1'] }; } finally { X.close(); } }
  fs.writeFileSync('/tmp/sf5-multi.json', JSON.stringify(o, null, 1));
});
