// Redaction helpers: secrets and bearer tokens never reach logs or API responses.
const secrets = new Set();
export function registerSecret(value) { if (value && value.length >= 8) secrets.add(value); }
export function redact(text) {
  let out = String(text);
  for (const s of secrets) out = out.split(s).join('[REDACTED]');
  return out.replace(/Bearer\s+[A-Za-z0-9._\-]+/g, 'Bearer [REDACTED]')
            .replace(/Basic\s+[A-Za-z0-9+/=]{16,}/g, 'Basic [REDACTED]');
}
export function log(...args) { console.log(redact(args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' '))); }
