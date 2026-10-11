// AI dispute advisor. The model (Gemini or Groq) recommends FIGHT / OFFER / ACCEPT / WAIT with a rationale and drafts
// the evidence narrative. Guardrails, in order:
//   1. The model only sees records ProofPilot fetched from PayPal, and must cite them inline as [type:id].
//   2. Every sentence is checked on its own by validateClaims(strict): it must cite a fetched record, any amount or id
//      it states must appear in the cited record, and it may not predict an outcome. Failing sentences are dropped and
//      shown as refused.
//   3. The recommendation must be an action PayPal currently offers, and is compared with the rules engine
//      (proofpilot-rules-v1). If the model says FIGHT without a complete pack, the rules engine's answer is used instead.
//   4. The seller still approves the exact pack before anything is sent.
import { validateClaims } from '../engine/evidence.js';
import { human } from '../engine/labels.js';

export const SYSTEM_PROMPT = [
  'You are ProofPilot, an assistant for small online sellers handling a PayPal dispute in the PayPal SANDBOX.',
  'Use ONLY the records provided. Every sentence you write must end with one or more citations in the form [type:id] using the exact type and id of a provided record.',
  'Do not state any amount, date, id or tracking number that is not in the record you cite. Do not invent facts, documents or customer statements.',
  'Never predict, promise or describe the outcome of the case. Do not give legal advice.',
  'Choose "action" only from the allowed_actions list. Choose "evidence_type" only from requested_evidence_types, or null.',
  'Reply with JSON only: {"action":"FIGHT|OFFER|ACCEPT|WAIT","evidence_type":string|null,"rationale":[string],"narrative":[string],"offer_amount":string|null}.',
  'rationale: 2-4 short sentences explaining the choice to the seller (with citations). narrative: 2-6 sentences for PayPal, written as the seller, one fact per sentence (with citations).',
].join('\n');

const ACTION_NEEDS = { FIGHT: 'provide_evidence', OFFER: 'make_offer', ACCEPT: 'accept_claim', WAIT: null };

// Record digests sent to the model: only fields useful for the case, no buyer/seller emails or names.
export function digestRecords(registry) {
  return registry.all().map(r => {
    const d = r.data || {}; let facts = {};
    if (r.type === 'dispute') facts = { reason: d.reason, reason_plain: human('reason', d.reason), status: d.status, stage: d.dispute_life_cycle_stage,
      amount: d.dispute_amount, seller_response_due_date: d.seller_response_due_date, seller_protection: d.disputed_transactions?.[0]?.seller_protection_type,
      requested_from_seller: (d.evidences || []).filter(e => e.source === 'REQUESTED_FROM_SELLER').map(e => e.evidence_type),
      previous_seller_submissions: (d.evidences || []).filter(e => e.source === 'SUBMITTED_BY_SELLER').map(e => ({ type: e.evidence_type, date: e.date, stage: e.dispute_life_cycle_stage })) };
    if (r.type === 'capture') facts = { amount: d.amount, status: d.status, status_reason: d.status_details?.reason, create_time: d.create_time, seller_protection: d.seller_protection };
    if (r.type === 'order') { const pu = d.purchase_units?.[0] || {}; facts = { status: d.status, amount: pu.amount, description: pu.description, ship_to: pu.shipping?.address }; }
    if (r.type === 'tracker') facts = { carrier: d.carrier, tracking_number: d.tracking_number, status: d.status, shipment_date: d.shipment_date };
    if (r.type === 'refund') facts = { amount: d.amount, status: d.status, create_time: d.create_time, classification: d.proofpilot_classification };
    return { type: r.type, id: r.id, note: r.note || undefined, facts };
  });
}

// "Sentence [order:ABC]. Next one [capture:X][dispute:Y]." -> [{ text, refs }]
export function parseCitedSentences(items, prefix) {
  const out = [];
  for (const item of Array.isArray(items) ? items : [items].filter(Boolean)) {
    // Sentence boundary = ., !, ? or a closing citation, then whitespace, then a capital letter. "5.50" is not split.
    const segs = String(item).split(/(?<=[.!?\]])\s+(?=[A-Z"'(])/);
    const merged = [];
    for (const seg of segs) { if (/^\s*\[/.test(seg) && merged.length) merged[merged.length - 1] += ' ' + seg; else merged.push(seg); }
    for (const raw of merged) {
      const s = raw.trim(); if (!s) continue;
      const refs = [...s.matchAll(/\[([a-z_]+):([^\]\s]+)\]/gi)].map(m => ({ type: m[1].toLowerCase(), id: m[2] }));
      const text = s.replace(/\s*\[[a-z_]+:[^\]]+\]/gi, '').replace(/\s+([.!?])/g, '$1').trim();
      out.push({ id: `${prefix}-${out.length + 1}`, text, refs, source: 'ai' });
    }
  }
  return out;
}

export function buildUserPrompt({ dispute, allowedTypes, actions, registry, rules }) {
  const allowed = ['WAIT', ...Object.entries(ACTION_NEEDS).filter(([, l]) => l && actions.includes(l)).map(([a]) => a)];
  return JSON.stringify({
    task: 'Recommend what the seller should do and draft the evidence narrative.',
    dispute_id: dispute.dispute_id, reason: dispute.reason, reason_plain: human('reason', dispute.reason),
    amount: dispute.dispute_amount, paypal_status: dispute.status, stage: dispute.dispute_life_cycle_stage,
    allowed_actions: allowed, requested_evidence_types: allowedTypes,
    records: digestRecords(registry),
    rules_engine_recommendation: { action: rules.action, evidence_type: rules.evidenceType || null, reasons: rules.reasons },
  }, null, 1);
}

export async function adviseWithLlm(provider, { dispute, allowedTypes, actions, registry, packs, rules }) {
  if (!provider) return { available: false, reason: 'No LLM key configured (set GEMINI_API_KEY or GROQ_API_KEY).' };
  const started = Date.now();
  let raw;
  try { raw = await provider.completeJSON({ system: SYSTEM_PROMPT, user: buildUserPrompt({ dispute, allowedTypes, actions, registry, rules }) }); }
  catch (e) { return { available: true, ok: false, provider: provider.provider, model: provider.model, label: provider.label, error: e.message, fallback: rules }; }
  const j = raw.json || {};
  const flags = [];
  let action = String(j.action || '').toUpperCase();
  if (!(action in ACTION_NEEDS)) { flags.push(`Model returned an unknown action "${j.action}".`); action = null; }
  else if (ACTION_NEEDS[action] && !actions.includes(ACTION_NEEDS[action])) { flags.push(`Model chose ${action}, but PayPal does not offer ${ACTION_NEEDS[action]} on this dispute.`); action = null; }
  let evidenceType = j.evidence_type || null;
  if (evidenceType && !allowedTypes.includes(evidenceType)) { flags.push(`Model chose evidence type ${evidenceType}, which this dispute does not request.`); evidenceType = null; }
  if (action === 'FIGHT' && !(evidenceType && packs[evidenceType]?.requirementMet)) {
    flags.push('Sanity check: FIGHT needs a requested evidence type with a complete, cited pack. Using the rules engine instead.'); action = null;
  }
  const narrative = validateClaims(parseCitedSentences(j.narrative, 'ai'), registry, { strict: true });
  const rationale = validateClaims(parseCitedSentences(j.rationale, 'ai-why'), registry, { strict: true });
  const final = action ? { action, evidenceType: action === 'FIGHT' ? evidenceType : null, source: 'llm' }
    : { action: rules.action, evidenceType: rules.evidenceType || null, source: 'rules-fallback' };
  const sentences = (list) => list.map(c => ({ id: c.id, text: c.text, refs: c.refs }));
  const textById = (arr) => Object.fromEntries(arr.map(c => [c.id, c.text]));
  const nT = textById(parseCitedSentences(j.narrative, 'ai')); const rT = textById(parseCitedSentences(j.rationale, 'ai-why'));
  return {
    available: true, ok: true, provider: provider.provider, model: provider.model, label: provider.label, ms: Date.now() - started,
    generatedAt: new Date().toISOString(),
    recommendation: final, modelAction: j.action || null, agreesWithRules: final.action === rules.action, rules: { action: rules.action, evidenceType: rules.evidenceType || null },
    offerAmount: j.offer_amount || null, flags,
    rationale: { accepted: sentences(rationale.accepted), refused: rationale.rejected.map(r => ({ ...r, text: rT[r.claimId] })) },
    narrative: { accepted: sentences(narrative.accepted), refused: narrative.rejected.map(r => ({ ...r, text: nT[r.claimId] })) },
  };
}
