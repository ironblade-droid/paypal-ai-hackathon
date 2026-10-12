// Dispute analysis: live PayPal reads -> status, deadline, allowed evidence types, cited packs, recommendation.
import crypto from 'node:crypto';
import { adviseWithLlm } from './ai/advisor.js';
import { runAgent } from './ai/agent.js';
import { allowedEvidenceTypes, gatherRecords, buildPack, validateClaims, packHash, toEvidencePayload, packPdf, meetsRequirement } from './engine/evidence.js';
import { bindProposal, proposalHash, issueToken, tokenDigest, TEMPLATES } from './ai/proposals.js';
import { checkAmountWithin, parseAmount } from './lib/money.js';
import { refusalsFor, derivedRefusalRisks } from './lib/refusals.js';
import { human } from './engine/labels.js';
import { redact } from './lib/redact.js';
import { removeApprovalCodeFile, deliverApprovalCode } from './lib/approvalCodes.js';
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
    p.hash = packHash(dispute.dispute_id, t, defaultSelection(p.validation.accepted));
    packs[t] = p;
  }
  // Supporting-info pack (no evidence type) for disputes under review that only accept extra information.
  let supporting = null;
  if (sellerActions(dispute).includes('provide_supporting_info')) {
    const p = buildPack('SUPPORTING_INFO', { dispute, ...recs, localOrder });
    p.validation = validateClaims(p.claims, recs.registry);
    p.hash = packHash(dispute.dispute_id, 'SUPPORTING_INFO', defaultSelection(p.validation.accepted));
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

// What is ticked by default: every checked statement except buyer-entered quotes (those are opt-in only).
export const defaultSelection = (accepted) => accepted.filter(c => !c.untrusted);

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
    // Buyer-entered quotes are never included unless the seller ticked them explicitly (includeClaimIds).
    const base = pack.validation.accepted.filter(c => c.untrusted ? (Array.isArray(body.includeClaimIds) && body.includeClaimIds.includes(c.id)) : !body.excludeClaimIds?.includes(c.id));
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

  // Money-moving manual actions share the per-dispute ledger with agent proposals (pending agent proposals do not block
  // the seller's own action, but they cannot run after it).
  const manualKind = action === 'accept_claim' ? 'accept' : action === 'make_offer' ? 'offer' : null;
  if (manualKind && !config.dryRun) {
    const reasons = writeBlockers(store, id, { kind: manualKind, disputedValue: a.amount?.value, registry: a._ctx.recs.registry, countPending: false })
      .filter(r => r !== 'DISPUTE_ALREADY_HAS_A_WRITE' || writeLedger(store, id).some(w => !w.dryRun && !w.failed && w.kind !== 'offer')); // an earlier offer does not stop the seller accepting
    if (reasons.length) throw new SubmitError('ONE_WRITE_PER_DISPUTE', 'ProofPilot already sent a refund or accept on this dispute (or one is running), or this would exceed the disputed amount.', { reasons });
  }
  const approval = store.addApproval({ at: new Date().toISOString(), disputeId: id, action, evidenceType: body.evidenceType, packHash: body.packHash, dryRun: config.dryRun });
  if (config.dryRun) return { dryRun: true, before, after: before, payloadPreview, approval };
  if (manualKind) { if (writesInFlight.has(id)) throw new SubmitError('ONE_WRITE_PER_DISPUTE', 'Another write on this dispute is running.', { reasons: ['WRITE_IN_PROGRESS'] });
    writesInFlight.add(id); }
  let manualEntry = null;
  if (manualKind) {
    // Cross-process: re-check and record under the store lock after re-reading the ledger from disk (review v0.5 a).
    const again = (store.transaction || ((f) => f()))(() => {
      const r = writeBlockers(store, id, { kind: manualKind, disputedValue: a.amount?.value, registry: a._ctx.recs.registry, countPending: false })
        .filter(x => x !== 'WRITE_IN_PROGRESS' && (x !== 'DISPUTE_ALREADY_HAS_A_WRITE' || writeLedger(store, id).some(w => !w.dryRun && !w.failed && w.kind !== 'offer')));
      if (r.length) return r;
      manualEntry = { id: 'w-' + crypto.randomUUID().slice(0, 12), at: new Date().toISOString(), disputeId: id, captureId: a.transaction?.sellerTxn || null, source: 'seller-manual', action, kind: manualKind,
        amount: manualKind === 'accept' ? a.amount : payloadPreview.amount };
      writeLedger(store, id).push(manualEntry); return [];
    });
    if (again.length) { writesInFlight.delete(id); throw new SubmitError('ONE_WRITE_PER_DISPUTE', 'ProofPilot already sent a refund or accept on this dispute (or one is running), or this would exceed the disputed amount.', { reasons: again }); }
  }
  try { return await sendDecision({ api, store, config }, { id, a, action, body, before, call, payloadPreview, approval }); }
  catch (e) {
    // PayPal refused it (4xx with an issue code): nothing happened, so the ledger entry does not count. Anything else
    // (timeout, 5xx) stays counted: fail closed.
    if (manualEntry && e?.issue && e.status >= 400 && e.status < 500) updateWrite(store, manualEntry.id, { failed: true, failure: e.issue });
    throw e;
  }
  finally { if (manualKind) writesInFlight.delete(id); }
}
async function sendDecision({ api, store }, { id, a, action, body, before, call, payloadPreview, approval }) {
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

// ---------- One write per dispute (review v0.4, finding 2)
// A dispute may have at most ONE live (pending, approvable) or executed money/state-changing agent write. ProofPilot's
// own executed writes are kept in a per-dispute ledger (store.data.disputeWrites), and refunds already returned to the
// buyer are counted against the disputed amount, so the total can never exceed it. Checked when a proposal is recorded,
// again synchronously at approval (before any await, with an in-flight lock per dispute), and on the manual
// accept / offer path.
const writesInFlight = new Set();
const cents = (v) => parseAmount(String(v ?? ''))?.cents ?? null;
export function writeLedger(store, disputeId) { store.data.disputeWrites ||= {}; return (store.data.disputeWrites[disputeId] ||= []); }
const allLedgerEntries = (store) => Object.values(store.data.disputeWrites || {}).flat();
function recordWrite(store, disputeId, entry) {
  const w = { id: 'w-' + crypto.randomUUID().slice(0, 12), at: new Date().toISOString(), disputeId, ...entry };
  writeLedger(store, disputeId).push(w); store.save?.(); return w;
}
// Find a ledger entry by id (after a reload the arrays may be new objects) and patch it.
function updateWrite(store, id, patch) {
  const w = allLedgerEntries(store).find(x => x.id === id); if (!w) return null;
  Object.assign(w, patch, { updatedAt: new Date().toISOString() }); store.save?.(); return w;
}
const proposalsFor = (store, disputeId) => (store.data.agentRuns?.[disputeId] || []).flatMap(r => r.proposals || []);
function isLive(p) {
  if (p.status !== 'PENDING_SELLER_APPROVAL' || !p.executable || !heldWrites.has(p.id)) return false;
  return !(p.tokenExpiresAt && Date.parse(p.tokenExpiresAt) < Date.now());
}
const counts = (w, exceptEntryId) => !w.dryRun && !w.failed && w.id !== exceptEntryId && (w.kind === 'refund' || w.kind === 'accept');
// Refund records PayPal reports on the order that are money going back to the buyer: completed AND pending seller
// refunds (review v0.5 b). PayPal's dispute hold is not a refund and is never counted.
const PAYPAL_MONEY_OUT = new Set(['SELLER_REFUND', 'SELLER_REFUND_PENDING']);
function paypalRefunded(registry) {
  return (registry?.all?.() || []).filter(r => r.type === 'refund' && PAYPAL_MONEY_OUT.has(r.data?.proofpilot_classification)).reduce((n, r) => n + (cents(r.data.amount?.value) || 0), 0);
}
const captureOf = (registry) => (registry?.all?.() || []).find(r => r.type === 'capture') || null;
// Money already returned to the buyer, per PAYMENT (capture), not per dispute (review v0.5 b): every ProofPilot
// refund/accept recorded against this capture on ANY dispute, or the refunds PayPal reports on the order, whichever is
// larger (one refund can appear in both, so they are not added up). Without a known capture id it falls back to this
// dispute's own ledger.
export function refundedSoFar(store, disputeId, registry = null, { captureId = null, exceptEntryId = null } = {}) {
  const cap = captureId || captureOf(registry)?.id || null;
  const ledger = allLedgerEntries(store).filter(w => counts(w, exceptEntryId) && (w.disputeId === disputeId || (cap && w.captureId === cap)));
  const own = writeLedger(store, disputeId).filter(w => counts(w, exceptEntryId) && !ledger.includes(w));
  const fromLedger = [...ledger, ...own].reduce((n, w) => n + (cents(w.amount?.value) || 0), 0);
  return Math.max(fromLedger, paypalRefunded(registry));
}
const KIND = { create_refund: 'refund', accept_dispute_claim: 'accept', propose_make_offer: 'offer' };
function moneyOut(kind, amountValue, disputedValue) { return kind === 'refund' ? (cents(amountValue) ?? Infinity) : kind === 'accept' ? (cents(disputedValue) ?? Infinity) : 0; }
// Reasons a new write on this dispute must not go ahead. exceptId: the proposal being approved itself; exceptEntryId:
// its own ledger reservation. The cap is the disputed amount AND, when known, the captured amount of the payment.
export function writeBlockers(store, disputeId, { kind, amountValue, disputedValue, registry = null, captureId = null, captureValue = null, exceptId = null, exceptEntryId = null, countPending = true }) {
  const reasons = [];
  const executed = writeLedger(store, disputeId).filter(w => !w.dryRun && !w.failed && w.id !== exceptEntryId);
  if (executed.length) reasons.push('DISPUTE_ALREADY_HAS_A_WRITE');
  if (countPending && proposalsFor(store, disputeId).some(p => p.id !== exceptId && isLive(p))) reasons.push('ANOTHER_PROPOSAL_PENDING');
  if (writesInFlight.has(disputeId)) reasons.push('WRITE_IN_PROGRESS');
  const capRec = captureOf(registry);
  const disputedMax = cents(disputedValue);
  const captureMax = cents(captureValue ?? capRec?.data?.amount?.value);
  const max = captureMax != null && disputedMax != null ? Math.min(disputedMax, captureMax) : disputedMax;
  if (kind === 'refund' || kind === 'accept') {
    const done = refundedSoFar(store, disputeId, registry, { captureId: captureId || capRec?.id, exceptEntryId });
    if (max == null || done + moneyOut(kind, amountValue, disputedValue) > max) reasons.push('REFUNDS_WOULD_EXCEED_DISPUTED');
  }
  return reasons;
}
// Did PayPal refuse the write (nothing happened) or is the outcome unknown? The Agent Toolkit does not throw: it returns
// a JSON string, either the result or an error object ({ code: 'PAYPAL_API_HTTP_ERROR', status } or { error: {...} }).
export function classifyWriteOutcome(resultOrError, thrown = false) {
  let v = resultOrError;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { /* plain text */ } }
  const status = Number(v?.status ?? v?.statusCode ?? v?.error?.status ?? NaN);
  const code = v?.code || v?.issue || v?.error?.code || v?.error?.type || null;
  const message = String(v?.message || v?.error?.message || v?.details?.[0]?.description || (thrown ? (resultOrError?.message || resultOrError) : '') || '').replace(/\s+/g, ' ').slice(0, 300);
  const isError = thrown || Boolean(v?.error) || code === 'PAYPAL_API_HTTP_ERROR' || code === 'PAYPAL_API_NO_RESPONSE' || code === 'PAYPAL_API_SETUP_ERROR' || (Number.isFinite(status) && status >= 400);
  if (!isError) return { ok: true };
  if (Number.isFinite(status) && status >= 400 && status < 500) return { ok: false, rejected: true, status, code, message };
  if (code === 'PAYPAL_API_SETUP_ERROR' || (v?.error?.type === 'paypal_error' && !Number.isFinite(status))) return { ok: false, rejected: true, status: null, code, message };
  return { ok: false, rejected: false, status: Number.isFinite(status) ? status : null, code, message }; // timeout, 5xx, no response: unknown
}

// ---------- Approval-code delivery (review v0.4, finding 3)
// The code is never put in any HTTP response. It goes to a human-only channel: by default the server console (the
// terminal running `npm start`, or the host's private log stream). A script holding only the reviewer passcode can list
// and approve proposals over the API, but it cannot read the code.
// v0.5.1 (review e): the full code is never written to stdout or a log. It goes to a 0600 file outside the repo
// (src/lib/approvalCodes.js); the console shows only the masked code, its last 4 characters and the file path, plus the
// full code once on an interactive terminal (stderr TTY) for the local operator.
export function consoleApprovalChannel(info) { return deliverApprovalCode(info); }
// What clients may see of a proposal: never the code, never its digest.
export function publicProposal(p) { const { tokenDigest: _d, ...rest } = p; return rest; }

// AI advice for one dispute (on demand; cached per dispute update_time so the free tier is not wasted).
// With Gemini and PayPal credentials, this runs the PayPal Agent Toolkit agent (read tools autonomous, writes proposed
// only). Otherwise the plain JSON advisor. Both share the same checker and fallback (finishAdvice).
// Every answer is labelled: run.kind LIVE_MODEL (the model answered now) or RULES_FALLBACK (no key, model error or rate
// limit; the deterministic rules engine decides). A committed, recorded agent run (CACHED_DEMO) can be shown separately
// when the live model is unavailable; it is never presented as live and its proposals cannot be approved.
const aiCache = new Map();
export const heldWrites = new Map(); // proposal id -> { tool, execute, badAttempts } (server memory only; no code kept)
const RATE_LIMIT = /\b429\b|RESOURCE_EXHAUSTED|quota|rate.?limit|too many requests/i;
function labelRun(out, llm) {
  const live = out.available !== false && out.ok && out.recommendation?.source === 'llm';
  const liveError = out.available === false ? 'NOT_CONFIGURED' : !out.ok ? (RATE_LIMIT.test(String(out.error || '')) ? 'RATE_LIMITED' : 'MODEL_ERROR') : null;
  out.run = { kind: live ? 'LIVE_MODEL' : 'RULES_FALLBACK', model: llm?.model || null, liveError,
    note: live ? 'Live answer from the model, checked by ProofPilot.' : liveError === 'RATE_LIMITED' ? 'The live model is rate-limited (Gemini free tier: 20 requests per model per day). The rules engine decides; a recorded demo run can be shown, clearly marked as cached.'
      : liveError === 'NOT_CONFIGURED' ? 'No AI key on this server. The rules engine decides; a recorded demo run can be shown, clearly marked as cached.'
      : liveError ? 'The model call failed. The rules engine decides.' : 'The model answered, but its recommendation did not pass the checks, so the rules engine decides.' };
  if (liveError) out.cachedDemo = { available: true, path: '/api/demo/cached-agent-run' };
  return out;
}
export async function aiAdvice({ api, store, engine, llm, agentTools, approvalChannel = consoleApprovalChannel }, id, { refresh = false } = {}) {
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
    // A pending, executable proposal must also be the dispute's only write (finding 2). If so it gets a server-issued,
    // single-use approval code bound to its id, hash and dispute. Only the digest is stored; the code itself goes to the
    // human-only approval channel and is not kept anywhere on the server.
    for (const p of props) {
      if (p.status !== 'PENDING_SELLER_APPROVAL' || !p.executable) continue;
      const blockers = writeBlockers(store, id, { kind: KIND[p.tool], amountValue: p.canonical?.amount?.value, disputedValue: a.amount?.value, registry: a._ctx.recs.registry, captureId: p.bound?.captureId });
      if (blockers.length) { p.status = 'BLOCKED'; p.blockedReasons = blockers; continue; }
      const t = issueToken(p);
      p.tokenDigest = t.digest; p.tokenExpiresAt = t.expiresAt; p.approvalCodeDelivery = 'SERVER_CONSOLE';
      heldWrites.set(p.id, { tool: p.tool, execute: held[p.tool] || null, badAttempts: 0 });
      try { approvalChannel({ proposalId: p.id, disputeId: id, description: p.description, code: t.token, expiresAt: t.expiresAt }); }
      catch { heldWrites.delete(p.id); p.status = 'BLOCKED'; p.blockedReasons = ['APPROVAL_CHANNEL_FAILED']; }
    }
    store.data.agentRuns ||= {};
    (store.data.agentRuns[id] ||= []).unshift({ at: new Date().toISOString(), model: llm.model, reportedModel: out.reportedModel || null, toolkit: out.agent?.toolkit, ok: out.ok,
      recommendation: out.recommendation, activity: out.agent?.activity || [], proposals: props, flags: out.flags || [], error: out.error });
    store.data.agentRuns[id] = store.data.agentRuns[id].slice(0, 10);
    store.save?.();
  } else out = await adviseWithLlm(llm, ctx);
  labelRun(out, llm);
  if (out.ok) aiCache.set(key, out);
  if (out.available) store.audit({ type: useAgent ? 'AGENT_RUN' : 'AI_ADVICE', disputeId: id, provider: out.provider, model: out.model, ok: out.ok,
    action: out.recommendation?.action, tools: (out.agent?.activity || []).map(x => `${x.kind}:${x.tool}`),
    refused: (out.narrative?.refused?.length || 0) + (out.rationale?.refused?.length || 0) });
  return out.agent ? { ...out, agent: { ...out.agent, proposals: (out.agent.proposals || []).map(publicProposal) } } : out;
}

// Seller approval gate for agent proposals. To run, a proposal must:
//   1. be PENDING_SELLER_APPROVAL and executable, with its stored hash still matching its canonical arguments;
//   2. come with the server-issued single-use token for this proposal id + hash + dispute (consumed on first valid use;
//      five wrong tokens also void it);
//   3. bind again against a FRESH PayPal read of the dispute, giving the identical canonical hash.
// Only then does the held toolkit tool (or the offer call) run, with ProofPilot's canonical arguments and template notes.
export async function approveProposal({ api, store, engine, config }, proposalId, body) {
  const all = Object.values(store.data.agentRuns || {}).flat().flatMap(r => r.proposals || []);
  const p = all.find(x => x.id === proposalId);
  if (!p) throw new SubmitError('UNKNOWN_PROPOSAL', 'No such agent proposal.');
  if (body?.approved !== true) throw new SubmitError('NOT_APPROVED', 'Seller approval is required: send approved=true and the approval code printed in the ProofPilot server console.');
  if (p.status !== 'PENDING_SELLER_APPROVAL') throw new SubmitError('NOT_PENDING', 'This proposal is not waiting for approval.', { status: p.status });
  if (!p.executable) throw new SubmitError('USE_EVIDENCE_APPROVAL', 'Evidence proposals are approved in the evidence pack panel (hash-bound).');
  const h = heldWrites.get(p.id);
  if (!h || !p.tokenDigest) throw new SubmitError('PROPOSAL_EXPIRED', 'This proposal has no live approval code (server restarted or already used). Ask the agent again.');
  if (proposalHash(p) !== p.hash) throw new SubmitError('PROPOSAL_CHANGED', 'The stored proposal no longer matches its hash.');
  if (new Date(p.tokenExpiresAt).getTime() < Date.now()) { heldWrites.delete(p.id); removeApprovalCodeFile(p.id); p.status = 'EXPIRED'; store.save?.(); throw new SubmitError('PROPOSAL_EXPIRED', 'The approval code expired. Ask the agent again.'); }
  if (typeof body.token !== 'string' || tokenDigest(body.token.trim(), p) !== p.tokenDigest) {
    if (++h.badAttempts >= 5) { heldWrites.delete(p.id); removeApprovalCodeFile(p.id); p.status = 'VOIDED'; store.save?.(); }
    store.audit({ type: 'AGENT_PROPOSAL_BAD_TOKEN', proposalId: p.id });
    throw new SubmitError('BAD_TOKEN', 'The approval code does not match this proposal.');
  }
  heldWrites.delete(p.id); // single use: consumed now, whatever happens next
  removeApprovalCodeFile(p.id);
  // One write per dispute, checked synchronously before any await. Cross-process (review v0.5 a): inside a store
  // transaction (lock file + re-read of the ledger from disk) the check and a ledger RESERVATION happen together, so a
  // second process sharing the file sees this reservation before it can reserve its own. Dry runs reserve nothing.
  const kind = KIND[p.tool];
  let reservation = null;
  const pre = store.transaction ? store.transaction(() => {
    const r = writeBlockers(store, p.disputeId, { kind, amountValue: p.canonical?.amount?.value, disputedValue: p.bound?.disputedAmount?.value, captureId: p.bound?.captureId, exceptId: p.id });
    if (!r.length && !config.dryRun) {
      const w = { id: 'w-' + crypto.randomUUID().slice(0, 12), at: new Date().toISOString(), disputeId: p.disputeId, captureId: p.bound?.captureId || null, source: 'agent-proposal',
        proposalId: p.id, tool: p.tool, kind, state: 'RESERVED', amount: kind === 'accept' ? p.bound?.disputedAmount || null : p.canonical?.amount || null };
      writeLedger(store, p.disputeId).push(w); reservation = w;
    }
    return r;
  }) : writeBlockers(store, p.disputeId, { kind, amountValue: p.canonical?.amount?.value, disputedValue: p.bound?.disputedAmount?.value, captureId: p.bound?.captureId, exceptId: p.id });
  if (pre.length) {
    p.status = 'BLOCKED_AT_APPROVAL'; p.blockedReasons = pre; store.save?.();
    store.audit({ type: 'AGENT_PROPOSAL_BLOCKED_AT_APPROVAL', proposalId: p.id, reasons: pre });
    throw new SubmitError('ONE_WRITE_PER_DISPUTE', 'This dispute already has a write from ProofPilot (or one is running), or the refund would exceed the disputed amount. Nothing was sent.', { reasons: pre });
  }
  writesInFlight.add(p.disputeId);
  try { return await runApproved({ api, store, engine, config }, p, h, kind, reservation); }
  catch (e) {
    // Anything that went wrong before PayPal was called releases the reservation (nothing was sent).
    if (reservation && reservation.state === 'RESERVED') updateWrite(store, reservation.id, { failed: true, state: 'RELEASED', failure: e?.code || 'ERROR' });
    throw e;
  }
  finally { writesInFlight.delete(p.disputeId); }
}
async function runApproved({ api, store, engine, config }, p, h, kind, reservation) {
  const a = await analyseDispute({ api, store, engine }, p.disputeId);
  const fresh = bindProposal(p.tool, p.canonical, { dispute: a._ctx.dispute, actions: a.status.actions, allowedTypes: a.allowedTypes,
    rejectedTypes: [...new Set(a.paypalRejected.map(r => r.type))], registry: a._ctx.recs.registry, final: { action: p.finalAction } });
  const freshHash = fresh.ok ? proposalHash({ ...p, canonical: fresh.canonical, bound: fresh.bound }) : null;
  if (!fresh.ok || freshHash !== p.hash) {
    p.status = 'BLOCKED_AT_APPROVAL'; p.blockedReasons = fresh.ok ? ['PAYPAL_DATA_CHANGED'] : fresh.reasons; store.save?.();
    store.audit({ type: 'AGENT_PROPOSAL_BLOCKED_AT_APPROVAL', proposalId: p.id, reasons: p.blockedReasons });
    throw new SubmitError('STALE_PROPOSAL', 'PayPal data changed since the proposal, or it no longer passes the checks. Nothing was sent.', { reasons: p.blockedReasons });
  }
  // Refund total against the disputed amount and the payment, now also counting refunds PayPal reports on the fresh
  // read (completed and pending), and every ProofPilot write on the same capture. This proposal's own reservation is
  // excluded. Re-read from disk first.
  store.reload?.();
  if (kind === 'refund' || kind === 'accept') {
    const capRec = a._ctx.recs.registry.all().find(r => r.type === 'capture');
    const done = refundedSoFar(store, p.disputeId, a._ctx.recs.registry, { captureId: p.bound?.captureId, exceptEntryId: reservation?.id });
    const maxes = [cents(a.amount?.value), cents(capRec?.data?.amount?.value)].filter(x => x != null);
    if (!maxes.length || done + moneyOut(kind, p.canonical?.amount?.value, a.amount?.value) > Math.min(...maxes)) {
      p.status = 'BLOCKED_AT_APPROVAL'; p.blockedReasons = ['REFUNDS_WOULD_EXCEED_DISPUTED']; store.save?.();
      throw new SubmitError('ONE_WRITE_PER_DISPUTE', 'Refunds on this payment would exceed the disputed amount. Nothing was sent.', { reasons: p.blockedReasons });
    }
  }
  store.audit({ type: 'AGENT_PROPOSAL_APPROVED', proposalId: p.id, tool: p.tool, hash: p.hash, dryRun: Boolean(config.dryRun) });
  if (config.dryRun) { p.status = 'APPROVED_DRY_RUN'; store.save?.(); return { dryRun: true, proposal: publicProposal(p), sent: p.canonical }; }
  if (!h.execute && p.tool !== 'propose_make_offer') throw new SubmitError('PROPOSAL_EXPIRED', 'The toolkit tool for this proposal is not loaded.');
  // The reservation stays counted from here on: if PayPal times out after acting, the dispute still counts as written.
  if (reservation) updateWrite(store, reservation.id, { state: 'SENDING' });
  let result; let outcome;
  try {
    result = p.tool === 'propose_make_offer' ? await api.makeOffer(p.disputeId, { note: p.canonical.note, amount: p.canonical.amount }) : await h.execute(p.canonical, {});
    outcome = classifyWriteOutcome(result);
  } catch (e) {
    outcome = e?.issue && e.status ? (e.status >= 400 && e.status < 500 ? { ok: false, rejected: true, status: e.status, code: e.issue, message: String(e.message || '').slice(0, 300) } : { ok: false, rejected: false, status: e.status, code: e.issue, message: String(e.message || '').slice(0, 300) })
      : classifyWriteOutcome(e, true);
  }
  if (!outcome.ok) {
    // Review v0.5 d: a write PayPal refused (4xx) is marked FAILED with a readable reason and releases the dispute.
    // An unknown outcome (timeout, 5xx, no response) stays counted (fail closed) and is marked FAILED_UNCERTAIN.
    const msg = redact(outcome.message || 'PayPal did not accept the request.');
    p.status = outcome.rejected ? 'FAILED' : 'FAILED_UNCERTAIN';
    p.failure = { status: outcome.status, code: outcome.code, message: msg, at: new Date().toISOString() };
    if (reservation) updateWrite(store, reservation.id, outcome.rejected ? { failed: true, state: 'REJECTED_BY_PAYPAL', failure: outcome.code || outcome.status } : { state: 'UNKNOWN_OUTCOME' });
    store.save?.();
    store.audit({ type: outcome.rejected ? 'AGENT_PROPOSAL_REJECTED_BY_PAYPAL' : 'AGENT_PROPOSAL_OUTCOME_UNKNOWN', proposalId: p.id, tool: p.tool, status: outcome.status, code: outcome.code });
    throw new SubmitError(outcome.rejected ? 'PAYPAL_REJECTED_WRITE' : 'PAYPAL_OUTCOME_UNKNOWN',
      outcome.rejected ? `PayPal refused this ${human('tool', p.tool) || p.tool}${outcome.status ? ` (HTTP ${outcome.status})` : ''}: ${msg} Nothing was changed; the dispute is free for another action.`
        : `ProofPilot could not confirm whether PayPal carried out this action (${msg}). It still counts as a write on this dispute, so nothing else will be sent automatically. Check the dispute in PayPal.`,
      { proposal: publicProposal(p) });
  }
  if (reservation) updateWrite(store, reservation.id, { state: 'EXECUTED' });
  p.status = 'EXECUTED_AFTER_APPROVAL'; p.executedAt = new Date().toISOString(); store.save?.();
  store.audit({ type: 'AGENT_PROPOSAL_EXECUTED', proposalId: p.id, tool: p.tool });
  let parsed = result; if (typeof parsed === 'string') { try { parsed = JSON.parse(parsed); } catch { /* keep text */ } }
  return { dryRun: false, proposal: publicProposal(p), sent: p.canonical, result: JSON.parse(JSON.stringify(parsed ?? null)) };
}
