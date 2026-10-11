// Plain-language dispute status. ProofPilot never claims a dispute was won: the sandbox never adjudicates,
// and even in production the outcome is PayPal's decision.
import { linkRels } from '../paypal/api.js';

export const SELLER_ACTIONS = ['provide_evidence', 'provide_supporting_info', 'accept_claim', 'make_offer', 'escalate', 'send_message', 'acknowledge_return_item'];

// Sandbox-only simulation links (PayPal's side of the case). ProofPilot never calls adjudicate.
export const SANDBOX_SIM_LINKS = ['require_evidence', 'adjudicate'];
export function sandboxSimLinks(dispute) { return linkRels(dispute).filter(r => SANDBOX_SIM_LINKS.includes(r)); }

export function sellerActions(dispute) { return linkRels(dispute).filter(r => SELLER_ACTIONS.includes(r)); }

export function describeStatus(dispute, now = Date.now()) {
  const actions = sellerActions(dispute);
  const status = dispute?.status;
  let label; let tone; let waiting = false;
  if (status === 'OPEN' && actions.length === 0) {
    const ageMin = (now - Date.parse(dispute.create_time || now)) / 60000;
    label = 'Waiting for PayPal'; tone = 'wait'; waiting = true;
    return { label, tone, waiting, actions, detail: `New disputes usually take 3 to 5 minutes before PayPal offers any seller actions (this one is ${Math.max(0, ageMin).toFixed(1)} min old). ProofPilot polls automatically.` };
  }
  switch (status) {
    case 'WAITING_FOR_SELLER_RESPONSE': label = 'Your response needed'; tone = 'act'; break;
    case 'WAITING_FOR_BUYER_RESPONSE': label = 'Waiting for buyer'; tone = 'wait'; break;
    case 'UNDER_REVIEW': label = 'Under PayPal review'; tone = 'review'; break;
    case 'RESOLVED': label = 'Closed by PayPal'; tone = 'closed'; break;
    case 'OTHER': label = 'PayPal status: other'; tone = 'wait'; break;
    default: label = status ? `PayPal status: ${status}` : 'Unknown'; tone = 'wait';
  }
  const detail = status === 'UNDER_REVIEW'
    ? 'PayPal is reviewing the case. ProofPilot does not predict or claim an outcome.'
    : status === 'RESOLVED' ? 'PayPal closed this case. Check the outcome in PayPal. ProofPilot does not interpret or predict outcomes.' : '';
  return { label, tone, waiting, actions, detail };
}

export function deadline(dispute, now = Date.now()) {
  const due = dispute?.seller_response_due_date;
  if (!due) return null;
  const hoursLeft = (Date.parse(due) - now) / 3_600_000;
  return { due, hoursLeft: Math.round(hoursLeft * 10) / 10, overdue: hoursLeft < 0, urgent: hoursLeft >= 0 && hoursLeft < 48 };
}
