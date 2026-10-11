// AI advisor tests with mocked providers (no network, no keys).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { geminiProvider, groqProvider, createLlmProvider, DEFAULT_MODELS } from '../src/ai/providers.js';
import { adviseWithLlm, parseCitedSentences, SYSTEM_PROMPT } from '../src/ai/advisor.js';
import { makeRegistry } from '../src/engine/evidence.js';
import { rulesEngine } from '../src/engine/recommend.js';
import { createApp } from '../src/app.js';
import { createStore } from '../src/lib/store.js';
import { capture, order, tracker, dispute, fakeApi } from './fixtures.js';

const TR = `CAP123-${tracker.tracking_number}`;
function reg() { const r = makeRegistry(); r.add('dispute', 'PP-D-1', dispute()); r.add('capture', 'CAP123', capture); r.add('order', 'ORD123', order); r.add('tracker', TR, tracker); return r; }
const packs = { PROOF_OF_FULFILLMENT: { requirementMet: true, validation: { ok: true } } };
const ctx = (over = {}) => ({ dispute: dispute(), allowedTypes: ['PROOF_OF_FULFILLMENT'], actions: ['provide_evidence', 'accept_claim'], registry: reg(), packs,
  rules: rulesEngine.recommend({ dispute: dispute(), allowedTypes: ['PROOF_OF_FULFILLMENT'], packs }), ...over });
const mock = (json, extra = {}) => ({ provider: 'mock', model: 'mock-model', label: 'Mock (tests only)', completeJSON: async (req) => { mock.last = req; if (extra.throw) throw new Error('boom'); return { json }; } });

test('no provider: advisor reports not configured (never invents a response)', async () => {
  const r = await adviseWithLlm(null, ctx());
  assert.equal(r.available, false); assert.match(r.reason, /GEMINI_API_KEY or GROQ_API_KEY/);
  assert.equal(createLlmProvider({}), null);
});

test('provider selection and default models', () => {
  assert.equal(createLlmProvider({ GEMINI_API_KEY: 'g-key-1234567890' }).provider, 'gemini');
  assert.equal(createLlmProvider({ GROQ_API_KEY: 'q-key-1234567890' }).provider, 'groq');
  assert.equal(createLlmProvider({ GEMINI_API_KEY: 'g-key-1234567890', GROQ_API_KEY: 'q-key-1234567890', PROOFPILOT_LLM_PROVIDER: 'groq' }).provider, 'groq');
  assert.equal(createLlmProvider({ GEMINI_API_KEY: 'g-key-1234567890' }).model, DEFAULT_MODELS.gemini); assert.equal(DEFAULT_MODELS.gemini, 'gemini-3.6-flash');
  assert.equal(createLlmProvider({ GROQ_API_KEY: 'q-key-1234567890', GROQ_MODEL: 'x/y' }).model, 'x/y');
});

test('gemini request shape (mocked fetch): key in header, JSON mime type, parses candidates', async () => {
  let seen;
  const fetchImpl = async (url, init) => { seen = { url, init }; return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"action":"WAIT"}' }] } }] }), { status: 200 }); };
  const p = geminiProvider({ apiKey: 'gem-test-key-123456', model: 'gemini-3.6-flash', fetchImpl });
  const r = await p.completeJSON({ system: 's', user: 'u' });
  assert.deepEqual(r.json, { action: 'WAIT' });
  assert.match(seen.url, /models\/gemini-3\.6-flash:generateContent$/);
  assert.equal(seen.init.headers['x-goog-api-key'], 'gem-test-key-123456');
  assert.ok(!seen.url.includes('gem-test-key'), 'key never in URL');
  assert.equal(JSON.parse(seen.init.body).generationConfig.responseMimeType, 'application/json');
});

test('groq request shape (mocked fetch): OpenAI-compatible, json_object, error surfaced', async () => {
  let seen;
  const ok = async (url, init) => { seen = { url, init }; return new Response(JSON.stringify({ choices: [{ message: { content: '```json\n{"action":"FIGHT"}\n```' } }] }), { status: 200 }); };
  const r = await groqProvider({ apiKey: 'groq-test-key-123456', fetchImpl: ok }).completeJSON({ system: 's', user: 'u' });
  assert.deepEqual(r.json, { action: 'FIGHT' });
  assert.equal(seen.url, 'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(JSON.parse(seen.init.body).response_format.type, 'json_object');
  assert.equal(JSON.parse(seen.init.body).model, DEFAULT_MODELS.groq);
  const bad = async () => new Response(JSON.stringify({ error: { code: 'rate_limit_exceeded' } }), { status: 429 });
  await assert.rejects(groqProvider({ apiKey: 'groq-test-key-123456', fetchImpl: bad }).completeJSON({ system: 's', user: 'u' }), /groq 429: rate_limit_exceeded/);
});

test('sentence parser keeps "5.50" intact and reads inline citations per sentence', () => {
  const s = parseCitedSentences(['Payment of USD 5.50 was captured [capture:CAP123]. The buyer is lying.'], 'ai');
  assert.equal(s.length, 2); assert.equal(s[0].text, 'Payment of USD 5.50 was captured.'); assert.deepEqual(s[0].refs, [{ type: 'capture', id: 'CAP123' }]);
  assert.deepEqual(s[1].refs, []);
});

test('structured claims: picked fact ids are rendered from record fields; free text passes only if it is exactly a fact', async () => {
  const r = await adviseWithLlm(mock({ action: 'FIGHT', evidence_type: 'PROOF_OF_FULFILLMENT',
    rationale_facts: ['dispute:PP-D-1:requested', `tracker:${TR}:shipped`],
    narrative_facts: ['capture:CAP123:amount', `tracker:${TR}:shipped`, 'capture:CAP123:invented-field'],
    narrative: [
      'The buyer paid USD 5.50 [capture:CAP123].',
      'The order was paid in full, USD 5.50 [capture:CAP123].',
      'The buyer confirmed delivery by phone.',
      'Delivery was confirmed by the courier [tracker:FAKE-1].',
      'The buyer was refunded USD 9.99 [capture:CAP123].',
      'This case will be won by the seller [dispute:PP-D-1].'] }), ctx());
  assert.equal(r.ok, true); assert.equal(r.recommendation.action, 'FIGHT'); assert.equal(r.recommendation.source, 'llm'); assert.equal(r.agreesWithRules, true);
  assert.deepEqual(r.narrative.accepted.map(c => c.factId), ['capture:CAP123:amount', `tracker:${TR}:shipped`, 'capture:CAP123:amount']);
  assert.equal(r.narrative.accepted[1].text, `Shipped with USPS, tracking ${tracker.tracking_number}, registered with PayPal (status SHIPPED) [sandbox test tracking number, no real parcel].`);
  assert.deepEqual(r.narrative.refused.map(x => x.reason), ['UNKNOWN_FACT', 'NOT_A_RECORDED_FACT', 'NO_LINKED_RECORD', 'UNKNOWN_RECORD', 'VALUE_NOT_IN_CITED_RECORD', 'OUTCOME_CLAIM']);
  assert.equal(r.rationale.accepted.length, 2);
  assert.match(mock.last.system, /\[type:id\]/); assert.match(mock.last.user, /"requested_evidence_types"/); assert.match(mock.last.user, /"facts"/);
  assert.doesNotMatch(mock.last.user, /example\.com|@/, 'no emails sent to the model');
});

test('model may not pick a type PayPal refused; no checkable reason means rules fallback', async () => {
  const a = await adviseWithLlm(mock({ action: 'FIGHT', evidence_type: 'PROOF_OF_FULFILLMENT', rationale_facts: ['capture:CAP123:amount'] }), ctx({ rejectedTypes: ['PROOF_OF_FULFILLMENT'] }));
  assert.ok(a.flags.some(f => /already refused/.test(f))); assert.equal(a.recommendation.source, 'rules-fallback');
  assert.match(mock.last.user, /"refused_by_paypal": \[\n\s+"PROOF_OF_FULFILLMENT"/);
  const b = await adviseWithLlm(mock({ action: 'ACCEPT', rationale: ['Accepting is cheapest [dispute:PP-D-1].'] }), ctx());
  assert.equal(b.recommendation.source, 'rules-fallback'); assert.ok(b.flags.some(f => /no reason/.test(f)));
});

test('sanity checks: action not offered, type not requested, FIGHT without complete pack -> rules fallback', async () => {
  const a = await adviseWithLlm(mock({ action: 'OFFER', narrative: [], rationale_facts: ['capture:CAP123:amount'] }), ctx());
  assert.equal(a.recommendation.source, 'rules-fallback'); assert.match(a.flags[0], /does not offer that on this dispute/);
  const b = await adviseWithLlm(mock({ action: 'FIGHT', evidence_type: 'OTHER', narrative: [] }), ctx());
  assert.ok(b.flags.some(f => /does not request/.test(f))); assert.equal(b.recommendation.source, 'rules-fallback');
  const c = await adviseWithLlm(mock({ action: 'FIGHT', evidence_type: 'PROOF_OF_FULFILLMENT' }), ctx({ packs: { PROOF_OF_FULFILLMENT: { requirementMet: false, validation: { ok: true } } } }));
  assert.ok(c.flags.some(f => /Sanity check/.test(f)));
  const d = await adviseWithLlm(mock({ action: 'ACCEPT', narrative: [], rationale_facts: ['dispute:PP-D-1:amount'] }), ctx());
  assert.equal(d.recommendation.action, 'ACCEPT'); assert.equal(d.agreesWithRules, false);
});

test('provider failure is reported honestly with the rules fallback', async () => {
  const r = await adviseWithLlm(mock({}, { throw: true }), ctx());
  assert.equal(r.ok, false); assert.equal(r.error, 'boom'); assert.equal(r.fallback.action, 'FIGHT');
});

test('system prompt forbids outcome predictions and requires citations', () => {
  assert.match(SYSTEM_PROMPT, /Never predict, promise or describe the outcome/);
  assert.match(SYSTEM_PROMPT, /Use ONLY the records provided/);
});

test('app: /ai route uses the configured provider; AI sentences are re-checked strictly on submit', async () => {
  const llm = mock({ action: 'FIGHT', evidence_type: 'PROOF_OF_FULFILLMENT', rationale_facts: ['capture:CAP123:amount'], narrative_facts: ['capture:CAP123:amount'] });
  const app = createApp({ api: fakeApi(), store: createStore(null), engine: rulesEngine, config: { dryRun: true }, llm });
  const s = await new Promise(r => { const x = app.listen(0, () => r(x)); }); const base = `http://127.0.0.1:${s.address().port}`;
  const post = async (p, b) => (await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })).json();
  const cfg = await (await fetch(base + '/api/config')).json();
  assert.deepEqual(cfg.ai, { configured: true, provider: 'mock', model: 'mock-model', label: 'Mock (tests only)', agent: null });
  const ai = await post('/api/disputes/PP-D-1/ai', {});
  assert.equal(ai.ok, true); assert.equal(ai.narrative.accepted[0].id, 'ai-1'); assert.equal(ai.narrative.accepted[0].text, 'The buyer paid USD 5.50.');
  const sub = (customClaims) => post('/api/disputes/PP-D-1/submit', { action: 'provide_evidence', evidenceType: 'PROOF_OF_FULFILLMENT', approved: true, confirm: 'APPROVE', packHash: 'x', customClaims });
  const bad = await sub([{ id: 'ai-9', text: 'Refunded USD 1.23 already.', refs: [{ type: 'capture', id: 'CAP123' }] }]);
  assert.equal(bad.error, 'UNCITED_CLAIMS'); assert.equal(bad.rejected[0].reason, 'VALUE_NOT_IN_CITED_RECORD');
  // Not keyed on the id prefix: any sentence that is not a built-in claim or marked as the seller's wording must be a fact.
  const sneaky = await sub([{ id: 'x-1', text: 'The buyer admitted receiving it.', refs: [{ type: 'dispute', id: 'PP-D-1' }] }]);
  assert.equal(sneaky.error, 'UNCITED_CLAIMS'); assert.equal(sneaky.rejected[0].reason, 'NOT_A_RECORDED_FACT');
  // An AI fact passes the server check (then fails only on the pack hash, which the UI computes).
  const fact = await sub([ai.narrative.accepted[0]]);
  assert.equal(fact.error, 'PACK_CHANGED');
  s.close();
});
