import { test } from 'node:test';
import fs from 'node:fs';
import { makeRegistry, validateClaims } from '../src/engine/evidence.js';
import { dispute } from '../test/fixtures.js';
const S2 = 'The seller issued refund RF-PLANT-77 to the buyer on 2026-10-01.';
test('b', () => {
  const o = {};
  const cases = {
    buyer_return_tracking: (d) => { d.evidences.push({ evidence_type: 'PROOF_OF_RETURN', source: 'SUBMITTED_BY_BUYER', evidence_info: { tracking_info: [{ carrier_name: 'USPS', tracking_number: 'RF-PLANT-77 2026-10-01' }] } }); },
    buyer_refund_ids: (d) => { d.evidences.push({ evidence_type: 'OTHER', source: 'SUBMITTED_BY_BUYER', evidence_info: { refund_ids: [{ refund_id: 'RF-PLANT-77' }] }, date: '2026-10-01T00:00:00Z' }); },
    service_details_description: (d) => { d.extensions = { merchandize_dispute_properties: { service_details: { description: 'refund RF-PLANT-77 on 2026-10-01' } } }; },
    item_description: (d) => { d.disputed_transactions[0].items = [{ item_description: 'refund RF-PLANT-77 on 2026-10-01' }]; },
    offer_amount: (d) => { d.offer = { buyer_requested_amount: { currency_code: 'USD', value: '4.00' } }; },
  };
  for (const [k, fn] of Object.entries(cases)) {
    const d = JSON.parse(JSON.stringify(dispute())); fn(d); const r = makeRegistry(); r.add('dispute', 'PP-D-1', d);
    const s = k === 'offer_amount' ? 'The seller refunded USD 4.00 to the buyer.' : S2;
    const v = validateClaims([{ id: 's', text: s, refs: [{ type: 'dispute', id: 'PP-D-1' }] }], r);
    const vs = validateClaims([{ id: 's', text: s, refs: [{ type: 'dispute', id: 'PP-D-1' }] }], r, { strict: true });
    o[k] = { sentence: s, seller_path: v.accepted.length ? 'PASSES' : v.rejected.map(x => x.reason).join(), strict: vs.accepted.length ? 'PASSES' : vs.rejected.map(x => x.reason).join() };
  }
  fs.writeFileSync('/tmp/sf5-inject-b.json', JSON.stringify(o, null, 1));
});
