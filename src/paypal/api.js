const baseUrl = () => (process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, '');
// Typed wrappers for the PayPal APIs ProofPilot uses: Orders v2, Payments v2, Shipment Tracking, Disputes v1, Webhooks.
export function normaliseRel(rel) { return String(rel || '').replace(/-/g, '_'); }
export function linkRels(obj) { return (obj?.links || []).map(l => normaliseRel(l.rel)); }

export function createApi(client) {
  return {
    // ---- Orders v2
    createOrder: ({ items, currency = 'USD', invoiceId, description }) => {
      const total = items.reduce((s, i) => s + Number(i.unit_amount.value) * Number(i.quantity), 0).toFixed(2);
      return client.post('/v2/checkout/orders', {
        intent: 'CAPTURE',
        purchase_units: [{
          invoice_id: invoiceId, description,
          amount: { currency_code: currency, value: total, breakdown: { item_total: { currency_code: currency, value: total } } },
          items,
        }],
        payment_source: { paypal: { experience_context: { shipping_preference: 'GET_FROM_FILE', user_action: 'PAY_NOW', brand_name: 'ProofPilot Demo Shop (sandbox)',
          return_url: `${baseUrl()}/?checkout=return`, cancel_url: `${baseUrl()}/?checkout=cancel` } } },
      }, { Prefer: 'return=representation' });
    },
    captureOrder: (id) => client.post(`/v2/checkout/orders/${encodeURIComponent(id)}/capture`, {}, { Prefer: 'return=representation' }),
    getOrder: (id) => client.get(`/v2/checkout/orders/${encodeURIComponent(id)}`),
    getCapture: (id) => client.get(`/v2/payments/captures/${encodeURIComponent(id)}`),
    // ---- Shipment tracking (Orders v2 track endpoint + v1 trackers lookup)
    addTracking: (orderId, { captureId, trackingNumber, carrier, notifyPayer = false }) =>
      client.post(`/v2/checkout/orders/${encodeURIComponent(orderId)}/track`,
        { capture_id: captureId, tracking_number: trackingNumber, carrier, notify_payer: notifyPayer }),
    listTrackers: (transactionId) => client.get(`/v1/shipping/trackers?transaction_id=${encodeURIComponent(transactionId)}`),
    // ---- Disputes v1
    listDisputes: (pageSize = 50) => client.get(`/v1/customer/disputes?page_size=${pageSize}`),
    getDispute: (id) => client.get(`/v1/customer/disputes/${encodeURIComponent(id)}`),
    provideEvidence: (id, input, files) => client.postMultipart(`/v1/customer/disputes/${encodeURIComponent(id)}/provide-evidence`, input, files),
    provideSupportingInfo: (id, notes, files) => client.postMultipart(`/v1/customer/disputes/${encodeURIComponent(id)}/provide-supporting-info`, { notes }, files),
    acceptClaim: (id, note) => client.post(`/v1/customer/disputes/${encodeURIComponent(id)}/accept-claim`, { note }),
    makeOffer: (id, { note, amount, offerType = 'REFUND' }) =>
      client.post(`/v1/customer/disputes/${encodeURIComponent(id)}/make-offer`, { note, offer_amount: amount, offer_type: offerType }),
    // Sandbox-only buyer simulation (needs buyer consent; see README "Creating a fresh sandbox dispute")
    createSandboxDispute: ({ buyerEmail, buyerTransactionId, amount, clientId }) => {
      const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
      const assertion = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ iss: clientId, email: buyerEmail })}.`;
      return client.postMultipart('/v1/customer/disputes', {
        disputed_transactions: [{ buyer_transaction_id: buyerTransactionId }],
        reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
        dispute_amount: amount,
        extensions: { merchant_contacted: true, merchant_contacted_outcome: 'NO_RESPONSE', merchandize_dispute_properties: { issue_type: 'PRODUCT' } },
      }, [], { 'PayPal-Auth-Assertion': assertion });
    },
    requireEvidence: (id, action = 'SELLER_EVIDENCE') => client.post(`/v1/customer/disputes/${encodeURIComponent(id)}/require-evidence`, { action }),
    // ---- Webhooks
    verifyWebhook: (payload) => client.post('/v1/notifications/verify-webhook-signature', payload),
  };
}
