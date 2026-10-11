// Evidence pack builder + citation checker.
// Every claim in a pack must cite at least one real PayPal record (dispute, order, capture, tracker, refund) that
// ProofPilot fetched from the API in this session. The checker refuses any claim without such a link.
import crypto from 'node:crypto';

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
      for (const tr of trackers) reg.add('tracker', `${tr.transaction_id}-${tr.tracking_number}`, tr, 'GET /v1/shipping/trackers', TEST_TRACKING_NOTE);
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

const money = (a) => (a ? `${a.currency_code} ${a.value}` : 'unknown amount');
const fmtAddr = (a) => (a ? [a.address_line_1, a.admin_area_2, a.admin_area_1, a.postal_code, a.country_code].filter(Boolean).join(', ') : '');

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
    if (!trackers.length && evidenceType === 'PROOF_OF_FULFILLMENT') gaps.push({ code: 'NO_TRACKER', message: 'No tracking is registered with PayPal for this capture. Proof of fulfillment needs a tracker record.' });
    for (const t of trackers) {
      c(`tracker-${t.tracking_number}`, `Shipped with ${t.carrier}${t.carrier_name_other ? ` (${t.carrier_name_other})` : ''}, tracking ${t.tracking_number}, registered with PayPal (status ${t.status}) [sandbox test tracking number, no real parcel].`,
        [{ type: 'tracker', id: `${t.transaction_id}-${t.tracking_number}` }]);
    }
    // Only the tracker ProofPilot itself added after a passed pre-ship check can back the "shipped to the order address" claim.
    const shipped = localOrder?.tracking && trackers.find(t => t.tracking_number === localOrder.tracking.trackingNumber);
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
    gaps.push({ code: 'UNSUPPORTED_EVIDENCE_TYPE', message: `PayPal asks for ${evidenceType}. That needs a document ProofPilot does not have (no PayPal API record proves it), so ProofPilot will not send a pack under this label.` });
  return { evidenceType, claims, gaps, requirementMet: meetsRequirement(evidenceType, claims) };
}

// Types ProofPilot can back with PayPal records. Anything else (signature, receipt, police report, ...) needs a document
// ProofPilot does not hold, so it is never "ready" and cannot be sent under that label.
export const SUPPORTED_TYPES = ['PROOF_OF_FULFILLMENT', 'PROOF_OF_REFUND', 'OTHER', 'SUPPORTING_INFO'];
export function meetsRequirement(type, claims) {
  if (type === 'PROOF_OF_FULFILLMENT') return claims.some(c => c.refs.some(r => r.type === 'tracker'));
  if (type === 'PROOF_OF_REFUND') return claims.some(c => c.refs.some(r => r.type === 'refund'));  // checker below rejects dispute holds
  if (!SUPPORTED_TYPES.includes(type)) return false;
  return claims.length > 0;
}

// ---- The checker. Refuses any claim with no linked record, or a link to a record we did not fetch.
// Words that predict or claim a case outcome. Generated text containing them is refused.
export const OUTCOME_WORDS = /\b(won|win|wins|winning|winner|guarantee[sd]?|certain(ly)? to|will be (resolved|decided) in)\b|seller fav/i;

// Values a sentence states (amounts, long ids, tracking numbers) must appear in the records it cites.
export function unsupportedValues(text, refs, registry) {
  const tokens = [...new Set([...(String(text).match(/\b\d+\.\d{2}\b/g) || []), ...(String(text).match(/\b(?=[A-Z0-9-]*\d)[A-Z0-9][A-Z0-9-]{9,}\b/g) || [])])];
  const hay = refs.map(r => JSON.stringify(registry.get(r.type, r.id)?.data || {}) + ' ' + r.id).join(' ');
  return tokens.filter(t => !hay.includes(t));
}

export function validateClaims(claims, registry, { strict = false } = {}) {
  const accepted = []; const rejected = [];
  for (const cl of claims) {
    if (!cl || typeof cl.text !== 'string' || !cl.text.trim()) { rejected.push({ claimId: cl?.id, reason: 'EMPTY_CLAIM' }); continue; }
    if (!Array.isArray(cl.refs) || cl.refs.length === 0) { rejected.push({ claimId: cl.id, reason: 'NO_LINKED_RECORD' }); continue; }
    const missing = cl.refs.filter(r => !registry.has(r.type, r.id));
    if (missing.length) { rejected.push({ claimId: cl.id, reason: 'UNKNOWN_RECORD', missing }); continue; }
    const holds = cl.refs.filter(r => r.type === 'refund' && registry.get(r.type, r.id)?.data?.proofpilot_classification !== 'SELLER_REFUND');
    if (holds.length) { rejected.push({ claimId: cl.id, reason: 'NOT_A_SELLER_REFUND', missing: holds }); continue; }
    if (strict) {
      if (OUTCOME_WORDS.test(cl.text)) { rejected.push({ claimId: cl.id, reason: 'OUTCOME_CLAIM' }); continue; }
      const bad = unsupportedValues(cl.text, cl.refs, registry);
      if (bad.length) { rejected.push({ claimId: cl.id, reason: 'VALUE_NOT_IN_CITED_RECORD', values: bad }); continue; }
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
    claims.map((c, i) => `${i + 1}. ${c.text} [${c.refs.map(r => `${r.type} ${r.id}`).join('; ')}]`).join('\n')).slice(0, 2000);
  const ev = { evidence_type: evidenceType, notes };
  if (evidenceType === 'PROOF_OF_FULFILLMENT') {
    const cited = new Set(claims.flatMap(c => c.refs.filter(r => r.type === 'tracker').map(r => r.id)));
    const ti = trackers.filter(t => cited.has(`${t.transaction_id}-${t.tracking_number}`))
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
