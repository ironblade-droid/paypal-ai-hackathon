// PayPal evidence-type refusals (EVIDENCE_TYPE_IS_NOT_ALLOWED), kept so ProofPilot never recommends a refused type again.
// Three sources, merged and de-duplicated by debug id:
//   1. seed/paypal-refusals.json: committed, so a fresh install or a hosted demo (whose disk resets) still knows them;
//   2. the local store (refusals seen by this install, written by submitDecision);
//   3. derived from the dispute's own data: PayPal's dispute record does not list refused submissions, so this only
//      produces a warning (not a hard block) when a type the seller already sent at an earlier stage is requested again,
//      which is the pattern seen when PayPal refused it in the sandbox.
// A refusal applies while the dispute is still in the stage it was refused in.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SEED = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../seed/paypal-refusals.json');
let seedCache = null;
export function seedRefusals(file = SEED) {
  if (file === SEED && seedCache) return seedCache;
  let list = [];
  try { list = JSON.parse(fs.readFileSync(file, 'utf8')).refusals || []; } catch { list = []; }
  if (file === SEED) seedCache = list;
  return list;
}

export function refusalsFor(dispute, store, { seed = seedRefusals() } = {}) {
  const id = dispute?.dispute_id; const stage = dispute?.dispute_life_cycle_stage;
  const local = (store?.data?.rejectedTypes?.[id] || []).map(r => ({ disputeId: id, ...r, source: 'this install' }));
  const seeded = seed.filter(r => r.disputeId === id).map(r => ({ ...r, source: 'seed file' }));
  const seen = new Set(); const all = [];
  for (const r of [...local, ...seeded]) { const k = r.debugId || `${r.type}|${r.at}`; if (!seen.has(k)) { seen.add(k); all.push(r); } }
  // Current = same stage (or, for old entries without a stage, refused after the dispute's last update).
  return all.filter(r => (r.stage ? r.stage === stage : Date.parse(r.at || 0) >= Date.parse(dispute?.update_time || 0)));
}

export function derivedRefusalRisks(dispute) {
  const stage = dispute?.dispute_life_cycle_stage;
  const ev = dispute?.evidences || [];
  const requestedNow = ev.filter(e => e.source === 'REQUESTED_FROM_SELLER' && e.dispute_life_cycle_stage === stage).map(e => e.evidence_type);
  return [...new Set(requestedNow)].filter(t => ev.some(e => e.source === 'SUBMITTED_BY_SELLER' && e.evidence_type === t && e.dispute_life_cycle_stage && e.dispute_life_cycle_stage !== stage))
    .map(t => ({ type: t, message: `You already sent ${t} at an earlier stage of this case. In sandbox testing PayPal refused the same type when it was requested again at the next stage, so it may be refused here too.` }));
}
