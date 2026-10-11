// Proposal binding. Every write the agent proposes is rebuilt here from PayPal data ProofPilot fetched itself:
//   - the dispute id, payment (capture) and order come from the dispute record, never from the model;
//   - amounts are parsed strictly, must be at least 0.01 and at most the disputed amount, in the dispute's currency;
//   - the action must match the run's FINAL recommendation (WAIT means nothing is executable) and PayPal must offer it;
//   - notes sent to PayPal (accept-claim note, refund note_to_payer, offer note) are ProofPilot templates;
//   - at most one executable proposal per run.
// The model's arguments are only compared, never forwarded: a proposal stores the canonical arguments and the NAMES of
// the fields the model supplied. bindProposal runs when the proposal is recorded and again on approval against a fresh
// PayPal read; the canonical hash must be identical both times.
import crypto from 'node:crypto';
import { checkAmountWithin } from '../lib/money.js';

// Which final recommendation each proposal tool is consistent with, and which PayPal seller action it needs (if any).
export const TOOL_RULES = {
  accept_dispute_claim: { finals: ['ACCEPT'], needs: 'accept_claim', executable: true },
  create_refund: { finals: ['ACCEPT'], needs: null, executable: true },
  propose_make_offer: { finals: ['OFFER'], needs: 'make_offer', executable: true },
  propose_provide_evidence: { finals: ['FIGHT'], needs: 'provide_evidence', executable: false }, // approved in the hash-bound pack panel
  create_shipment_tracking: { finals: [], needs: null, executable: false }, // tracking added during a dispute is not proof of shipment
};

// Templates. The accept note must match the toolkit's schema ^[A-Za-z0-9_-]{1,255}$ (no spaces).
export const TEMPLATES = {
  acceptNote: (disputeId) => `Seller-approved-accept-via-ProofPilot-${String(disputeId).replace(/[^A-Za-z0-9_-]/g, '')}`.slice(0, 255),
  refundNote: (disputeId) => `Refund for PayPal case ${disputeId}, approved by the seller in ProofPilot.`,
  offerNote: (disputeId) => `The seller offers this partial refund to resolve PayPal case ${disputeId}.`,
};

const amountOf = (args) => (args?.amount && typeof args.amount === 'object') ? args.amount : (args?.amount != null ? { value: args.amount } : null);

// ctx: { dispute, actions, allowedTypes, rejectedTypes, registry?, final: { action, evidenceType } }
export function bindProposal(tool, args, ctx) {
  const reasons = []; const rule = TOOL_RULES[tool];
  const d = ctx.dispute || {}; const disputeId = d.dispute_id;
  const txn = d.disputed_transactions?.[0] || {};
  const amount = d.dispute_amount || {};
  const orderRec = (ctx.registry?.list?.() || []).find(r => r.type === 'order');
  const bound = { disputeId, captureId: txn.seller_transaction_id || null, orderId: orderRec?.id || null,
    disputedAmount: { currency_code: amount.currency_code || null, value: amount.value || null } };
  if (!rule) return { ok: false, reasons: ['TOOL_NOT_PROPOSABLE'], canonical: null, bound };
  if (d.status === 'RESOLVED') reasons.push('DISPUTE_CLOSED');
  const final = ctx.final?.action;
  if (final === 'WAIT' || !final) reasons.push('WAIT_MEANS_NO_ACTION');
  else if (!rule.finals.includes(final)) reasons.push(tool === 'create_shipment_tracking' ? 'LATE_TRACKING_NOT_PROOF' : 'ACTION_INCONSISTENT_WITH_RECOMMENDATION');
  if (rule.needs && !(ctx.actions || []).includes(rule.needs)) reasons.push('ACTION_NOT_OFFERED');
  if (args?.dispute_id != null && String(args.dispute_id) !== disputeId) reasons.push('DIFFERENT_DISPUTE');
  if (args?.capture_id != null && String(args.capture_id) !== bound.captureId) reasons.push('DIFFERENT_CAPTURE');
  if (args?.transaction_id != null && String(args.transaction_id) !== bound.captureId) reasons.push('DIFFERENT_CAPTURE');
  if (args?.order_id != null && String(args.order_id) !== bound.orderId) reasons.push('DIFFERENT_ORDER');
  let canonical = null;
  if (tool === 'accept_dispute_claim') canonical = { dispute_id: disputeId, note: TEMPLATES.acceptNote(disputeId) };
  if (tool === 'create_refund') {
    if (!bound.captureId) reasons.push('NO_SELLER_CAPTURE');
    // No amount from the model means "the disputed amount"; any amount given is checked strictly.
    const a = amountOf(args) || { value: amount.value, currency_code: amount.currency_code };
    const c = checkAmountWithin({ value: a.value, currency_code: a.currency_code ?? amount.currency_code }, { currency: amount.currency_code, max: amount.value });
    if (!c.ok) reasons.push(c.reason);
    canonical = { capture_id: bound.captureId, amount: { currency_code: amount.currency_code, value: c.ok ? c.value : null }, note_to_payer: TEMPLATES.refundNote(disputeId) };
  }
  if (tool === 'propose_make_offer') {
    const a = amountOf(args);
    const c = a ? checkAmountWithin({ value: a.value, currency_code: a.currency_code ?? amount.currency_code }, { currency: amount.currency_code, max: amount.value }) : { ok: false, reason: 'AMOUNT_NOT_A_PLAIN_DECIMAL' };
    if (!c.ok) reasons.push(c.reason);
    canonical = { dispute_id: disputeId, amount: { currency_code: amount.currency_code, value: c.ok ? c.value : null }, note: TEMPLATES.offerNote(disputeId), offer_type: 'REFUND' };
  }
  if (tool === 'propose_provide_evidence') {
    const t = String(args?.evidence_type || '');
    if (!(ctx.allowedTypes || []).includes(t)) reasons.push('TYPE_NOT_REQUESTED');
    else if ((ctx.rejectedTypes || []).includes(t)) reasons.push('TYPE_REFUSED_BY_PAYPAL');
    else if (final === 'FIGHT' && ctx.final?.evidenceType && ctx.final.evidenceType !== t) reasons.push('ACTION_INCONSISTENT_WITH_RECOMMENDATION');
    canonical = { dispute_id: disputeId, evidence_type: (ctx.allowedTypes || []).includes(t) ? t : null };
  }
  if (tool === 'create_shipment_tracking') canonical = null;
  return { ok: reasons.length === 0, reasons: [...new Set(reasons)], canonical, bound };
}

export function proposalHash({ id, disputeId, tool, canonical, bound }) {
  return crypto.createHash('sha256').update(JSON.stringify({ id, disputeId, tool, canonical, bound })).digest('hex');
}

// Plain-words description shown to the seller (built from canonical args only).
export function describeProposal(tool, canonical, bound) {
  const money = (a) => a?.value ? `${a.currency_code} ${a.value}` : 'an invalid amount';
  switch (tool) {
    case 'accept_dispute_claim': return `Accept the claim on case ${bound.disputeId}. PayPal refunds the buyer the disputed ${money(bound.disputedAmount)} and the case closes.`;
    case 'create_refund': return `Refund ${money(canonical?.amount)} to the buyer on payment ${bound.captureId || '(none)'} for case ${bound.disputeId}.`;
    case 'propose_make_offer': return `Offer the buyer a refund of ${money(canonical?.amount)} on case ${bound.disputeId}.`;
    case 'propose_provide_evidence': return `Send evidence on case ${bound.disputeId}. You review and approve the evidence pack first.`;
    case 'create_shipment_tracking': return 'Add shipment tracking to the order.';
    default: return 'An action ProofPilot does not run.';
  }
}

// Approval tokens: server-issued, single use, bound to proposal id + proposal hash + dispute id. Only a digest is kept.
export const tokenDigest = (token, p) => crypto.createHash('sha256').update(`${token}|${p.id}|${p.hash}|${p.disputeId}`).digest('hex');
export function issueToken(p) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(10); let s = '';
  for (const b of bytes) s += alphabet[b % alphabet.length];
  const token = `APPROVE-${s.slice(0, 5)}-${s.slice(5)}`;
  return { token, digest: tokenDigest(token, p), expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString() };
}
