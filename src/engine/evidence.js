// Evidence pack builder + citation checker.
// Every claim in a pack must cite at least one real PayPal record (dispute, order, capture, tracker, refund) that
// ProofPilot fetched from the API in this session. The checker refuses any claim without such a link.
import crypto from 'node:crypto';
import { human } from './labels.js';
import { normalizeText, hasHiddenChars } from '../lib/text.js';

// ---- Which evidence types can the seller send? Only what the dispute itself asks for (never a fixed list).
export function allowedEvidenceTypes(dispute) {
  const stage = dispute?.dispute_life_cycle_stage;
  const types = (dispute?.evidences || [])
    .filter(e => e.source === 'REQUESTED_FROM_SELLER')
    .filter(e => !stage || !e.dispute_life_cycle_stage || e.dispute_life_cycle_stage === stage)
    .map(e => e.evidence_type)
    .filter(Boolean);
  // Some dispute payloads also carry explicit response options; include evidence types listed there if present.
  for (const opt of dispute?.allowed_response_options?.provide_evidence?.evidence_types || []) types.push(opt);
  return [...new Set(types)];
}

// ---- Records: a flat registry keyed by "type:id". Only records actually fetched from PayPal are verified.
export function recordKey(type, id) { return `${type}:${id}`; }
export function makeRegistry() {
  const map = new Map();
  return {
    add(type, id, data, source, note) { if (id) map.set(recordKey(type, id), { type, id, source, note, verified: true, fetchedAt: new Date().toISOString(), data }); },
    get(type, id) { return map.get(recordKey(type, id)); },
    has(type, id) { return map.has(recordKey(type, id)); },
    list() { return [...map.values()].map(({ data, ...r }) => r); },
    all() { return [...map.values()]; },
  };
}

// Fetch every record a pack could cite. Failures are recorded as gaps, never invented.
export async function gatherRecords(api, dispute, store) {
  const reg = makeRegistry(); const gaps = [];
  reg.add('dispute', dispute.dispute_id, dispute, 'GET /v1/customer/disputes/{id}');
  const txn = dispute.disputed_transactions?.[0] || {};
  const captureId = txn.seller_transaction_id;
  let capture = null; let order = null; let trackers = [];
  if (captureId) {
    try { capture = await api.getCapture(captureId); reg.add('capture', captureId, capture, 'GET /v2/payments/captures/{id}'); }
    catch (e) { gaps.push({ code: 'CAPTURE_UNAVAILABLE', message: `Could not fetch capture ${captureId}: ${e.issue || e.message}` }); }
    const orderId = capture?.supplementary_data?.related_ids?.order_id
      || (capture?.links || []).find(l => l.rel === 'up')?.href?.split('/').pop()
      || store?.findOrderByCapture?.(captureId)?.id;
    if (orderId) {
      try { order = await api.getOrder(orderId); reg.add('order', orderId, order, 'GET /v2/checkout/orders/{id}'); }
      catch (e) { gaps.push({ code: 'ORDER_UNAVAILABLE', message: `Could not fetch order ${orderId}: ${e.issue || e.message}` }); }
    } else gaps.push({ code: 'ORDER_UNKNOWN', message: 'No order id is linked to this capture.' });
    try {
      const t = await api.listTrackers(captureId);
      trackers = t?.trackers || [];
      trackers = trackers.map(tr => ({ ...tr, proofpilot_timing: trackerTiming(tr, dispute) }));
      for (const tr of trackers) reg.add('tracker', `${tr.transaction_id}-${tr.tracking_number}`, tr, 'GET /v1/shipping/trackers', trackerNote(tr));
    } catch (e) { gaps.push({ code: 'TRACKERS_UNAVAILABLE', message: `Could not read trackers: ${e.issue || e.message}` }); }
    for (const r of order?.purchase_units?.[0]?.payments?.refunds || []) {
      const cls = classifyRefund(r, dispute);
      reg.add('refund', r.id, { ...r, proofpilot_classification: cls.kind }, 'GET /v2/checkout/orders/{id} (payments.refunds)', cls.label);
    }
  } else gaps.push({ code: 'NO_SELLER_TXN', message: 'Dispute lists no seller transaction id.' });
  return { registry: reg, capture, order, trackers, gaps };
}

// Sandbox-only app: every tracking number is test data, never a real parcel. Say so wherever it is cited.
export const TEST_TRACKING_NOTE = 'Sandbox test data: tracking number registered in the PayPal sandbox, no real parcel.';

// When was a tracker registered with PayPal, relative to the dispute? Tracking added after the buyer opened the case is
// after-the-fact and is never used as proof of shipment. PayPal's tracker object has no create_time, so ProofPilot uses
// last_updated_time (epoch ms); a later update also makes a tracker count as "after", which errs on the safe side.
// A tracker with no time at all is treated the same way: ProofPilot cannot show it predates the dispute.
export function trackerRegisteredAt(t) {
  const c = Date.parse(t?.create_time || ''); if (!Number.isNaN(c)) return c;
  const n = Number(t?.last_updated_time); if (Number.isFinite(n) && n > 1e11) return n;
  const p = Date.parse(t?.last_updated_time || ''); return Number.isNaN(p) ? null : p;
}
export function trackerTiming(t, dispute) {
  const at = trackerRegisteredAt(t); const opened = Date.parse(dispute?.create_time || '');
  if (at == null || Number.isNaN(opened)) return { status: 'UNKNOWN', at: at == null ? null : new Date(at).toISOString() };
  return { status: at <= opened ? 'BEFORE_DISPUTE' : 'AFTER_DISPUTE', at: new Date(at).toISOString(), disputeOpened: new Date(opened).toISOString() };
}
// Timing for a tracker record in a registry (computed against the registry's dispute record when not stored).
export function registryTiming(registry, data) {
  if (data?.proofpilot_timing) return data.proofpilot_timing;
  const d = registry.all().find(r => r.type === 'dispute')?.data;
  return trackerTiming(data, d);
}
export function trackerUsable(t, dispute) { return (t?.proofpilot_timing || trackerTiming(t, dispute)).status === 'BEFORE_DISPUTE'; }
function trackerNote(t) {
  const tm = t.proofpilot_timing || {};
  if (tm.status === 'AFTER_DISPUTE') return `${TEST_TRACKING_NOTE} Added after dispute opened (registered ${tm.at}, case opened ${tm.disputeOpened}): not used as proof of shipment.`;
  if (tm.status === 'UNKNOWN') return `${TEST_TRACKING_NOTE} PayPal reports no registration time, so ProofPilot cannot show it predates the dispute: not used as proof of shipment.`;
  return TEST_TRACKING_NOTE;
}

// What is this refund record really? PayPal records the dispute hold on the seller's balance as a PENDING
// refund-type entry (same amount and second as the dispute's HOLD_PLACED fund movement). That is NOT a refund the
// seller issued, so it must never back a PROOF_OF_REFUND claim.
export function classifyRefund(refund, dispute) {
  const t = Date.parse(refund?.create_time || 0);
  const hold = (dispute?.fund_movements || []).find(m => m.reason === 'HOLD_PLACED' && m.amount?.value === refund?.amount?.value
    && Math.abs(Date.parse(m.initiated_time || 0) - t) <= 120_000);
  if (hold) return { kind: 'DISPUTE_HOLD', label: `PayPal dispute hold (not a seller refund): matches the dispute's HOLD_PLACED fund movement of ${hold.amount.currency_code} ${hold.amount.value} at ${hold.initiated_time}.` };
  if (refund?.status !== 'COMPLETED') return { kind: 'PENDING_REVERSAL', label: `Refund record with status ${refund?.status}: not a completed refund.` };
  return { kind: 'SELLER_REFUND', label: 'Completed refund.' };
}

// ---- Build candidate claims for one evidence type, each tied to record refs.
export function buildPack(evidenceType, { dispute, capture, order, trackers, registry, localOrder }) {
  const claims = []; const gaps = [];
  const c = (id, text, refs) => claims.push({ id, text, refs });
  const txn = dispute.disputed_transactions?.[0] || {};
  if (capture) c('payment', `Payment of ${money(capture.amount)} was captured on ${capture.create_time} (capture ${capture.id}).`, [{ type: 'capture', id: capture.id }]);
  if (txn.seller_protection_eligible) c('protection', `PayPal lists this transaction as Seller Protection eligible (${txn.seller_protection_type || 'type not stated'}).`, [{ type: 'dispute', id: dispute.dispute_id }]);
  const addr = order?.purchase_units?.[0]?.shipping?.address;
  if (addr) c('address', `The PayPal order's shipping address is ${fmtAddr(addr)}.`, [{ type: 'order', id: order.id }]);

  // Tracking previously sent as evidence but not registered with PayPal is a weak spot: surface it.
  const knownNumbers = new Set(trackers.map(t => t.tracking_number));
  for (const e of dispute.evidences || []) for (const ti of e.evidence_info?.tracking_info || [])
    if (e.source === 'SUBMITTED_BY_SELLER' && !knownNumbers.has(ti.tracking_number))
      gaps.push({ code: 'UNREGISTERED_TRACKING', message: `Tracking ${ti.tracking_number} (${ti.carrier_name}) was submitted earlier but has no tracker record in PayPal Shipment Tracking.` });

  if (['PROOF_OF_FULFILLMENT', 'OTHER', 'SUPPORTING_INFO'].includes(evidenceType)) {
    const timed = trackers.map(t => ({ ...t, proofpilot_timing: t.proofpilot_timing || trackerTiming(t, dispute) }));
    const usable = timed.filter(t => t.proofpilot_timing.status === 'BEFORE_DISPUTE');
    for (const t of timed.filter(t => t.proofpilot_timing.status !== 'BEFORE_DISPUTE'))
      gaps.push({ code: 'LATE_TRACKING', message: t.proofpilot_timing.status === 'AFTER_DISPUTE'
        ? `Tracking ${t.tracking_number} was added after dispute opened (registered ${t.proofpilot_timing.at}). ProofPilot does not use it as proof of shipment.`
        : `Tracking ${t.tracking_number} has no registration time in PayPal, so ProofPilot cannot show it predates the dispute and does not use it as proof of shipment.` });
    if (!usable.length && evidenceType === 'PROOF_OF_FULFILLMENT') gaps.push({ code: 'NO_TRACKER', message: 'No tracking registered with PayPal before the dispute opened. Proof of fulfillment needs a tracker record that predates the case.' });
    for (const t of usable) {
      c(`tracker-${t.tracking_number}`, trackerClaimText(t),
        [{ type: 'tracker', id: `${t.transaction_id}-${t.tracking_number}` }]);
    }
    // Only the tracker ProofPilot itself added after a passed pre-ship check can back the "shipped to the order address" claim.
    const shipped = localOrder?.tracking && usable.find(t => t.tracking_number === localOrder.tracking.trackingNumber);
    if (shipped && addr && localOrder.shippedToMatchesOrder)
      c('shipped-to-order-address', `Tracking ${shipped.tracking_number} was added by ProofPilot after the pre-ship check confirmed the ship-to address matches the PayPal order.`,
        [{ type: 'order', id: order.id }, { type: 'tracker', id: `${shipped.transaction_id}-${shipped.tracking_number}` }]);
  }
  if (evidenceType === 'PROOF_OF_REFUND') {
    const all = order?.purchase_units?.[0]?.payments?.refunds || [];
    const done = all.filter(r => classifyRefund(r, dispute).kind === 'SELLER_REFUND');
    for (const r of all.filter(r => classifyRefund(r, dispute).kind === 'DISPUTE_HOLD'))
      gaps.push({ code: 'DISPUTE_HOLD_NOT_REFUND', message: `Record ${r.id} is PayPal's dispute hold, not a refund you issued. ProofPilot will not cite it as proof of refund.` });
    if (!done.length) gaps.push({ code: 'NO_COMPLETED_REFUND', message: 'No completed seller refund exists on this order, so proof of refund cannot be claimed.' });
    for (const r of done) c(`refund-${r.id}`, `Refund ${r.id} of ${money(r.amount)} completed.`, [{ type: 'refund', id: r.id }]);
  }
  if (!SUPPORTED_TYPES.includes(evidenceType))
    gaps.push({ code: 'UNSUPPORTED_EVIDENCE_TYPE', message: `PayPal asks for "${human('evidence', evidenceType)}". That needs a document ProofPilot does not have (no PayPal API record proves it), so ProofPilot will not send a pack under this label.` });
  return { evidenceType, claims, gaps, requirementMet: meetsRequirement(evidenceType, claims, registry) };
}

// Types ProofPilot can back with PayPal records. Anything else (signature, receipt, police report, ...) needs a document
// ProofPilot does not hold, so it is never "ready" and cannot be sent under that label.
export const SUPPORTED_TYPES = ['PROOF_OF_FULFILLMENT', 'PROOF_OF_REFUND', 'OTHER', 'SUPPORTING_INFO'];
export function meetsRequirement(type, claims, registry) {
  const usableTracker = (r) => r.type === 'tracker' && (!registry || registryTiming(registry, registry.get(r.type, r.id)?.data).status === 'BEFORE_DISPUTE');
  if (type === 'PROOF_OF_FULFILLMENT') return claims.some(c => c.refs.some(usableTracker));
  if (type === 'PROOF_OF_REFUND') return claims.some(c => c.refs.some(r => r.type === 'refund'));  // checker below rejects dispute holds
  if (!SUPPORTED_TYPES.includes(type)) return false;
  return claims.length > 0;
}

// ---- The checker.
// Every claim must cite at least one record ProofPilot fetched from PayPal. On top of that, for ALL claims:
//   - any amount (USD 5.50, $9, 550 USD), date (2026-10-01, October 1, 1 Oct, 10/01/2026) or long id (any case)
//     the sentence states must appear in the records it cites (VALUE_NOT_IN_CITED_RECORD);
//   - no wording that predicts or describes a case outcome (OUTCOME_CLAIM);
//   - no text after the last citation (TEXT_AFTER_CITATION), so a citation cannot "carry" an extra claim;
//   - a tracker added after the dispute opened can only be cited by a sentence that says so (LATE_TRACKING).
// STRICT mode (anything a model wrote) goes further: the sentence must be exactly one of the facts ProofPilot renders
// from fields of the cited records (factCatalog below). Free text, however plausible, is refused (NOT_A_RECORDED_FACT).
// This is the structured-claims design: the model picks fact ids, ProofPilot writes the words.
export const OUTCOME_WORDS = /\b(won|win|wins|winning|winner|lose|loses|losing|guarantee[sd]?|certain(ly)?|sure to|bound to|will (fail|succeed|prevail|be (resolved|decided|closed|rejected|denied))|should (rule|decide|side|find|close|reject|deny)|rule[sd]? (in|for|against)|ruling|decide[sd]? (in|for|against)|in (our|my|your|the seller'?s?) favou?r|favou?r(able|s)?|verdict|outcome|likely|chances?|odds|expect\w* .{0,40}(decision|ruling|result|refund)|resolved in|seller fav)\b/i;

// A "$" or "dollars" can be any dollar currency; every other symbol or code maps to exactly one currency.
const DOLLARS = ['USD', 'CAD', 'AUD', 'NZD', 'SGD', 'HKD', 'MXN'];
const SYMBOL_CURRENCIES = { '$': DOLLARS, DOLLAR: DOLLARS, DOLLARS, '€': ['EUR'], '£': ['GBP'], '₹': ['INR'] };
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n) => String(n).padStart(2, '0');
// Pull every checkable value out of a sentence: { raw, needles: [alternatives, any one must be in the cited data] }.
export function extractValues(text) {
  const t = normalizeText(text); const out = [];
  const amt = /(?:\b(USD|EUR|GBP|INR|CAD|AUD)\s?|([$€£₹])\s?)(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\b|\b(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\s?(USD|EUR|GBP|INR|CAD|AUD|dollars?)\b/gi;
  for (const m of t.matchAll(amt)) {
    const whole = (m[3] || m[5]).replace(/,/g, ''); const frac = m[4] ?? m[6] ?? '';
    const v = `${whole}.${frac.padEnd(2, '0').slice(0, 2)}`;
    const sym = (m[1] || m[2] || m[7] || '').toUpperCase();
    const currencies = SYMBOL_CURRENCIES[sym] || [sym];
    out.push({ raw: m[0].trim(), needles: [`"value":"${v}"`, ` ${v}`], money: { value: v, currencies } });
  }
  for (const m of t.matchAll(/\b\d+\.\d{2}\b/g)) out.push({ raw: m[0], needles: [m[0]] });
  for (const m of t.matchAll(/\b(\d{4})-(\d{2})-(\d{2})/g)) out.push({ raw: m[0], needles: [m[0]] });
  const mon = '(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\\.?';
  for (const m of t.matchAll(new RegExp(`\\b${mon}\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`, 'gi')))
    out.push({ raw: m[0], needles: [`${m[3] ? m[3] : ''}-${pad(MONTHS[m[1].toLowerCase()])}-${pad(m[2])}`] });
  for (const m of t.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${mon}(?:,?\\s+(\\d{4}))?\\b`, 'gi')))
    out.push({ raw: m[0], needles: [`${m[3] ? m[3] : ''}-${pad(MONTHS[m[2].toLowerCase()])}-${pad(m[1])}`] });
  for (const m of t.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/g)) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    out.push({ raw: m[0], needles: [`${y}-${pad(m[1])}-${pad(m[2])}`, `${y}-${pad(m[2])}-${pad(m[1])}`] });
  }
  for (const m of t.matchAll(/\b(?=[A-Za-z0-9-]*\d)[A-Za-z0-9][A-Za-z0-9-]{8,}\b/g)) out.push({ raw: m[0], needles: [m[0]] });
  return out;
}
// Values a sentence states must appear in the records it cites (case-insensitive).
export function unsupportedValues(text, refs, registry) {
  const hay = refs.map(r => { const d = registry.get(r.type, r.id)?.data || {};
    const extra = r.type === 'tracker' ? { proofpilot_timing: registryTiming(registry, d) } : {};
    return JSON.stringify({ ...d, ...extra }) + ' ' + r.type + ' ' + r.id; }).join(' ').toLowerCase();
  // Money in the cited records as "CUR value" pairs, so "EUR 5.50" does not pass on a USD 5.50 capture.
  const pairs = new Set();
  const walk = (o) => { if (!o || typeof o !== 'object') return; if (typeof o.currency_code === 'string' && typeof o.value === 'string') pairs.add(`${o.currency_code.toUpperCase()} ${o.value}`); for (const x of Object.values(o)) walk(x); };
  for (const r of refs) walk(registry.get(r.type, r.id)?.data);
  const bad = extractValues(text).filter(v => v.money
    ? !v.money.currencies.some(c => pairs.has(`${c} ${v.money.value}`))
    : !v.needles.some(n => hay.includes(n.toLowerCase())));
  return [...new Set(bad.map(v => v.raw))];
}

const money = (a) => (a ? `${a.currency_code} ${a.value}` : 'unknown amount');
const fmtAddr = (a) => (a ? [a.address_line_1, a.admin_area_2, a.admin_area_1, a.postal_code, a.country_code].filter(Boolean).join(', ') : '');
export const TEST_TRACKING_SUFFIX = '[sandbox test tracking number, no real parcel]';
export function trackerClaimText(t) {
  return `Shipped with ${t.carrier}${t.carrier_name_other ? ` (${t.carrier_name_other})` : ''}, tracking ${t.tracking_number}, registered with PayPal (status ${t.status}) ${TEST_TRACKING_SUFFIX}.`;
}
// Every fact ProofPilot can state, rendered from fields of fetched records. Ids are stable: "<type>:<record id>:<field>".
export function factCatalog(registry) {
  const facts = []; const f = (id, text, refs) => facts.push({ id, text, refs });
  for (const r of registry.all()) {
    const d = r.data || {}; const ref = [{ type: r.type, id: r.id }]; const k = `${r.type}:${r.id}`;
    if (r.type === 'capture') {
      if (d.amount) f(`${k}:amount`, `The buyer paid ${money(d.amount)}.`, ref);
      if (d.amount && d.create_time) f(`${k}:captured`, `Payment of ${money(d.amount)} was captured on ${d.create_time} (capture ${r.id}).`, ref);
      if (d.status) f(`${k}:status`, `PayPal reports the capture status as ${d.status}.`, ref);
      if (d.seller_protection?.status) f(`${k}:protection`, `PayPal marks this capture as Seller Protection ${d.seller_protection.status}.`, ref);
    }
    if (r.type === 'dispute') {
      const txn = d.disputed_transactions?.[0] || {};
      if (d.reason && d.create_time) f(`${k}:opened`, `The buyer opened this case on ${d.create_time} for: ${human('reason', d.reason)}.`, ref);
      if (d.dispute_amount) f(`${k}:amount`, `The disputed amount is ${money(d.dispute_amount)}.`, ref);
      if (txn.seller_protection_eligible) f(`${k}:protection`, `PayPal lists this transaction as Seller Protection eligible (${txn.seller_protection_type || 'type not stated'}).`, ref);
      const req = allowedEvidenceTypes(d);
      if (req.length) f(`${k}:requested`, `PayPal asked the seller for: ${req.map(x => human('evidence', x)).join(', ')}.`, ref);
    }
    if (r.type === 'order') {
      const pu = d.purchase_units?.[0] || {};
      if (pu.shipping?.address) f(`${k}:address`, `The PayPal order's shipping address is ${fmtAddr(pu.shipping.address)}.`, ref);
      if (pu.amount) f(`${k}:amount`, `The order total is ${money(pu.amount)}.`, ref);
    }
    if (r.type === 'tracker') {
      const tm = registryTiming(registry, d);
      if (tm.status === 'BEFORE_DISPUTE') f(`${k}:shipped`, trackerClaimText(d), ref);
      else if (tm.status === 'AFTER_DISPUTE') f(`${k}:late`, `Tracking ${d.tracking_number} was added after dispute opened (registered with PayPal ${tm.at}).`, ref);
    }
    if (r.type === 'refund' && d.proofpilot_classification === 'SELLER_REFUND') f(`${k}:refund`, `Refund ${r.id} of ${money(d.amount)} completed.`, ref);
  }
  return facts;
}
const norm = (s) => String(s).toLowerCase().replace(TEST_TRACKING_SUFFIX, '').replace(/\s+/g, ' ').replace(/[\s.]+$/, '').trim();
export function matchFact(claim, registry, catalog = factCatalog(registry)) {
  const n = norm(claim.text); const cited = new Set(claim.refs.map(r => `${r.type}:${r.id}`));
  return catalog.find(f => norm(f.text) === n && f.refs.every(r => cited.has(`${r.type}:${r.id}`))) || null;
}

export function validateClaims(claims, registry, { strict = false } = {}) {
  const accepted = []; const rejected = []; let catalog = null;
  for (const cl of claims) {
    if (!cl || typeof cl.text !== 'string' || !cl.text.trim()) { rejected.push({ claimId: cl?.id, reason: 'EMPTY_CLAIM' }); continue; }
    if (!Array.isArray(cl.refs) || cl.refs.length === 0) { rejected.push({ claimId: cl.id, reason: 'NO_LINKED_RECORD' }); continue; }
    const missing = cl.refs.filter(r => !registry.has(r.type, r.id));
    if (missing.length) { rejected.push({ claimId: cl.id, reason: 'UNKNOWN_RECORD', missing }); continue; }
    const holds = cl.refs.filter(r => r.type === 'refund' && registry.get(r.type, r.id)?.data?.proofpilot_classification !== 'SELLER_REFUND');
    if (holds.length) { rejected.push({ claimId: cl.id, reason: 'NOT_A_SELLER_REFUND', missing: holds }); continue; }
    if (cl.trailingText) { rejected.push({ claimId: cl.id, reason: 'TEXT_AFTER_CITATION' }); continue; }
    if (hasHiddenChars(cl.text)) { rejected.push({ claimId: cl.id, reason: 'HIDDEN_CHARACTERS' }); continue; }
    if (OUTCOME_WORDS.test(normalizeText(cl.text))) { rejected.push({ claimId: cl.id, reason: 'OUTCOME_CLAIM' }); continue; }
    const bad = unsupportedValues(cl.text, cl.refs, registry);
    if (bad.length) { rejected.push({ claimId: cl.id, reason: 'VALUE_NOT_IN_CITED_RECORD', values: bad }); continue; }
    const late = cl.refs.filter(r => r.type === 'tracker' && registryTiming(registry, registry.get(r.type, r.id)?.data).status !== 'BEFORE_DISPUTE');
    if (late.length && !/after (the )?dispute opened/i.test(cl.text)) { rejected.push({ claimId: cl.id, reason: 'LATE_TRACKING', missing: late }); continue; }
    if (strict) {
      catalog ||= factCatalog(registry);
      const fact = matchFact(cl, registry, catalog);
      if (!fact) { rejected.push({ claimId: cl.id, reason: 'NOT_A_RECORDED_FACT' }); continue; }
      accepted.push({ ...cl, factId: fact.id }); continue;
    }
    accepted.push(cl);
  }
  return { ok: rejected.length === 0 && accepted.length > 0, accepted, rejected };
}

export function packHash(disputeId, evidenceType, claims) {
  const canon = JSON.stringify({ disputeId, evidenceType, claims: claims.map(c => ({ id: c.id, text: c.text, refs: c.refs })) });
  return crypto.createHash('sha256').update(canon).digest('hex').slice(0, 16);
}

// ---- Turn an approved pack into the PayPal provide-evidence input.
export function toEvidencePayload(evidenceType, claims, { trackers = [], registry }) {
  const notes = ('ProofPilot evidence pack (PayPal sandbox test data). Each statement cites a PayPal record id.\n' +
    claims.map((c, i) => `${i + 1}. ${c.source === 'seller' ? "Seller's own statement: " : ''}${c.text} [${c.refs.map(r => `${r.type} ${r.id}`).join('; ')}]`).join('\n')).slice(0, 2000);
  const ev = { evidence_type: evidenceType, notes };
  if (evidenceType === 'PROOF_OF_FULFILLMENT') {
    const cited = new Set(claims.flatMap(c => c.refs.filter(r => r.type === 'tracker').map(r => r.id)));
    const ti = trackers.filter(t => cited.has(`${t.transaction_id}-${t.tracking_number}`) && registryTiming(registry, t).status === 'BEFORE_DISPUTE')
      .map(t => ({ carrier_name: t.carrier === 'OTHER' ? (t.carrier_name_other || 'OTHER') : t.carrier, tracking_number: t.tracking_number }));
    if (ti.length) ev.evidence_info = { tracking_info: ti };
  }
  if (evidenceType === 'PROOF_OF_REFUND') {
    const ids = claims.flatMap(c => c.refs.filter(r => r.type === 'refund').map(r => ({ refund_id: r.id })));
    if (ids.length) ev.evidence_info = { refund_ids: ids };
  }
  return { input: { evidences: [ev] }, notes };
}

// Minimal one-page PDF (no dependencies) attached to the evidence submission.
export function packPdf(lines) {
  const esc = (s) => String(s).replace(/[\\()]/g, (m) => '\\' + m).replace(/[^\x20-\x7E]/g, '?');
  const wrapped = lines.flatMap(l => String(l).match(/.{1,90}(\s|$)|\S+/g) || ['']).slice(0, 55);
  const stream = Buffer.from('BT /F1 10 Tf 40 760 Td 13 TL ' + wrapped.map(l => `(${esc(l.trim())}) Tj T*`).join(' ') + ' ET');
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let out = '%PDF-1.4\n'; const offs = [];
  objs.forEach((o, i) => { offs.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return Buffer.from(out);
}
