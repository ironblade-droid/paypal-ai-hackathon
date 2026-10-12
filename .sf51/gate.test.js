// Star Fisheries v0.5 gate probes (scratch copy only). Records to /tmp/sf5-gate.json.
import { test } from 'node:test';
import fs from 'node:fs';
import { MockLanguageModelV2 } from 'ai/test';
import { z } from 'zod';
import { createApp } from '../src/app.js';
import { createStore } from '../src/lib/store.js';
import { rulesEngine } from '../src/engine/recommend.js';
import { fakeApi } from '../test/fixtures.js';
const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const cyc = (tool = 'accept_dispute_claim', args = { dispute_id: 'PP-D-1' }) => { let i = 0; return new MockLanguageModelV2({ doGenerate: async () => { const k = i++ % 2;
  if (k === 0) return { usage, warnings: [], finishReason: 'tool-calls', content: [{ type: 'tool-call', toolCallId: `c${i}`, toolName: tool, input: JSON.stringify(args) }] };
  return { usage, warnings: [], finishReason: 'stop', content: [{ type: 'text', text: '{"action":"ACCEPT","rationale_facts":["capture:CAP123:amount"]}' }] }; } }); };
async function mk({ api = fakeApi(), model = cyc() } = {}) {
  const calls = []; const codes = {}; const t = (n) => ({ description: n, parameters: z.object({}).passthrough(), execute: async (a) => { calls.push({ n, a }); await new Promise(r => setTimeout(r, 50)); return { status: 'OK' }; } });
  const raw = { get_dispute: t('get_dispute'), accept_dispute_claim: t('accept_dispute_claim'), create_refund: t('create_refund') };
  const store = createStore(null);
  const app = createApp({ api, store, engine: rulesEngine, config: { dryRun: false, writePasscode: 'pc' }, llm: { provider: 'gemini', model: 'mock', label: 'mock', languageModel: async () => model }, agentTools: () => raw,
    approvalChannel: (c) => { codes[c.proposalId] = c.code; } });
  const s = await new Promise(r => { const x = app.listen(0, () => r(x)); }); const base = `http://127.0.0.1:${s.address().port}`;
  const raws = [];
  const req = async (m, p, b, h = {}) => { const r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json', 'x-proofpilot-passcode': 'pc', ...h }, body: b ? JSON.stringify(b) : undefined }); const txt = await r.text(); raws.push(txt); return { status: r.status, body: JSON.parse(txt) }; };
  return { s, req, calls, codes, store, raws };
}
const codeRe = /APPROVE-[A-Z2-9]{5}-[A-Z2-9]{5}/;
test('v0.5 gate probes', async () => {
  const o = {};
  const X = await mk();
  try {
    const run = async () => (await X.req('POST', '/api/disputes/PP-D-1/ai', {})).body;
    const pid = (ai) => ai.agent?.proposals?.[0];
    const a1 = await run(); const A = pid(a1); const a2 = await run(); const B = pid(a2);
    o.run1 = A.status; o.run2 = [B.status, B.blockedReasons];
    const agentGet = await X.req('GET', '/api/disputes/PP-D-1/agent');
    o.http_contains_code = X.raws.some(t => codeRe.test(t) || Object.values(X.codes).some(c => t.includes(c)));
    o.http_contains_digest = X.raws.some(t => t.includes('tokenDigest'));
    o.store_contains_code = Object.values(X.codes).some(c => JSON.stringify(X.store.data).includes(c));
    o.store_contains_digest = JSON.stringify(X.store.data).includes('tokenDigest');
    o.agent_liveCode_flag = agentGet.body.runs.map(r => r.proposals[0]?.liveCode);
    await X.req('POST', `/api/agent/proposals/${A.id}/dismiss`, {});
    const C = pid(await run()); o.run3_after_dismiss = C.status;
    o.cross_code = (await X.req('POST', `/api/agent/proposals/${C.id}/approve`, { approved: true, token: X.codes[A.id] })).body.error;
    o.brute = [];
    for (let i = 0; i < 5; i++) o.brute.push((await X.req('POST', `/api/agent/proposals/${C.id}/approve`, { approved: true, token: `APPROVE-AAAAA-AAAA${i}` }, { 'x-forwarded-for': `10.0.0.${i}` })).body.error);
    o.C_correct_after_lockout = (await X.req('POST', `/api/agent/proposals/${C.id}/approve`, { approved: true, token: X.codes[C.id] })).body.error;
    const D = pid(await run()); o.run4 = D.status;
    const race = await Promise.all([1, 2, 3].map(() => X.req('POST', `/api/agent/proposals/${D.id}/approve`, { approved: true, token: X.codes[D.id] })));
    o.race = race.map(r => r.body.error || r.body.proposal?.status); o.race_executions = X.calls.length;
    o.replay = (await X.req('POST', `/api/agent/proposals/${D.id}/approve`, { approved: true, token: X.codes[D.id] })).body.error;
    const E = pid(await run()); o.run5_after_write = [E.status, E.blockedReasons];
    o.http_contains_code_final = X.raws.some(t => Object.values(X.codes).some(c => t.includes(c)));
    o.ledger = X.store.data.disputeWrites;
  } finally { X.s.closeAllConnections?.(); X.s.close(); }
  // tamper + PayPal change on fresh instances
  const Y = await mk();
  try {
    const P = (await Y.req('POST', '/api/disputes/PP-D-1/ai', {})).body.agent.proposals[0];
    const st = Object.values(Y.store.data.agentRuns).flat().flatMap(r => r.proposals).find(p => p.id === P.id);
    const orig = JSON.stringify(st.canonical); st.canonical = { ...st.canonical, note: 'tampered' };
    o.tamper = (await Y.req('POST', `/api/agent/proposals/${P.id}/approve`, { approved: true, token: Y.codes[P.id] })).body.error;
    st.canonical = JSON.parse(orig);
  } finally { Y.s.closeAllConnections?.(); Y.s.close(); }
  const api = fakeApi(); const og = api.getDispute; let tamper = null; api.getDispute = async (...a) => { const d = await og(...a); return tamper ? tamper(d) : d; };
  const Z = await mk({ api });
  try {
    const P = (await Z.req('POST', '/api/disputes/PP-D-1/ai', {})).body.agent.proposals[0];
    tamper = (d) => ({ ...d, dispute_amount: { currency_code: 'USD', value: '4.00' } });
    o.paypal_changed = (await Z.req('POST', `/api/agent/proposals/${P.id}/approve`, { approved: true, token: Z.codes[P.id] })).body.error;
  } finally { Z.s.closeAllConnections?.(); Z.s.close(); fs.writeFileSync('/tmp/sf5-gate.json', JSON.stringify(o, null, 1)); }
});
