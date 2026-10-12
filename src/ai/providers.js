// Pluggable LLM providers. Keys come from env only and are registered for redaction; nothing is logged.
//   Google Gemini: GEMINI_API_KEY, model GEMINI_MODEL (default gemini-3.6-flash, a stable Flash model; gemini-3.5-flash is deprecated and
//                  routed to it. Live checks on 11 Oct 2026 are listed in docs/agent-run-redacted.json.)
//   Groq:          GROQ_API_KEY,   model GROQ_MODEL   (default openai/gpt-oss-20b; Groq retired its free Llama models on 16 Aug 2026)
// Choose with PROOFPILOT_LLM_PROVIDER=gemini|groq when both keys are set (default: gemini).
import { registerSecret } from '../lib/redact.js';

export const DEFAULT_MODELS = { gemini: 'gemini-3.6-flash', groq: 'openai/gpt-oss-20b' };

export class LlmError extends Error { constructor(provider, status, message) { super(`${provider} ${status}: ${message}`); this.provider = provider; this.status = status; } }

export function parseJsonText(text) {
  const t = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '');
  try { return JSON.parse(t); } catch { const m = t.match(/\{[\s\S]*\}/); if (m) return JSON.parse(m[0]); throw new Error('Model did not return JSON'); }
}

export function geminiProvider({ apiKey, model = DEFAULT_MODELS.gemini, fetchImpl = globalThis.fetch }) {
  registerSecret(apiKey);
  return {
    provider: 'gemini', model, label: `Google Gemini (${model})`,
    // Vercel AI SDK model (used by the PayPal Agent Toolkit agent loop in src/ai/agent.js).
    async languageModel() {
      const { createGoogleGenerativeAI } = await import('@ai-sdk/google');
      return createGoogleGenerativeAI({ apiKey, fetch: fetchImpl })(model);
    },
    async completeJSON({ system, user }) {
      const res = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: user }] }],
          generationConfig: { responseMimeType: 'application/json' } }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new LlmError('gemini', res.status, body?.error?.status || body?.error?.message?.slice(0, 120) || 'error');
      const text = (body.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
      return { json: parseJsonText(text), usage: body.usageMetadata || null };
    },
  };
}

export function groqProvider({ apiKey, model = DEFAULT_MODELS.groq, fetchImpl = globalThis.fetch }) {
  registerSecret(apiKey);
  return {
    provider: 'groq', model, label: `Groq (${model})`,
    async completeJSON({ system, user }) {
      const res = await fetchImpl('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, temperature: 0.2, response_format: { type: 'json_object' },
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new LlmError('groq', res.status, body?.error?.code || body?.error?.message?.slice(0, 120) || 'error');
      return { json: parseJsonText(body.choices?.[0]?.message?.content), usage: body.usage || null };
    },
  };
}

// Returns null when no key is configured: the UI then says "AI not configured" and never shows a made-up answer.
export function createLlmProvider(env = process.env, fetchImpl = globalThis.fetch) {
  const want = (env.PROOFPILOT_LLM_PROVIDER || '').toLowerCase();
  const gem = env.GEMINI_API_KEY && geminiProvider({ apiKey: env.GEMINI_API_KEY, model: env.GEMINI_MODEL || DEFAULT_MODELS.gemini, fetchImpl });
  const grq = env.GROQ_API_KEY && groqProvider({ apiKey: env.GROQ_API_KEY, model: env.GROQ_MODEL || DEFAULT_MODELS.groq, fetchImpl });
  const pick = want === 'groq' ? (grq || gem || null) : (gem || grq || null);
  if (!pick) return null;
  // keysSet: which providers have a key present (a key being set does not mean it works).
  pick.keysSet = [gem && 'gemini', grq && 'groq'].filter(Boolean);
  // Automatic backup: when Gemini is rate-limited, the same run is retried once on Groq (plain advisor, no write tools).
  pick.backup = pick.provider === 'gemini' && grq ? grq : null;
  return pick;
}
