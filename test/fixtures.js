// Fixtures shaped like real sandbox responses (sandbox test data only).
export const capture = { id: 'CAP123', status: 'COMPLETED', amount: { currency_code: 'USD', value: '5.50' }, create_time: '2026-10-11T09:06:31Z',
  seller_protection: { status: 'ELIGIBLE', dispute_categories: ['ITEM_NOT_RECEIVED', 'UNAUTHORIZED_TRANSACTION'] },
  supplementary_data: { related_ids: { order_id: 'ORD123' } } };
export const order = { id: 'ORD123', status: 'COMPLETED', payer: { address: { country_code: 'US' } },
  purchase_units: [{ amount: { currency_code: 'USD', value: '5.50' },
    shipping: { address: { address_line_1: '2211 N First St', admin_area_2: 'San Jose', admin_area_1: 'CA', postal_code: '95131', country_code: 'US' } },
    payments: { captures: [capture], refunds: [] } }] };
// last_updated_time 2026-10-11T09:13:20Z: registered before the fixture dispute opened (09:22:26Z).
export const tracker = { transaction_id: 'CAP123', tracking_number: '9400111899223197428490', carrier: 'USPS', status: 'SHIPPED', last_updated_time: '1791710000000' };
// Registered 2026-10-11T10:31:48Z, after the fixture dispute opened.
export const lateTracker = { transaction_id: 'CAP123', tracking_number: '9400111899562537866358', carrier: 'USPS', status: 'SHIPPED', last_updated_time: '1791714708929' };
export const links = (...rels) => [{ rel: 'self', href: 'x', method: 'GET' }, ...rels.map(r => ({ rel: r, href: 'x/' + r, method: 'POST' }))];
export function dispute(over = {}) {
  return { dispute_id: 'PP-D-1', create_time: '2026-10-11T09:22:26Z', reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', status: 'WAITING_FOR_SELLER_RESPONSE',
    dispute_life_cycle_stage: 'INQUIRY', dispute_amount: { currency_code: 'USD', value: '5.50' }, seller_response_due_date: '2026-10-21T09:22:26Z',
    disputed_transactions: [{ buyer_transaction_id: 'BUY1', seller_transaction_id: 'CAP123', seller_protection_eligible: true, seller_protection_type: 'EXPANDED_SELLER_PROTECTION' }],
    evidences: [{ evidence_type: 'CREATE', source: 'SUBMITTED_BY_BUYER', dispute_life_cycle_stage: 'INQUIRY' },
      { evidence_type: 'PROOF_OF_FULFILLMENT', source: 'REQUESTED_FROM_SELLER', dispute_life_cycle_stage: 'INQUIRY' }],
    links: links('provide_evidence', 'accept_claim'), ...over };
}
export function fakeApi({ d = dispute(), trackers = [tracker], calls = [] } = {}) {
  const rec = (name) => (...args) => { calls.push({ name, args }); return Promise.resolve({ links: [] }); };
  let state = d;
  return { calls,
    getDispute: async () => state, listDisputes: async () => ({ items: [state] }),
    getCapture: async () => capture, getOrder: async () => order, listTrackers: async () => ({ trackers }),
    provideEvidence: async (...a) => { calls.push({ name: 'provideEvidence', args: a }); state = { ...state, status: 'UNDER_REVIEW', links: links() }; return { links: [] }; },
    provideSupportingInfo: rec('provideSupportingInfo'), acceptClaim: rec('acceptClaim'), makeOffer: rec('makeOffer'),
    createOrder: async () => ({ id: 'ORDNEW', status: 'CREATED' }), captureOrder: async () => order, addTracking: rec('addTracking'),
    verifyWebhook: async () => ({ verification_status: 'SUCCESS' }) };
}
