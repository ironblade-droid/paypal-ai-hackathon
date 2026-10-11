// Strict money parsing. Only plain decimal strings like "5", "5.5" or "5.50" are accepted: no exponents (1e-9), hex (0x5),
// signs, spaces inside, Infinity or more than two decimals. Returns { value: "5.50", cents: 550 } or null.
export function parseAmount(input) {
  if (typeof input === 'number') input = String(input);
  if (typeof input !== 'string') return null;
  const s = input; // no trimming: whitespace, signs, exponents and hex are all refused
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(s)) return null;
  const [w, f = ''] = s.split('.');
  const cents = Number(w) * 100 + Number(f.padEnd(2, '0'));
  return { value: `${Number(w)}.${f.padEnd(2, '0')}`, cents };
}
// An amount the seller may offer or refund: at least 0.01 and at most the disputed amount, same currency.
export function checkAmountWithin(amount, { currency, max }) {
  const raw = typeof amount === 'object' && amount ? amount.value : amount;
  const cur = typeof amount === 'object' && amount ? amount.currency_code : currency;
  const p = parseAmount(raw);
  if (!p) return { ok: false, reason: 'AMOUNT_NOT_A_PLAIN_DECIMAL' };
  if (p.cents < 1) return { ok: false, reason: 'AMOUNT_BELOW_0_01' };
  const m = parseAmount(String(max)); if (!m || p.cents > m.cents) return { ok: false, reason: 'AMOUNT_ABOVE_DISPUTED' };
  if (String(cur || '').toUpperCase() !== String(currency || '').toUpperCase()) return { ok: false, reason: 'CURRENCY_MISMATCH' };
  return { ok: true, value: p.value, currency_code: currency };
}
