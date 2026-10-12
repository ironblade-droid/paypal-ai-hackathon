// Gemini rate-limited -> automatic Groq backup (mocked providers, no network, no keys).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLlmProvider } from '../src/ai/providers.js';
import { createApp } from '../src/app.js';
import { createStore } from '../src/lib/store.js';
import { rulesEngine } from '../src/engine/recommend.js';
import { fakeApi } from './fixtures.js';

const GOOD = { action: 'FIGHT', evidence_type: 'PROOF_OF_FULFILLMENT', rationale_facts: ['capture:CAP123:amount'], narrative_facts: ['capture:CAP123:amount'] };
const gemini = (backup) => ({ provider: 'gemini', model: 'gemini-test', label: 'Gemini (test)', keysSet: backup ? ['gemini', 'groq'] : ['gemini'], backup,
  completeJSON: async () => { gemini.calls = (gemini.calls || 0) + 1; throw new Error('gemini 429: RESOURCE_EXHAUSTED'); } });
const groq = (fail) => ({ provider: 'groq', model: 'openai/gpt-oss-20b', label: 'Groq (test)',
  completeJSON: async () => { groq.calls = (groq.calls || 0) + 1; if (fail) throw new Error('groq 500: boom'); return { json: GOOD }; } });

async function run(llm, path = '/api/disputes/PP-D-1/ai', method = 'POST') {
  const app = createApp({ api: fakeApi(), store: createStore(null), engine: rulesEngine, config: { dryRun: true }, llm });
  const s = await new Promise(r => { const x = app.listen(0, () => r(x)); });
  try { return await (await fetch(`http://127.0.0.1:${s.address().port}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: method === 'POST' ? '{}' : undefined })).json(); }
  finally { s.close(); }
}

test('gemini rate-limited + groq key: groq answers, run records provider and fallbackFrom', async () => {
  groq.calls = 0;
  const out = await run(gemini(groq(false)));
  assert.equal(out.ok, true); assert.equal(groq.calls, 1);
  assert.equal(out.provider, 'groq'); assert.equal(out.fallbackFrom, 'gemini');
  assert.equal(out.run.kind, 'LIVE_MODEL'); assert.equal(out.run.provider, 'groq'); assert.equal(out.run.fallbackFrom, 'gemini');
  assert.equal(out.run.model, 'openai/gpt-oss-20b');
  assert.ok(!out.agent, 'backup is the plain advisor: no toolkit, no write proposals');
});

test('gemini rate-limited, no groq key: RULES_FALLBACK with RATE_LIMITED', async () => {
  const out = await run(gemini(null));
  assert.equal(out.ok, false); assert.equal(out.run.kind, 'RULES_FALLBACK'); assert.equal(out.run.liveError, 'RATE_LIMITED');
  assert.doesNotMatch(out.run.note, /20 requests/); assert.match(out.run.note, /hit its rate limit/);
  assert.equal(out.cachedDemo.available, true);
});

test('gemini rate-limited, groq also fails: RULES_FALLBACK, backup recorded as tried', async () => {
  const out = await run(gemini(groq(true)));
  assert.equal(out.run.kind, 'RULES_FALLBACK'); assert.equal(out.run.liveError, 'RATE_LIMITED'); assert.equal(out.run.backupTried, 'groq');
});

test('healthz reports keySet / keysSet, never "configured"', async () => {
  const h = await run(gemini(groq(false)), '/healthz', 'GET');
  assert.equal(h.ai.keySet, true); assert.deepEqual(h.ai.keysSet, ['gemini', 'groq']); assert.equal(h.ai.backup.provider, 'groq');
  assert.equal('configured' in h.ai, false);
  const none = await run(null, '/healthz', 'GET');
  assert.equal(none.ai.keySet, false); assert.deepEqual(none.ai.keysSet, []); assert.equal('configured' in none.ai, false);
});

test('createLlmProvider: gemini primary gets groq backup; keysSet lists providers with keys', () => {
  const p = createLlmProvider({ GEMINI_API_KEY: 'g-key-1234567890', GROQ_API_KEY: 'q-key-1234567890' });
  assert.equal(p.provider, 'gemini'); assert.equal(p.backup.provider, 'groq'); assert.equal(p.backup.model, 'openai/gpt-oss-20b');
  assert.deepEqual(p.keysSet, ['gemini', 'groq']);
  assert.equal(createLlmProvider({ GEMINI_API_KEY: 'g-key-1234567890' }).backup, null);
  assert.equal(createLlmProvider({ GROQ_API_KEY: 'q-key-1234567890', GROQ_MODEL: 'x/y' }).backup, null);
});
