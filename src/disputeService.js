// Dispute analysis: live PayPal reads -> status, deadline, allowed evidence types, cited packs, recommendation.
import { adviseWithLlm } from './ai/advisor.js';
import { runAgent } from './ai/agent.js';
import { allowedEvidenceTypes, gatherRecords, buildPack, validateClaims, packHash, toEvidencePayload, packPdf, meetsRequirement } from './engine/evidence.js';
import { bindProposal, proposalHash, issueToken, tokenDigest, TEMPLATES } from './ai/proposals.js';
import { checkAmountWithin } from './lib/money.js';
import { refusalsFor, derivedRefusalRisks } from './lib/refusals.js';
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
  const paypalRejected = refusalsFor(dispute, store);
  const refusalRisks = derivedRefusalRisks(dispute);
  const recommendation = engine.recommend({ dispute, allowedTypes, packs, acceptBelow: engine.acceptBelow || 0, rejectedTypes: [...new Set(paypalRejected.map(r => r.type))] });
  const txn = dispute.disputed_transactions?.[0] || {};
  return {
    id: dispute.dispute_id, reason: dispute.reason, amount: dispute.dispute_amount, stage: dispute.dispute_life_cycle_stage,
    paypalStatus: dispute.status, state: dispute.dispute_state, createTime: dispute.create_time, updateTime: dispute.update_time,
    status, sandboxLinks: sandboxSimLinks(dispute), deadline: deadline(dispute), allowedTypes, packs, supporting, recommendation,
    transaction: { buyerTxn: txn.buyer_transaction_id, sellerTxn: txn.seller_transaction_id, protectionEligible: txn.seller_protection_eligible, protectionType: txn.seller_protection_type },
    records: recs.registry.list(), gaps: recs.gaps, trackers: recs.trackers,
    paypalRejected, refusalRisks,
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
    if (action === 'provide_evidence' && a.paypalRejected.some(r => r.type === type) && body.retryRefusedType !== true)
      throw new SubmitError('TYPE_REFUSED_BY_PAYPAL', `PayPal already refused ${type} on this dispute at this stage (EVIDENCE_TYPE_IS_NOT_ALLOWED). ProofPilot does not send it again.`, { refusals: a.paypalRejected });
    const pack = action === 'provide_evidence' ? a.packs[type] : a.supporting;
    // Seller may drop claims or add their own; custom claims must cite a fetched record or they are refused.
    const base = pack.validation.accepted.filter(c => !body.excludeClaimIds?.includes(c.id));
    const claims = [...base, ...(body.customClaims || []).map((c, i) => ({ id: c.id || `custom-${i + 1}`, text: c.text, refs: c.refs, ...(c.source === 'seller' ? { source: 'seller' } : {}) }))];
    const v = validateClaims(claims, a._ctx.recs.registry);
    if (!v.ok) throw new SubmitError('UNCITED_CLAIMS', 'The checker refused claims: each needs a linked PayPal record, and amounts, dates and ids must be in it.', { rejected: v.rejected });
    // Anything that is not one of ProofPilot's own pack claims and not marked as the seller's own wording (source:'seller')
    // must be exactly a fact rendered from the cited records: this covers AI sentences whatever their id, and the server
    // does not trust the client's word that a sentence came from the model.
    const builtIn = new Set(pack.validation.accepted.map(c => `${c.text}|${JSON.stringify(c.refs)}`));
    const mustBeFact = claims.filter(c => !builtIn.has(`${c.text}|${JSON.stringify(c.refs)}`) && c.source !== 'seller');
    const factCheck = validateClaims(mustBeFact, a._ctx.recs.registry, { strict: true });
    if (factCheck.rejected.length) throw new SubmitError('UNCITED_CLAIMS', 'The checker refused sentences that are not facts rendered from the cited PayPal records.', { rejected: factCheck.rejected });
    if (action === 'provide_evidence' && !meetsRequirement(type, v.accepted, a._ctx.recs.registry)) throw new SubmitError('REQUIREMENT_NOT_MET', `The pack does not contain the record ${type} needs.`, { gaps: pack.gaps });
    const hash = packHash(a.id, type, v.accepted);
    if (body.packHash !== hash) throw new SubmitError('PACK_CHANGED', 'The pack differs from what you approved. Review it again.', { expected: hash });
    const { input, notes } = toEvidencePayload(type, v.accepted, { trackers: a.trackers, registry: a._ctx.recs.registry });
    const pdf = packPdf([`ProofPilot evidence pack for dispute ${a.id} (PayPal sandbox)`, `Type: ${type}`, `Approved by seller at ${new Date().toISOString()}`, '', ...notes.split('\n')]);
    const files = body.attachPdf === false ? [] : [{ field: 'evidence_file', name: `proofpilot_${a.id}.pdf`, type: 'application/pdf', data: pdf }];
    payloadPreview = action === 'provide_evidence' ? input : { notes };
    call = () => action === 'provide_evidence' ? api.provideEvidence(id, input, files) : api.provideSupportingInfo(id, notes, files);
  } else if (action === 'accept_claim') {
    // Notes sent to PayPal are ProofPilot templates; free text from the request is not forwarded.
    payloadPreview = { note: TEMPLATES.acceptNote(a.id) };
    call = () => api.acceptClaim(id, payloadPreview.note);
  } else if (action === 'make_offer') {
    const c = checkAmountWithin({ value: body.offerAmount, currency_code: body.offerCurrency ?? a.amount.currency_code }, { currency: a.amount.currency_code, max: a.amount.value });
    if (!c.ok) throw new SubmitError('BAD_OFFER', `Offer must be a plain amount of at least 0.01 and at most the disputed ${a.amount.currency_code} ${a.amount.value}, in ${a.amount.currency_code}.`, { reason: c.reason });
    payloadPreview = { note: TEMPLATES.offerNote(a.id), amount: { currency_code: a.amount.currency_code, value: c.value } };
    call = () => api.makeOffer(id, payloadPreview);
  } else throw new SubmitError('UNSUPPORTED_ACTION', `ProofPilot does not submit ${action}.`);

  const approval = store.addApproval({ at: new Date().toISOString(), disputeId: id, action, evidenceType: body.evidenceType, packHash: body.packHash, dryRun: config.dryRun });
  if (config.dryRun) return { dryRun: true, before, after: before, payloadPreview, approval };
  let response;
  try { response = await call(); }
  catch (e) {
    if (e.issue === 'EVIDENCE_TYPE_IS_NOT_ALLOWED' && body.evidenceType) {
      store.data.rejectedTypes = store.data.rejectedTypes || {};
      (store.data.rejectedTypes[id] ||= []).push({ type: body.evidenceType, stage: a.stage, issue: e.issue, at: new Date().toISOString(), debugId: e.debugId, attachPdf: body.attachPdf !== false });
      store.save();
    }
    store.audit({ type: 'SUBMIT_REJECTED_BY_PAYPAL', disputeId: id, action, evidenceType: body.evidenceType, issue: e.issue, debugId: e.debugId });
    throw e;
  }
  const fresh = await api.getDispute(id);
  const after = { status: fresh.status, stage: fresh.dispute_life_cycle_stage, label: describeStatus(fresh).label };
  store.audit({ type: 'SUBMIT', disputeId: id, action, before, after });
  return { dryRun: false, before, after, payloadPreview, response: { links: (response?.links || []).map(l => l.rel) }, approval };
}

// AI advice for one dispute (on demand; cached per dispute update_time so the free tier is not wasted).
// With Gemini and PayPal credentials, this runs the PayPal Agent Toolkit agent (read tools autonomous, writes proposed
// only). Otherwise the plain JSON advisor. Both share the same checker and fallback (finishAdvice).
const aiCache = new Map();
export const heldWrites = new Map(); // proposal id -> { tool, args, execute } (server memory only, never sent to clients)
export async function aiAdvice({ api, store, engine, llm, agentTools }, id, { refresh = false } = {}) {
  const a = await analyseDispute({ api, store, engine }, id);
  const useAgent = Boolean(llm?.languageModel && agentTools);
  const key = `${id}|${a.updateTime}|${llm?.model || 'none'}|${useAgent ? 'agent' : 'plain'}`;
  // Agent runs are not cached: each run is logged with its own tool calls and proposals.
  if (!useAgent && !refresh && aiCache.has(key)) return { ...aiCache.get(key), cached: true };
  const ctx = { dispute: a._ctx.dispute, allowedTypes: a.allowedTypes, actions: a.status.actions,
    registry: a._ctx.recs.registry, packs: a.packs, rules: a.recommendation, rejectedTypes: [...new Set(a.paypalRejected.map(r => r.type))] };
  let out;
  if (useAgent) {
    out = await runAgent({ provider: llm, rawTools: typeof agentTools === 'function' ? agentTools() : agentTools, ctx, generateTextImpl: agentTools.generateTextImpl });
    const held = out._held || {}; delete out._held;
    const props = out.agent?.proposals || [];
    // A pending, executable proposal gets a server-issued single-use approval token bound to its id, hash and dispute.
    // Only the digest is stored with the proposal; the token itself stays in server memory and is shown to the seller
    // through the passcode-guarded agent route.
    for (const p of props) {
      if (p.status !== 'PENDING_SELLER_APPROVAL' || !p.executable) continue;
      const t = issueToken(p);
      p.tokenDigest = t.digest; p.tokenExpiresAt = t.expiresAt;
      heldWrites.set(p.id, { tool: p.tool, execute: held[p.tool] || null, token: t.token, badAttempts: 0 });
    }
    store.data.agentRuns ||= {};
    (store.data.agentRuns[id] ||= []).unshift({ at: new Date().toISOString(), model: llm.model, reportedModel: out.reportedModel || null, toolkit: out.agent?.toolkit, ok: out.ok,
      recommendation: out.recommendation, activity: out.agent?.activity || [], proposals: props, flags: out.flags || [], error: out.error });
    store.data.agentRuns[id] = store.data.agentRuns[id].slice(0, 10);
    store.save?.();
  } else out = await adviseWithLlm(llm, ctx);
  if (out.ok) aiCache.set(key, out);
  if (out.available) store.audit({ type: useAgent ? 'AGENT_RUN' : 'AI_ADVICE', disputeId: id, provider: out.provider, model: out.model, ok: out.ok,
    action: out.recommendation?.action, tools: (out.agent?.activity || []).map(x => `${x.kind}:${x.tool}`),
    refused: (out.narrative?.refused?.length || 0) + (out.rationale?.refused?.length || 0) });
  return out;
}

// Seller approval gate for agent proposals. To run, a proposal must:
//   1. be PENDING_SELLER_APPROVAL and executable, with its stored hash still matching its canonical arguments;
//   2. come with the server-issued single-use token for this proposal id + hash + dispute (consumed on first valid use;
//      five wrong tokens also void it);
//   3. bind again against a FRESH PayPal read of the dispute, giving the identical canonical hash.
// Only then does the held toolkit tool (or the offer call) run, with ProofPilot's canonical arguments and template notes.
export function pendingToken(proposalId) { return heldWrites.get(proposalId)?.token || null; }
export async function approveProposal({ api, store, engine, config }, proposalId, body) {
  const all = Object.values(store.data.agentRuns || {}).flat().flatMap(r => r.proposals || []);
  const p = all.find(x => x.id === proposalId);
  if (!p) throw new SubmitError('UNKNOWN_PROPOSAL', 'No such agent proposal.');
  if (body?.approved !== true) throw new SubmitError('NOT_APPROVED', 'Seller approval is required: send approved=true and the approval code shown on the proposal.');
  if (p.status !== 'PENDING_SELLER_APPROVAL') throw new SubmitError('NOT_PENDING', 'This proposal is not waiting for approval.', { status: p.status });
  if (!p.executable) throw new SubmitError('USE_EVIDENCE_APPROVAL', 'Evidence proposals are approved in the evidence pack panel (hash-bound).');
  const h = heldWrites.get(p.id);
  if (!h || !p.tokenDigest) throw new SubmitError('PROPOSAL_EXPIRED', 'This proposal has no live approval code (server restarted or already used). Ask the agent again.');
  if (proposalHash(p) !== p.hash) throw new SubmitError('PROPOSAL_CHANGED', 'The stored proposal no longer matches its hash.');
  if (new Date(p.tokenExpiresAt).getTime() < Date.now()) { heldWrites.delete(p.id); p.status = 'EXPIRED'; store.save?.(); throw new SubmitError('PROPOSAL_EXPIRED', 'The approval code expired. Ask the agent again.'); }
  if (typeof body.token !== 'string' || tokenDigest(body.token.trim(), p) !== p.tokenDigest) {
    if (++h.badAttempts >= 5) { heldWrites.delete(p.id); p.status = 'VOIDED'; store.save?.(); }
    store.audit({ type: 'AGENT_PROPOSAL_BAD_TOKEN', proposalId: p.id });
    throw new SubmitError('BAD_TOKEN', 'The approval code does not match this proposal.');
  }
  heldWrites.delete(p.id); // single use: consumed now, whatever happens next
  const a = await analyseDispute({ api, store, engine }, p.disputeId);
  const fresh = bindProposal(p.tool, p.canonical, { dispute: a._ctx.dispute, actions: a.status.actions, allowedTypes: a.allowedTypes,
    rejectedTypes: [...new Set(a.paypalRejected.map(r => r.type))], registry: a._ctx.recs.registry, final: { action: p.finalAction } });
  const freshHash = fresh.ok ? proposalHash({ ...p, canonical: fresh.canonical, bound: fresh.bound }) : null;
  if (!fresh.ok || freshHash !== p.hash) {
    p.status = 'BLOCKED_AT_APPROVAL'; p.blockedReasons = fresh.ok ? ['PAYPAL_DATA_CHANGED'] : fresh.reasons; store.save?.();
    store.audit({ type: 'AGENT_PROPOSAL_BLOCKED_AT_APPROVAL', proposalId: p.id, reasons: p.blockedReasons });
    throw new SubmitError('STALE_PROPOSAL', 'PayPal data changed since the proposal, or it no longer passes the checks. Nothing was sent.', { reasons: p.blockedReasons });
  }
  store.audit({ type: 'AGENT_PROPOSAL_APPROVED', proposalId: p.id, tool: p.tool, hash: p.hash, dryRun: Boolean(config.dryRun) });
  if (config.dryRun) { p.status = 'APPROVED_DRY_RUN'; store.save?.(); return { dryRun: true, proposal: p, sent: p.canonical }; }
  let result;
  if (p.tool === 'propose_make_offer') result = await api.makeOffer(p.disputeId, { note: p.canonical.note, amount: p.canonical.amount });
  else if (h.execute) result = await h.execute(p.canonical, {});
  else throw new SubmitError('PROPOSAL_EXPIRED', 'The toolkit tool for this proposal is not loaded.');
  p.status = 'EXECUTED_AFTER_APPROVAL'; p.executedAt = new Date().toISOString(); store.save?.();
  store.audit({ type: 'AGENT_PROPOSAL_EXECUTED', proposalId: p.id, tool: p.tool });
  return { dryRun: false, proposal: p, sent: p.canonical, result: JSON.parse(JSON.stringify(result ?? null)) };
}
