// Dispute analysis: live PayPal reads -> status, deadline, allowed evidence types, cited packs, recommendation.
import { allowedEvidenceTypes, gatherRecords, buildPack, validateClaims, packHash, toEvidencePayload, packPdf, meetsRequirement } from './engine/evidence.js';
import { describeStatus, deadline, sellerActions, sandboxSimLinks } from './engine/status.js';

export async function analyseDispute({ api, store, engine }, id) {
  const dispute = await api.getDispute(id);
  const status = describeStatus(dispute);
  const allowedTypes = allowedEvidenceTypes(dispute);
  const recs = await gatherRecords(api, dispute, store);
  const localOrder = recs.order ? store.getOrder(recs.order.id) : null;
  const packs = {};
  for (const t of allowedTypes) {
    const p = buildPack(t, { dispute, ...recs, localOrder });
    p.validation = validateClaims(p.claims, recs.registry);
    p.hash = packHash(dispute.dispute_id, t, p.validation.accepted);
    packs[t] = p;
  }
  // Supporting-info pack (no evidence type) for disputes under review that only accept extra information.
  let supporting = null;
  if (sellerActions(dispute).includes('provide_supporting_info')) {
    const p = buildPack('SUPPORTING_INFO', { dispute, ...recs, localOrder });
    p.validation = validateClaims(p.claims, recs.registry);
    p.hash = packHash(dispute.dispute_id, 'SUPPORTING_INFO', p.validation.accepted);
    supporting = p;
  }
  const recommendation = engine.recommend({ dispute, allowedTypes, packs, acceptBelow: engine.acceptBelow || 0 });
  const txn = dispute.disputed_transactions?.[0] || {};
  return {
    id: dispute.dispute_id, reason: dispute.reason, amount: dispute.dispute_amount, stage: dispute.dispute_life_cycle_stage,
    paypalStatus: dispute.status, state: dispute.dispute_state, createTime: dispute.create_time, updateTime: dispute.update_time,
    status, sandboxLinks: sandboxSimLinks(dispute), deadline: deadline(dispute), allowedTypes, packs, supporting, recommendation,
    transaction: { buyerTxn: txn.buyer_transaction_id, sellerTxn: txn.seller_transaction_id, protectionEligible: txn.seller_protection_eligible, protectionType: txn.seller_protection_type },
    records: recs.registry.list(), gaps: recs.gaps, trackers: recs.trackers,
    history: (dispute.evidences || []).map(e => ({ type: e.evidence_type, source: e.source, stage: e.dispute_life_cycle_stage, date: e.date, action: e.action_info?.action, notes: e.notes })),
    _ctx: { dispute, recs },
  };
}

export class SubmitError extends Error { constructor(code, message, extra = {}) { super(message); this.code = code; this.extra = extra; } }

// Submit only after explicit seller approval of the exact pack (hash-bound). Re-validates against live PayPal state.
export async function submitDecision({ api, store, engine, config }, id, body) {
  if (body?.approved !== true || body?.confirm !== 'APPROVE') throw new SubmitError('NOT_APPROVED', 'Seller approval is required: send approved=true and confirm="APPROVE".');
  const a = await analyseDispute({ api, store, engine }, id);
  const actions = a.status.actions;
  const action = body.action;
  if (!actions.includes(action)) throw new SubmitError('ACTION_NOT_OFFERED', `PayPal does not offer ${action} on this dispute right now. Offered: ${actions.join(', ') || 'none'}.`);
  const before = { status: a.paypalStatus, stage: a.stage, label: a.status.label };
  let call; let payloadPreview;

  if (action === 'provide_evidence' || action === 'provide_supporting_info') {
    const type = action === 'provide_evidence' ? body.evidenceType : 'SUPPORTING_INFO';
    if (action === 'provide_evidence' && !a.allowedTypes.includes(type))
      throw new SubmitError('TYPE_NOT_REQUESTED', `Evidence type ${type} is not requested by this dispute. Requested: ${a.allowedTypes.join(', ') || 'none'}.`);
    const pack = action === 'provide_evidence' ? a.packs[type] : a.supporting;
    // Seller may drop claims or add their own; custom claims must cite a fetched record or they are refused.
    const base = pack.validation.accepted.filter(c => !body.excludeClaimIds?.includes(c.id));
    const claims = [...base, ...(body.customClaims || []).map((c, i) => ({ id: c.id || `custom-${i + 1}`, text: c.text, refs: c.refs }))];
    const v = validateClaims(claims, a._ctx.recs.registry);
    if (!v.ok) throw new SubmitError('UNCITED_CLAIMS', 'The checker refused claims without a linked PayPal record.', { rejected: v.rejected });
    if (action === 'provide_evidence' && !meetsRequirement(type, v.accepted)) throw new SubmitError('REQUIREMENT_NOT_MET', `The pack does not contain the record ${type} needs.`, { gaps: pack.gaps });
    const hash = packHash(a.id, type, v.accepted);
    if (body.packHash !== hash) throw new SubmitError('PACK_CHANGED', 'The pack differs from what you approved. Review it again.', { expected: hash });
    const { input, notes } = toEvidencePayload(type, v.accepted, { trackers: a.trackers, registry: a._ctx.recs.registry });
    const pdf = packPdf([`ProofPilot evidence pack for dispute ${a.id} (PayPal sandbox)`, `Type: ${type}`, `Approved by seller at ${new Date().toISOString()}`, '', ...notes.split('\n')]);
    const files = [{ field: 'evidence_file', name: `proofpilot_${a.id}.pdf`, type: 'application/pdf', data: pdf }];
    payloadPreview = action === 'provide_evidence' ? input : { notes };
    call = () => action === 'provide_evidence' ? api.provideEvidence(id, input, files) : api.provideSupportingInfo(id, notes, files);
  } else if (action === 'accept_claim') {
    payloadPreview = { note: body.note || 'Seller accepted the claim via ProofPilot.' };
    call = () => api.acceptClaim(id, payloadPreview.note);
  } else if (action === 'make_offer') {
    const v = Number(body.offerAmount);
    if (!(v > 0) || v > Number(a.amount.value)) throw new SubmitError('BAD_OFFER', 'Offer amount must be above 0 and at most the disputed amount.');
    payloadPreview = { note: body.note || 'Seller offer via ProofPilot.', amount: { currency_code: a.amount.currency_code, value: v.toFixed(2) } };
    call = () => api.makeOffer(id, payloadPreview);
  } else throw new SubmitError('UNSUPPORTED_ACTION', `ProofPilot does not submit ${action}.`);

  const approval = store.addApproval({ at: new Date().toISOString(), disputeId: id, action, evidenceType: body.evidenceType, packHash: body.packHash, dryRun: config.dryRun });
  if (config.dryRun) return { dryRun: true, before, after: before, payloadPreview, approval };
  const response = await call();
  const fresh = await api.getDispute(id);
  const after = { status: fresh.status, stage: fresh.dispute_life_cycle_stage, label: describeStatus(fresh).label };
  store.audit({ type: 'SUBMIT', disputeId: id, action, before, after });
  return { dryRun: false, before, after, payloadPreview, response: { links: (response?.links || []).map(l => l.rel) }, approval };
}
