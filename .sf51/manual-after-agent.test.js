import { test } from 'node:test';
import fs from 'node:fs';
import { MockLanguageModelV2 } from 'ai/test';
import { z } from 'zod';
import { createApp } from '../src/app.js';
import { createStore } from '../src/lib/store.js';
import { rulesEngine } from '../src/engine/recommend.js';
import { fakeApi } from '../test/fixtures.js';
const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const model = () => { let i = 0; return new MockLanguageModelV2({ doGenerate: async () => (i++ % 2 === 0)
  ? { usage, warnings: [], finishReason: 'tool-calls', content: [{ type: 'tool-call', toolCallId: `c${i}`, toolName: 'create_refund', input: JSON.stringify({ amount: { value: '5.50', currency_code: 'USD' } }) }] }
  : { usage, warnings: [], finishReason: 'stop', content: [{ type: 'text', text: '{"action":"ACCEPT","rationale_facts":["capture:CAP123:amount"]}' }] } }); };
async function mk(fail) { const codes = {}; const api = fakeApi();
  const t = (n) => ({ description: n, parameters: z.object({}).passthrough(), execute: async () => { if (fail && n !== 'get_dispute') throw new Error('UNPROCESSABLE_ENTITY'); return { status: 'OK' }; } });
  const app = createApp({ api, store: createStore(null), engine: rulesEngine, config: { dryRun: false, writePasscode: 'pc' }, llm: { provider: 'gemini', model: 'mock', label: 'mock', languageModel: async () => model() }, agentTools: () => ({ get_dispute: t('get_dispute'), accept_dispute_claim: t('accept_dispute_claim'), create_refund: t('create_refund') }), approvalChannel: (c) => { codes[c.proposalId] = c.code; } });
  const s = await new Promise(r => { const x = app.listen(0, () => r(x)); }); const base = `http://127.0.0.1:${s.address().port}`;
  const req = async (m, p, b) => (await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json', 'x-proofpilot-passcode': 'pc' }, body: b ? JSON.stringify(b) : undefined })).json();
  return { s, req, codes, api }; }
test('manual after agent write', async () => { const o = {};
  for (const fail of [false, true]) { const X = await mk(fail); try {
    const p = (await X.req('POST', '/api/disputes/PP-D-1/ai', {})).agent.proposals[0];
    const a = await X.req('POST', `/api/agent/proposals/${p.id}/approve`, { approved: true, token: X.codes[p.id] });
    const m1 = await X.req('POST', '/api/disputes/PP-D-1/submit', { action: 'accept_claim', approved: true, confirm: 'APPROVE' });
    const m2 = await X.req('POST', '/api/disputes/PP-D-1/submit', { action: 'make_offer', approved: true, confirm: 'APPROVE', amount: { currency_code: 'USD', value: '1.00' } });
    o[fail ? 'after_rejected_agent_write' : 'after_executed_agent_write'] = { agent: a.error || a.proposal?.status, agent_msg: (a.message || '').slice(0, 160), manual_accept: m1.error || m1.status, manual_offer: m2.error || m2.status, paypal_calls: X.api.calls.map(c => c.name) };
  } finally { X.s.closeAllConnections?.(); X.s.close(); } }
  fs.writeFileSync('/tmp/sf5-manual.json', JSON.stringify(o, null, 1)); });
