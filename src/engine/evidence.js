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
    add(type, id, data, source) { if (id) map.set(recordKey(type, id), { type, id, source, verified: true, fetchedAt: new Date().toISOString(), data }); },
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
      for (const tr of trackers) reg.add('tracker', `${tr.transaction_id}-${tr.tracking_number}`, tr, 'GET /v1/shipping/trackers');
    } catch (e) { gaps.push({ code: 'TRACKERS_UNAVAILABLE', message: `Could not read trackers: ${e.issue || e.message}` }); }
    for (const r of order?.purchase_units?.[0]?.payments?.refunds || [])
      reg.add('refund', r.id, r, 'GET /v2/checkout/orders/{id} (payments.refunds)');
  } else gaps.push({ code: 'NO_SELLER_TXN', message: 'Dispute lists no seller transaction id.' });
  return { registry: reg, capture, order, trackers, gaps };
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
      c(`tracker-${t.tracking_number}`, `Shipped with ${t.carrier}${t.carrier_name_other ? ` (${t.carrier_name_other})` : ''}, tracking ${t.tracking_number}, registered with PayPal (status ${t.status}).`,
        [{ type: 'tracker', id: `${t.transaction_id}-${t.tracking_number}` }]);
    }
    if (trackers.length && addr && localOrder?.shippedTo && localOrder.shippedToMatchesOrder)
      c('shipped-to-order-address', 'The parcel was shipped to the address on the PayPal order (pre-ship check passed).',
        [{ type: 'order', id: order.id }, { type: 'tracker', id: `${trackers[0].transaction_id}-${trackers[0].tracking_number}` }]);
  }
  if (evidenceType === 'PROOF_OF_REFUND') {
    const done = (order?.purchase_units?.[0]?.payments?.refunds || []).filter(r => r.status === 'COMPLETED');
    if (!done.length) gaps.push({ code: 'NO_COMPLETED_REFUND', message: 'No completed refund exists on this order, so proof of refund cannot be claimed.' });
    for (const r of done) c(`refund-${r.id}`, `Refund ${r.id} of ${money(r.amount)} completed.`, [{ type: 'refund', id: r.id }]);
  }
  return { evidenceType, claims, gaps, requirementMet: meetsRequirement(evidenceType, claims) };
}

export function meetsRequirement(type, claims) {
  if (type === 'PROOF_OF_FULFILLMENT') return claims.some(c => c.refs.some(r => r.type === 'tracker'));
  if (type === 'PROOF_OF_REFUND') return claims.some(c => c.refs.some(r => r.type === 'refund'));
  return claims.length > 0;
}

// ---- The checker. Refuses any claim with no linked record, or a link to a record we did not fetch.
export function validateClaims(claims, registry) {
  const accepted = []; const rejected = [];
  for (const cl of claims) {
    if (!cl || typeof cl.text !== 'string' || !cl.text.trim()) { rejected.push({ claimId: cl?.id, reason: 'EMPTY_CLAIM' }); continue; }
    if (!Array.isArray(cl.refs) || cl.refs.length === 0) { rejected.push({ claimId: cl.id, reason: 'NO_LINKED_RECORD' }); continue; }
    const missing = cl.refs.filter(r => !registry.has(r.type, r.id));
    if (missing.length) { rejected.push({ claimId: cl.id, reason: 'UNKNOWN_RECORD', missing }); continue; }
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
  const notes = ('ProofPilot evidence pack. Each statement cites a PayPal record id.\n' +
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
