// Decision engine: recommends FIGHT / OFFER / ACCEPT / WAIT for a dispute.
//
// INTERFACE (the LLM hook): any engine is an object { name, kind, recommend(context) } where
//   context = { dispute, status, allowedTypes, packs: { [evidenceType]: { claims, gaps, requirementMet, validation } }, acceptBelow }
//   returns   { action: 'FIGHT'|'OFFER'|'ACCEPT'|'WAIT', evidenceType?, reasons: string[], availableActions: string[], engine }
// An LLM-backed engine may only re-rank or explain; it must return claims that pass validateClaims() unchanged,
// and the seller must still approve. No LLM key is configured in this build, so the default is the deterministic
// rules engine below. It is NOT AI and the UI labels it "rules engine". Since v0.2 the LLM advisor (src/ai/advisor.js)
// runs on top of it when GEMINI_API_KEY or GROQ_API_KEY is set; this engine stays as the fallback and the sanity check.
import { sellerActions } from './status.js';
import { human } from './labels.js';
const ev = (t) => `"${human('evidence', t)}"`;
const evList = (ts) => ts.map(ev).join(', ');

export const rulesEngine = {
  name: 'proofpilot-rules-v1',
  kind: 'deterministic',
  recommend({ dispute, allowedTypes = [], packs = {}, acceptBelow = 0, rejectedTypes = [] }) {
    const actions = sellerActions(dispute);
    const amount = Number(dispute?.dispute_amount?.value || 0);
    const cur = dispute?.dispute_amount?.currency_code || '';
    const base = { availableActions: actions, engine: this.name };
    const can = (a) => actions.includes(a);

    if (!can('provide_evidence') && !can('accept_claim') && !can('make_offer')) {
      const reasons = dispute?.status === 'OPEN'
        ? ['PayPal has not offered any seller actions yet (new disputes take about 3 to 5 minutes).']
        : [`PayPal status: ${human('paypalStatus', dispute?.status)}. PayPal offers no evidence, offer or accept action right now.`];
      if (can('provide_supporting_info')) reasons.push('You can still add supporting information, but the case is under PayPal review.');
      return { ...base, action: 'WAIT', reasons };
    }
    if (dispute?.status === 'UNDER_REVIEW' && !can('provide_evidence')) {
      const sent = (dispute?.evidences || []).some(e => e?.source === 'SUBMITTED_BY_SELLER');
      const reasons = [sent ? 'Under PayPal review: your evidence is with PayPal and no evidence request is open.'
        : 'Under PayPal review: no evidence from you is on this case, and PayPal has not opened an evidence request.',
        'Accepting now would refund the buyer while PayPal is still reviewing, so ProofPilot does not recommend it.'];
      if (can('provide_supporting_info')) reasons.push('You can add supporting information if you have new records.');
      return { ...base, action: 'WAIT', reasons };
    }
    const strong = allowedTypes.filter(t => packs[t]?.requirementMet && packs[t]?.validation?.ok && !rejectedTypes.includes(t));
    const reasons = rejectedTypes.length ? [`PayPal already refused ${evList(rejectedTypes)} on this dispute (it said that evidence type is not allowed), so ProofPilot does not recommend sending it again.`] : [];
    if (dispute?.reason === 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED' && strong.includes('PROOF_OF_FULFILLMENT') && can('provide_evidence')) {
      reasons.push('Reason is item not received, and PayPal has a registered tracker for this capture.');
      reasons.push(`PayPal asked for ${ev('PROOF_OF_FULFILLMENT')} and every claim in the pack links to a PayPal record.`);
      return { ...base, action: 'FIGHT', evidenceType: 'PROOF_OF_FULFILLMENT', reasons };
    }
    if (strong.length && can('provide_evidence')) {
      reasons.push(`A fully cited pack exists for the requested ${ev(strong[0])}.`);
      return { ...base, action: 'FIGHT', evidenceType: strong[0], reasons };
    }
    const gapCount = allowedTypes.flatMap(t => packs[t]?.gaps || []).length;
    reasons.push(allowedTypes.length ? `None of the requested evidence (${evList(allowedTypes)}) can be backed by PayPal records${gapCount ? ' (see the gaps listed with the evidence pack)' : ''}.` : 'PayPal has not requested any evidence type.');
    if (amount <= acceptBelow && can('accept_claim')) {
      reasons.push(`Amount ${cur} ${amount.toFixed(2)} is at or below your accept threshold (${cur} ${acceptBelow.toFixed(2)}).`);
      return { ...base, action: 'ACCEPT', reasons };
    }
    if (can('make_offer')) { reasons.push('An offer can settle the case without a full refund. You set the amount.'); return { ...base, action: 'OFFER', reasons }; }
    if (can('accept_claim')) { reasons.push('ProofPilot has nothing record-backed to send for what PayPal asked. Accepting refunds the buyer and ends your work on the case; the choice is yours before the deadline.'); return { ...base, action: 'ACCEPT', reasons }; }
    return { ...base, action: 'WAIT', reasons: [...reasons, 'No suitable action is offered.'] };
  },
};

export function createDecisionEngine(env = process.env) {
  return { ...rulesEngine, acceptBelow: Number(env.PROOFPILOT_ACCEPT_BELOW || 0) };
}
