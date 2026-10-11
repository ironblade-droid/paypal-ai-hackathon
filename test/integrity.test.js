// v0.3 integrity tests: late tracking, PayPal refusal memory that survives a fresh install, value formats.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRegistry, validateClaims, buildPack, toEvidencePayload, trackerTiming, extractValues, factCatalog } from '../src/engine/evidence.js';
import { refusalsFor, derivedRefusalRisks, seedRefusals } from '../src/lib/refusals.js';
import { createApp } from '../src/app.js';
import { createStore } from '../src/lib/store.js';
import { rulesEngine } from '../src/engine/recommend.js';
import { capture, order, tracker, lateTracker, dispute, fakeApi, links } from './fixtures.js';

const LT = `CAP123-${lateTracker.tracking_number}`;
function reg(trackers = [tracker, lateTracker]) {
  const r = makeRegistry(); r.add('dispute', 'PP-D-1', dispute()); r.add('capture', 'CAP123', capture); r.add('order', 'ORD123', order);
  for (const t of trackers) r.add('tracker', `CAP123-${t.tracking_number}`, t); return r;
}

test('tracker timing: before / after the dispute opened / unknown', () => {
  assert.equal(trackerTiming(tracker, dispute()).status, 'BEFORE_DISPUTE');
  assert.equal(trackerTiming(lateTracker, dispute()).status, 'AFTER_DISPUTE');
  assert.equal(trackerTiming({ ...tracker, last_updated_time: undefined }, dispute()).status, 'UNKNOWN');
});

test('late tracking is labelled "added after dispute opened" and never used as proof of shipment', () => {
  const r = reg([lateTracker]);
  const p = buildPack('PROOF_OF_FULFILLMENT', { dispute: dispute(), capture, order, trackers: [lateTracker], registry: r });
  assert.equal(p.requirementMet, false);
  assert.ok(p.gaps.some(g => g.code === 'LATE_TRACKING' && /added after dispute opened/.test(g.message)));
  assert.ok(!p.claims.some(c => c.refs.some(x => x.type === 'tracker')));
  // A seller sentence presenting it as shipment proof is refused; the honest "added after" fact is allowed.
  const v = validateClaims([{ id: 'c', text: 'Shipped with USPS.', refs: [{ type: 'tracker', id: LT }] }], r);
  assert.equal(v.rejected[0].reason, 'LATE_TRACKING');
  const late = factCatalog(r).find(f => f.id.endsWith(':late'));
  assert.match(late.text, /added after dispute opened/);
  assert.equal(validateClaims([late], r, { strict: true }).ok, true);
  // And it is never put in tracking_info.
  const { input } = toEvidencePayload('PROOF_OF_FULFILLMENT', [late], { trackers: [lateTracker], registry: r });
  assert.equal(input.evidences[0].evidence_info, undefined);
});

test('pack with one early and one late tracker: only the early one backs proof of shipment', () => {
  const r = reg();
  const p = buildPack('PROOF_OF_FULFILLMENT', { dispute: dispute(), capture, order, trackers: [tracker, lateTracker], registry: r });
  assert.equal(p.requirementMet, true);
  const cited = p.claims.flatMap(c => c.refs.filter(x => x.type === 'tracker').map(x => x.id));
  assert.deepEqual(cited, [`CAP123-${tracker.tracking_number}`]);
});

test('value extraction covers amounts and dates in any common format', () => {
  const raws = (t) => extractValues(t).map(v => v.raw);
  assert.ok(raws('refunded $9 and USD 550 and 12 dollars').includes('$9'));
  assert.ok(raws('refunded $9 and USD 550 and 12 dollars').includes('USD 550'));
  assert.ok(raws('refunded $9 and USD 550 and 12 dollars').includes('12 dollars'));
  for (const d of ['October 1', '1st Oct 2026', '10/01/2026', '2026-10-01']) assert.ok(raws(`on ${d}`).length, d);
  const r = reg();
  for (const t of ['Paid on 3 October [capture:CAP123].', 'Paid 1,200 USD.', 'Ref ab12cd34ef56 used.'])
    assert.equal(validateClaims([{ id: 'x', text: t, refs: [{ type: 'capture', id: 'CAP123' }] }], r).rejected[0]?.reason, 'VALUE_NOT_IN_CITED_RECORD', t);
  assert.equal(validateClaims([{ id: 'x', text: 'Captured on 11 October 2026 for USD 5.50.', refs: [{ type: 'capture', id: 'CAP123' }] }], r).ok, true);
});

test('PayPal refusals: committed seed survives a fresh install; scoped to dispute and stage', () => {
  assert.equal(seedRefusals().length, 5);
  const live = dispute({ dispute_id: 'PP-R-PGV-10190981', dispute_life_cycle_stage: 'CHARGEBACK', update_time: '2026-10-11T10:27:52.700Z' });
  assert.equal(refusalsFor(live, createStore(null)).length, 5);
  assert.equal(refusalsFor({ ...live, dispute_life_cycle_stage: 'INQUIRY' }, createStore(null)).length, 0);
  assert.equal(refusalsFor(dispute(), createStore(null)).length, 0);
  // Local store entries merge with the seed, de-duplicated by debug id.
  const st = createStore(null); st.data.rejectedTypes = { 'PP-R-PGV-10190981': [{ type: 'PROOF_OF_FULFILLMENT', stage: 'CHARGEBACK', debugId: 'f555810c4f27c', at: '2026-10-11T10:33:14.577Z' }, { type: 'PROOF_OF_FULFILLMENT', stage: 'CHARGEBACK', debugId: 'new1', at: '2026-10-11T11:00:00Z' }] };
  assert.equal(refusalsFor(live, st).length, 6);
});

test('derived from the dispute: a type sent at an earlier stage and requested again is flagged', () => {
  const d = dispute({ dispute_life_cycle_stage: 'CHARGEBACK', evidences: [
    { evidence_type: 'PROOF_OF_FULFILLMENT', source: 'SUBMITTED_BY_SELLER', dispute_life_cycle_stage: 'INQUIRY' },
    { evidence_type: 'PROOF_OF_FULFILLMENT', source: 'REQUESTED_FROM_SELLER', dispute_life_cycle_stage: 'CHARGEBACK' }] });
  assert.deepEqual(derivedRefusalRisks(d).map(x => x.type), ['PROOF_OF_FULFILLMENT']);
  assert.deepEqual(derivedRefusalRisks(dispute()), []);
});

test('fresh install: the seeded dispute never recommends or sends the refused type', async () => {
  const d = dispute({ dispute_id: 'PP-R-PGV-10190981', dispute_life_cycle_stage: 'CHARGEBACK', update_time: '2026-10-11T10:27:52.700Z',
    evidences: [{ evidence_type: 'PROOF_OF_FULFILLMENT', source: 'REQUESTED_FROM_SELLER', dispute_life_cycle_stage: 'CHARGEBACK' }] });
  const app = createApp({ api: fakeApi({ d }), store: createStore(null), engine: rulesEngine, config: { dryRun: true } });
  const s = await new Promise(r => { const x = app.listen(0, () => r(x)); }); const base = `http://127.0.0.1:${s.address().port}`;
  try {
    const a = await (await fetch(`${base}/api/disputes/PP-R-PGV-10190981`)).json();
    assert.equal(a.paypalRejected.length, 5);
    assert.notEqual(a.recommendation.evidenceType, 'PROOF_OF_FULFILLMENT');
    assert.match(a.recommendation.reasons[0], /already refused "Proof of shipment \/ delivery"/);
    const sub = await (await fetch(`${base}/api/disputes/PP-R-PGV-10190981/submit`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'provide_evidence', evidenceType: 'PROOF_OF_FULFILLMENT', approved: true, confirm: 'APPROVE', packHash: 'x' }) })).json();
    assert.equal(sub.error, 'TYPE_REFUSED_BY_PAYPAL');
  } finally { s.close(); }
});

test('rules engine reasons never use outcome wording', async () => {
  const { OUTCOME_WORDS } = await import('../src/engine/evidence.js');
  const scenarios = [
    { dispute: dispute(), allowedTypes: ['PROOF_OF_FULFILLMENT'], packs: { PROOF_OF_FULFILLMENT: { requirementMet: true, validation: { ok: true } } } },
    { dispute: dispute(), allowedTypes: ['PROOF_OF_FULFILLMENT'], packs: { PROOF_OF_FULFILLMENT: { requirementMet: false, validation: { ok: true }, gaps: [{ code: 'LATE_TRACKING' }] } } },
    { dispute: dispute(), allowedTypes: ['PROOF_OF_FULFILLMENT'], packs: { PROOF_OF_FULFILLMENT: { requirementMet: true, validation: { ok: true } } }, rejectedTypes: ['PROOF_OF_FULFILLMENT'] },
    { dispute: dispute({ status: 'UNDER_REVIEW', links: links('accept_claim') }), allowedTypes: [], packs: {} },
    { dispute: dispute({ status: 'OPEN', links: links() }), allowedTypes: [], packs: {} },
  ];
  for (const sc of scenarios) for (const r of rulesEngine.recommend(sc).reasons) assert.doesNotMatch(r, OUTCOME_WORDS, r);
});
