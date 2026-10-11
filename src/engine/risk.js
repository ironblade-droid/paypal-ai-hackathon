// Pre-shipping risk check: flags conditions that can void or weaken PayPal Seller Protection BEFORE the seller ships.
// Pure function over real PayPal records (order + capture) plus what the seller intends to do (ship-to, carrier, item type).
import { POLICY, SIGNATURE_THRESHOLD_USD } from './policy.js';

const norm = (s) => String(s || '').trim().toUpperCase().replace(/\s+/g, ' ');
export function addressKey(a = {}) {
  return [a.address_line_1, a.address_line_2, a.admin_area_2, a.admin_area_1, a.postal_code, a.country_code].map(norm).join('|');
}

export function checkShipment({ order, capture, shipTo, itemType = 'PHYSICAL', signatureConfirmation = false }) {
  const flags = [];
  const add = (code, severity, message, cite = POLICY.sellerProtection) => flags.push({ code, severity, message, cite });
  const pu = order?.purchase_units?.[0] || {};
  const orderAddr = pu.shipping?.address;
  const amount = Number(capture?.amount?.value ?? pu.amount?.value ?? 0);
  const currency = capture?.amount?.currency_code || pu.amount?.currency_code || 'USD';

  if (!order) add('NO_ORDER_RECORD', 'BLOCK', 'No PayPal order record found. Do not ship until the order is re-fetched from PayPal.');
  if (!capture) add('NO_CAPTURE', 'BLOCK', 'Payment has not been captured. Do not ship before the capture completes.');
  else if (capture.status !== 'COMPLETED')
    add('CAPTURE_NOT_COMPLETED', 'WARN', `Capture status is ${capture.status}${capture.status_details?.reason ? ` (${capture.status_details.reason})` : ''}. Shipping before funds settle increases loss risk.`);

  const sp = capture?.seller_protection;
  if (sp && sp.status !== 'ELIGIBLE')
    add('SELLER_PROTECTION_' + sp.status, sp.status === 'NOT_ELIGIBLE' ? 'BLOCK' : 'WARN',
      `PayPal reports Seller Protection ${sp.status}${sp.dispute_categories ? ` (covers: ${sp.dispute_categories.join(', ')})` : ''}.`);

  if (itemType !== 'PHYSICAL')
    add('NOT_PHYSICAL_GOODS', 'WARN', 'Seller Protection for Item Not Received generally covers physical goods shipped with tracking. Services and digital goods need other proof.');

  if (!orderAddr) add('NO_SHIPPING_ADDRESS', 'BLOCK', 'The PayPal order has no shipping address. Seller Protection requires shipping to the address on the Transaction Details page.');
  else if (shipTo && addressKey(shipTo) !== addressKey(orderAddr))
    add('ADDRESS_MISMATCH', 'BLOCK', 'Ship-to address differs from the address on the PayPal order. Shipping elsewhere (including buyer-requested redirects) can void Seller Protection.');

  const payerCountry = order?.payer?.address?.country_code;
  if (orderAddr && payerCountry && payerCountry !== orderAddr.country_code)
    add('CROSS_BORDER_SHIP', 'INFO', `Buyer account country (${payerCountry}) differs from ship-to country (${orderAddr.country_code}). Allowed, but keep customs and tracking records.`);

  if (currency === 'USD' && amount >= SIGNATURE_THRESHOLD_USD && !signatureConfirmation)
    add('SIGNATURE_REQUIRED', 'BLOCK', `Order is ${currency} ${amount.toFixed(2)}. US Seller Protection requires signature confirmation at ${currency} ${SIGNATURE_THRESHOLD_USD}+.`);

  add('ADD_TRACKING', 'INFO', 'After shipping, add tracking to PayPal. It is the proof for Item Not Received cases and PayPal says it helps release payment holds.', POLICY.holdsAndTracking);

  const blocks = flags.filter(f => f.severity === 'BLOCK').length;
  const warns = flags.filter(f => f.severity === 'WARN').length;
  const score = Math.max(0, 100 - blocks * 40 - warns * 15);
  return { ok: blocks === 0, score, flags, checkedAt: new Date().toISOString(), amount: { value: amount.toFixed(2), currency_code: currency } };
}
