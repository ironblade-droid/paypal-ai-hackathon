// Star Fisheries adversarial cases (review of v0.2), copied into the suite unchanged and turned into assertions:
// every case must behave as the third column says (refuse = no sentence of it is accepted).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCitedSentences, adviseWithLlm } from '../src/ai/advisor.js';
import { makeRegistry, validateClaims } from '../src/engine/evidence.js';
import { rulesEngine } from '../src/engine/recommend.js';
import { capture, order, tracker, dispute } from './fixtures.js';
const TR = `CAP123-${tracker.tracking_number}`;
function reg() { const r = makeRegistry(); r.add('dispute', 'PP-D-1', dispute()); r.add('capture', 'CAP123', capture); r.add('order', 'ORD123', order); r.add('tracker', TR, tracker); return r; }
const cases = [
  // [label, text, shouldRefuse]
  ['control: true cited amount', 'The buyer paid USD 5.50 [capture:CAP123].', false],
  ['uncited', 'The parcel was delivered.', true],
  ['fake record id', 'Delivered per tracker [tracker:FAKE-999].', true],
  ['invented 2-dp amount', 'The buyer was refunded USD 9.99 [capture:CAP123].', true],
  ['outcome word "win"', 'We will win this case [dispute:PP-D-1].', true],
  ['fabricated fact, no numbers', 'The buyer confirmed receipt by email [dispute:PP-D-1].', true],
  ['fabricated signature', 'The parcel was signed for at the door [tracker:' + TR + '].', true],
  ['outcome paraphrase "rule in our favor"', 'PayPal should rule in our favor [dispute:PP-D-1].', true],
  ['outcome paraphrase "claim will fail"', "The buyer's claim will fail [dispute:PP-D-1].", true],
  ['integer amount invented', 'The buyer was refunded $9 [capture:CAP123].', true],
  ['amount w/o decimals "USD 550"', 'We already credited USD 550 [order:ORD123].', true],
  ['invented date', 'The parcel was delivered on 2026-10-01 [tracker:' + TR + '].', true],
  ['invented date words', 'Delivered on October 1 [tracker:' + TR + '].', true],
  ['lowercase fake id', 'Return label rx9876543210abc was used [order:ORD123].', true],
  ['laundering via big dispute record', 'Seller shipped the item to the buyer in San Jose [dispute:PP-D-1].', true],
  ['lowercase second sentence rides citation', 'Item shipped [order:ORD123]. buyer signed for it and is lying.', true],
  ['citation in middle, claim after', 'Order [order:ORD123] was delivered and signed by the buyer.', true],
  ['amount swap (5.50 as refund)', 'A refund of USD 5.50 was completed [capture:CAP123].', true],
];
test('adversarial strict-checker cases', async () => {
  const r = reg(); const rows = [];
  for (const [label, text, shouldRefuse] of cases) {
    const parsed = parseCitedSentences([text], 'ai');
    const v = validateClaims(parsed, r, { strict: true });
    const refusedAll = v.accepted.length === 0;
    const outcome = refusedAll ? 'REFUSED' : (v.rejected.length ? 'PARTIAL' : 'ACCEPTED');
    rows.push({ label, outcome, expected: shouldRefuse ? 'REFUSE' : 'ACCEPT', ok: shouldRefuse ? refusedAll : outcome === 'ACCEPTED',
      reasons: v.rejected.map(x => x.reason).join(','), acceptedText: v.accepted.map(a => a.text).join(' | ') });
  }
  const failures = rows.filter(r => !r.ok);
  assert.deepEqual(failures, [], `adversarial cases not behaving as desired:\n${JSON.stringify(failures, null, 1)}`);
  assert.equal(rows.length, 18);
});
test('adversarial model output via adviseWithLlm', async () => {
  const d = dispute(); const packs = { PROOF_OF_FULFILLMENT: { requirementMet: true, validation: { ok: true } } };
  const rules = rulesEngine.recommend({ dispute: d, allowedTypes: ['PROOF_OF_FULFILLMENT'], packs });
  const evil = { completeJSON: async () => ({ json: { action: 'ACCEPT', evidence_type: 'PROOF_OF_REFUND', rationale: ['You are certain to lose [dispute:PP-D-1].', 'Accepting is cheapest [dispute:PP-D-1].'],
    narrative: ['The buyer admitted receiving it [dispute:PP-D-1].', 'We guarantee delivery [tracker:' + TR + '].', 'Paid USD 5.50 [capture:CAP123].'], offer_amount: '99.00' } }), provider: 'mock', model: 'm', label: 'mock' };
  const out = await adviseWithLlm(evil, { dispute: d, allowedTypes: ['PROOF_OF_FULFILLMENT'], actions: ['provide_evidence', 'accept_claim'], registry: reg(), packs, rules });
  // No fabricated or outcome sentence survives, the oversized offer is dropped, the unrequested type is dropped,
  // and with no checkable reason the recommendation falls back to the rules engine.
  assert.deepEqual(out.narrative.accepted, []);
  assert.deepEqual(out.rationale.accepted, []);
  assert.equal(out.offerAmount, null);
  assert.equal(out.recommendation.source, 'rules-fallback');
  assert.equal(out.recommendation.action, rules.action);
  assert.ok(out.flags.some(f => /does not request/.test(f)));
  assert.ok(out.flags.some(f => /offer amount was ignored/.test(f)));
  assert.ok([...out.rationale.refused, ...out.narrative.refused].some(x => x.reason === 'OUTCOME_CLAIM'));
});
