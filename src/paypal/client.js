// Minimal PayPal REST client (sandbox only). Caches the OAuth token, never logs credentials.
import { PAYPAL_API_BASE } from '../config.js';
import { registerSecret } from '../lib/redact.js';

export class PayPalError extends Error {
  constructor(status, body, path) {
    const issue = body?.details?.[0]?.issue || body?.name || body?.error || 'PAYPAL_ERROR';
    super(`PayPal ${status} on ${path}: ${issue}`);
    this.status = status; this.issue = issue; this.debugId = body?.debug_id; this.body = body; this.path = path;
  }
}

// HTTP status and paypal-debug-id header of a successful call, kept off the JSON (non-enumerable) so callers that
// serialise the body are unchanged. Read it with paypalMeta(result).
export const PAYPAL_META = Symbol.for('proofpilot.paypalMeta');
export function paypalMeta(result) {
  const m = result && typeof result === 'object' ? result[PAYPAL_META] : null;
  return m ? { status: m.status ?? null, debugId: m.debugId ?? null } : { status: null, debugId: null };
}
function withMeta(parsed, meta) {
  const target = parsed && typeof parsed === 'object' ? parsed : {};
  Object.defineProperty(target, PAYPAL_META, { value: meta, enumerable: false, configurable: true });
  return target;
}

export function createPayPalClient({ clientId, clientSecret, fetchImpl = globalThis.fetch }) {
  if (!clientId || !clientSecret) throw new Error('PAYPAL_SANDBOX_CLIENT_ID and PAYPAL_SANDBOX_CLIENT_SECRET must be set');
  registerSecret(clientSecret);
  let token = null; let tokenExp = 0; let scopes = [];

  async function getToken() {
    if (token && Date.now() < tokenExp - 60_000) return token;
    const res = await fetchImpl(`${PAYPAL_API_BASE}/v1/oauth2/token`, {
      method: 'POST',
      headers: { Authorization: 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
                 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new PayPalError(res.status, { name: body.error, debug_id: body.debug_id }, '/v1/oauth2/token');
    token = body.access_token; registerSecret(token);
    tokenExp = Date.now() + (body.expires_in || 300) * 1000;
    scopes = String(body.scope || '').split(' ');
    return token;
  }

  async function request(method, path, { json, form, headers = {} } = {}) {
    const h = { Authorization: `Bearer ${await getToken()}`, 'PayPal-Request-Id': crypto.randomUUID(), ...headers };
    let body;
    if (json !== undefined) { h['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
    if (form) body = form; // FormData sets its own multipart boundary
    const res = await fetchImpl(PAYPAL_API_BASE + path, { method, headers: h, body });
    const text = await res.text();
    let parsed = null; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text.slice(0, 500) }; }
    const headerDebugId = res.headers?.get?.('paypal-debug-id') || null;
    if (!res.ok) { const err = new PayPalError(res.status, parsed, path); if (!err.debugId && headerDebugId) err.debugId = headerDebugId; throw err; }
    return withMeta(parsed, { status: res.status, debugId: headerDebugId || parsed?.debug_id || null });
  }

  return {
    getToken,
    scopes: () => scopes,
    get: (p) => request('GET', p),
    post: (p, json, headers) => request('POST', p, { json: json ?? {}, headers }),
    postMultipart: (p, input, files = [], headers) => {
      const fd = new FormData();
      fd.append('input', new Blob([JSON.stringify(input)], { type: 'application/json' }));
      for (const f of files) fd.append(f.field, new Blob([f.data], { type: f.type }), f.name);
      return request('POST', p, { form: fd, headers });
    },
  };
}
