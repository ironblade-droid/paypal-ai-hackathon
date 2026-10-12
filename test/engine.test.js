import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkShipment } from '../src/engine/risk.js';
import { classifyRefund, allowedEvidenceTypes, makeRegistry, validateClaims, buildPack, packHash, toEvidencePayload, packPdf } from '../src/engine/evidence.js';
import { describeStatus, deadline } from '../src/engine/status.js';
import { rulesEngine } from '../src/engine/recommend.js';
import { order, capture, tracker, dispute, links } from './fixtures.js';

test('risk: clean physical order to the PayPal address passes', () => {
  const r = checkShipment({ order, capture, shipTo: order.purchase_units[0].shipping.address });
  assert.equal(r.ok, true); assert.equal(r.score, 100);
});
test('risk: redirected address blocks (voids Seller Protection)', () => {
  const r = checkShipment({ order, capture, shipTo: { ...order.purchase_units[0].shipping.address, address_line_1: '1 Other Rd' } });
  assert.equal(r.ok, false); assert.ok(r.flags.some(f => f.code === 'ADDRESS_MISMATCH' && f.severity === 'BLOCK'));
});
test('risk: >= USD 750 without signature blocks; with signature passes', () => {
  const big = { ...capture, amount: { currency_code: 'USD', value: '820.00' } };
  assert.ok(checkShipment({ order, capture: big }).flags.some(f => f.code === 'SIGNATURE_REQUIRED'));
  assert.ok(!checkShipment({ order, capture: big, signatureConfirmation: true }).flags.some(f => f.code === 'SIGNATURE_REQUIRED'));
});
test('risk: pending capture, ineligible protection, digital goods, missing address', () => {
  const r = checkShipment({ order: { ...order, purchase_units: [{ amount: order.purchase_units[0].amount }] },
    capture: { ...capture, status: 'PENDING', seller_protection: { status: 'NOT_ELIGIBLE' } }, itemType: 'DIGITAL' });
  const codes = r.flags.map(f => f.code);
  for (const c of ['CAPTURE_NOT_COMPLETED', 'SELLER_PROTECTION_NOT_ELIGIBLE', 'NOT_PHYSICAL_GOODS', 'NO_SHIPPING_ADDRESS']) assert.ok(codes.includes(c), c);
  assert.equal(r.ok, false);
});

test('evidence types come only from the dispute (current stage), never a fixed list', () => {
  assert.deepEqual(allowedEvidenceTypes(dispute()), ['PROOF_OF_FULFILLMENT']);
  const cb = dispute({ dispute_life_cycle_stage: 'CHARGEBACK', evidences: [
    { evidence_type: 'PROOF_OF_FULFILLMENT', source: 'REQUESTED_FROM_SELLER', dispute_life_cycle_stage: 'INQUIRY' },
    { evidence_type: 'PROOF_OF_REFUND', source: 'REQUESTED_FROM_SELLER', dispute_life_cycle_stage: 'CHARGEBACK' },
    { evidence_type: 'OTHER', source: 'REQUESTED_FROM_SELLER', dispute_life_cycle_stage: 'CHARGEBACK' },
    { evidence_type: 'OTHER', source: 'SUBMITTED_BY_SELLER', dispute_life_cycle_stage: 'CHARGEBACK' }] });
  assert.deepEqual(allowedEvidenceTypes(cb), ['PROOF_OF_REFUND', 'OTHER']);
  assert.deepEqual(allowedEvidenceTypes(dispute({ status: 'UNDER_REVIEW', evidences: [] })), []);
});

function reg() { const r = makeRegistry(); r.add('dispute', 'PP-D-1', dispute()); r.add('capture', 'CAP123', capture); r.add('order', 'ORD123', order); r.add('tracker', 'CAP123-' + tracker.tracking_number, tracker); return r; }

test('checker refuses claims with no linked record or an unknown record', () => {
  const v = validateClaims([
    { id: 'a', text: 'Captured', refs: [{ type: 'capture', id: 'CAP123' }] },
    { id: 'b', text: 'Buyer is lying', refs: [] },
    { id: 'c', text: 'Delivered', refs: [{ type: 'tracker', id: 'made-up' }] },
    { id: 'd', text: '   ', refs: [{ type: 'capture', id: 'CAP123' }] }], reg());
  assert.equal(v.ok, false);
  assert.deepEqual(v.accepted.map(c => c.id), ['a']);
  assert.deepEqual(v.rejected.map(r => r.reason), ['NO_LINKED_RECORD', 'UNKNOWN_RECORD', 'EMPTY_CLAIM']);
});

test('proof of fulfillment pack cites the tracker and meets the requirement', () => {
  const r = reg(); const p = buildPack('PROOF_OF_FULFILLMENT', { dispute: dispute(), capture, order, trackers: [tracker], registry: r });
  assert.equal(p.requirementMet, true);
  const v = validateClaims(p.claims, r); assert.equal(v.ok, true);
  const { input } = toEvidencePayload('PROOF_OF_FULFILLMENT', v.accepted, { trackers: [tracker], registry: r });
  assert.deepEqual(input.evidences[0].evidence_info.tracking_info, [{ carrier_name: 'USPS', tracking_number: tracker.tracking_number }]);
  assert.match(input.evidences[0].notes, /capture CAP123/);
});

test('pack without tracker: gap reported, requirement not met; unregistered earlier tracking flagged', () => {
  const d = dispute({ evidences: [...dispute().evidences, { evidence_type: 'PROOF_OF_FULFILLMENT', source: 'SUBMITTED_BY_SELLER', evidence_info: { tracking_info: [{ carrier_name: 'USPS', tracking_number: '9400100000000000000001' }] } }] });
  const p = buildPack('PROOF_OF_FULFILLMENT', { dispute: d, capture, order, trackers: [], registry: reg() });
  assert.equal(p.requirementMet, false);
  assert.deepEqual(p.gaps.map(g => g.code).sort(), ['NO_TRACKER', 'UNREGISTERED_TRACKING']);
});

test('pack hash changes when a claim changes', () => {
  const c = [{ id: 'a', text: 'x', refs: [{ type: 'capture', id: 'CAP123' }] }];
  assert.notEqual(packHash('D', 'OTHER', c), packHash('D', 'OTHER', [{ ...c[0], text: 'y' }]));
});

test('pdf is a valid-looking PDF', () => { const b = packPdf(['Hello (world)', 'x'.repeat(200)]); assert.ok(b.toString().startsWith('%PDF-1.4')); assert.ok(b.toString().includes('%%EOF')); });

test('status: new dispute with only self link = waiting for PayPal', () => {
  const s = describeStatus({ status: 'OPEN', create_time: new Date(Date.now() - 60000).toISOString(), links: links() });
  assert.equal(s.waiting, true); assert.equal(s.label, 'Waiting for PayPal'); assert.match(s.detail, /3 to 5 minutes/);
});
test('status: UNDER_REVIEW reads "Under PayPal review"; no label ever claims a win', () => {
  assert.equal(describeStatus({ status: 'UNDER_REVIEW', links: links('provide_supporting_info') }).label, 'Under PayPal review');
  for (const st of ['OPEN', 'WAITING_FOR_SELLER_RESPONSE', 'WAITING_FOR_BUYER_RESPONSE', 'UNDER_REVIEW', 'RESOLVED', 'OTHER']) {
    const s = describeStatus({ status: st, links: links('accept_claim'), dispute_outcome: { outcome_code: 'RESOLVED_SELLER_FAVOUR' } });
    assert.doesNotMatch(`${s.label} ${s.detail}`, /\bwon\b|\bwin\b|seller favou?r/i);
  }
});
test('deadline: hours left and urgency', () => {
  const now = Date.parse('2026-10-20T09:22:26Z');
  assert.deepEqual(deadline(dispute(), now), { due: '2026-10-21T09:22:26Z', hoursLeft: 24, overdue: false, urgent: true });
  assert.equal(deadline({}), null);
});

test('rules engine: FIGHT when requested fulfillment proof is fully cited', () => {
  const r = rulesEngine.recommend({ dispute: dispute(), allowedTypes: ['PROOF_OF_FULFILLMENT'], packs: { PROOF_OF_FULFILLMENT: { requirementMet: true, validation: { ok: true } } } });
  assert.equal(r.action, 'FIGHT'); assert.equal(r.evidenceType, 'PROOF_OF_FULFILLMENT');
});
test('rules engine: ACCEPT under threshold without evidence, OFFER when offer link exists, WAIT under review', () => {
  const noPack = { PROOF_OF_FULFILLMENT: { requirementMet: false, validation: { ok: true }, gaps: [{ code: 'NO_TRACKER' }] } };
  assert.equal(rulesEngine.recommend({ dispute: dispute(), allowedTypes: ['PROOF_OF_FULFILLMENT'], packs: noPack, acceptBelow: 10 }).action, 'ACCEPT');
  assert.equal(rulesEngine.recommend({ dispute: dispute({ links: links('provide_evidence', 'make_offer', 'accept_claim') }), allowedTypes: ['PROOF_OF_FULFILLMENT'], packs: noPack }).action, 'OFFER');
  const w = rulesEngine.recommend({ dispute: dispute({ status: 'UNDER_REVIEW', links: links('provide_supporting_info') }), allowedTypes: [], packs: {} });
  assert.equal(w.action, 'WAIT'); assert.match(w.reasons.join(' '), /under PayPal review/);
});

test('rules engine: UNDER_REVIEW with accept_claim offered still recommends WAIT (no refund mid-review)', () => {
  const r = rulesEngine.recommend({ dispute: dispute({ status: 'UNDER_REVIEW', links: links('accept_claim', 'adjudicate', 'require_evidence', 'provide_supporting_info') }), allowedTypes: [], packs: {} });
  assert.equal(r.action, 'WAIT'); assert.ok(r.availableActions.includes('accept_claim')); assert.ok(!r.availableActions.includes('adjudicate'));
});

test('refund that matches the dispute HOLD_PLACED movement is a PayPal dispute hold, never proof of refund', () => {
  const hold = { id: '44V27761ED882372G', status: 'PENDING', amount: { currency_code: 'USD', value: '4.82' }, create_time: '2026-10-11T02:25:32-07:00' };
  const d = dispute({ fund_movements: [{ party: 'RECEIVER', amount: { currency_code: 'USD', value: '4.82' }, initiated_time: '2026-10-11T09:25:32.000Z', type: 'DEBIT', reason: 'HOLD_PLACED' }] });
  assert.equal(classifyRefund(hold, d).kind, 'DISPUTE_HOLD');
  assert.equal(classifyRefund({ ...hold, status: 'COMPLETED' }, dispute()).kind, 'SELLER_REFUND');
  assert.equal(classifyRefund(hold, dispute()).kind, 'SELLER_REFUND_PENDING'); // v0.5.1: a pending non-hold refund is money out
  const ord = { ...order, purchase_units: [{ ...order.purchase_units[0], payments: { captures: [capture], refunds: [hold] } }] };
  const r = reg(); r.add('refund', hold.id, { ...hold, proofpilot_classification: 'DISPUTE_HOLD' });
  const p = buildPack('PROOF_OF_REFUND', { dispute: d, capture, order: ord, trackers: [], registry: r });
  assert.equal(p.requirementMet, false); assert.ok(p.gaps.some(g => g.code === 'DISPUTE_HOLD_NOT_REFUND'));
  const v = validateClaims([{ id: 'x', text: 'Refunded', refs: [{ type: 'refund', id: hold.id }] }], r);
  assert.equal(v.rejected[0].reason, 'NOT_A_SELLER_REFUND');
});

test('tracking claims are labelled as sandbox test data', () => {
  const p = buildPack('PROOF_OF_FULFILLMENT', { dispute: dispute(), capture, order, trackers: [tracker], registry: reg() });
  assert.match(p.claims.find(c => c.id.startsWith('tracker-')).text, /sandbox test tracking number, no real parcel/);
});

test('rules engine: a type PayPal already refused is not recommended again', () => {
  const r = rulesEngine.recommend({ dispute: dispute(), allowedTypes: ['PROOF_OF_FULFILLMENT'], packs: { PROOF_OF_FULFILLMENT: { requirementMet: true, validation: { ok: true } } }, rejectedTypes: ['PROOF_OF_FULFILLMENT'] });
  assert.notEqual(r.action, 'FIGHT'); assert.match(r.reasons[0], /already refused "Proof of shipment \/ delivery"/);
});
test('unsupported requested types (e.g. delivery signature) are never ready', () => {
  const p = buildPack('PROOF_OF_DELIVERY_SIGNATURE', { dispute: dispute(), capture, order, trackers: [tracker], registry: reg() });
  assert.equal(p.requirementMet, false); assert.ok(p.gaps.some(g => g.code === 'UNSUPPORTED_EVIDENCE_TYPE'));
});
