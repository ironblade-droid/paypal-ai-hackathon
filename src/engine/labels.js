// Plain-language labels for PayPal codes. The raw code is still shown next to the label for traceability.
export const LABELS = {
  reason: {
    MERCHANDISE_OR_SERVICE_NOT_RECEIVED: 'Item not received',
    MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: 'Item not as described',
    UNAUTHORISED: 'Unauthorized payment',
    CREDIT_NOT_PROCESSED: 'Refund not processed',
    DUPLICATE_TRANSACTION: 'Duplicate payment',
    INCORRECT_AMOUNT: 'Wrong amount charged',
    PAYMENT_BY_OTHER_MEANS: 'Paid by another method',
    CANCELED_RECURRING_BILLING: 'Cancelled subscription still billed',
    PROBLEM_WITH_REMITTANCE: 'Problem with payment',
    OTHER: 'Other',
  },
  stage: {
    INQUIRY: 'Inquiry (buyer and seller try to resolve it)',
    CHARGEBACK: 'Claim (escalated to PayPal)',
    PRE_ARBITRATION: 'Pre-arbitration',
    ARBITRATION: 'Arbitration',
  },
  evidence: {
    PROOF_OF_FULFILLMENT: 'Proof of shipment / delivery',
    PROOF_OF_REFUND: 'Proof of refund',
    PROOF_OF_DELIVERY_SIGNATURE: 'Delivery signature',
    PROOF_OF_RECEIPT_COPY: 'Copy of receipt',
    RETURN_POLICY: 'Return policy',
    BILLING_AGREEMENT: 'Billing agreement',
    PROOF_OF_RESHIPMENT: 'Proof of reshipment',
    ITEM_DESCRIPTION: 'Item description',
    POLICE_REPORT: 'Police report',
    AFFIDAVIT: 'Affidavit',
    PAID_WITH_OTHER_METHOD: 'Paid with another method',
    COPY_OF_CONTRACT: 'Copy of contract',
    TERMINAL_ATM_RECEIPT: 'Terminal / ATM receipt',
    PRICE_DIFFERENCE_REASON: 'Reason for price difference',
    SOURCE_CONVERSION_RATE: 'Currency conversion rate',
    BANK_STATEMENT: 'Bank statement',
    CREDIT_DUE_REASON: 'Reason credit is due',
    REQUEST_CREDIT_RECEIPT: 'Credit receipt',
    PROOF_OF_RETURN: 'Proof of return',
    CREATE: 'Buyer opened the case',
    CHANGE_REASON: 'Reason changed',
    OTHER: 'Other documents',
    SUPPORTING_INFO: 'Supporting information',
  },
  action: {
    provide_evidence: 'Send evidence', provide_supporting_info: 'Add supporting info', accept_claim: 'Accept and refund',
    make_offer: 'Make an offer', escalate: 'Escalate to a claim', send_message: 'Message the buyer', acknowledge_return_item: 'Confirm return received',
    require_evidence: 'Sandbox: request evidence', adjudicate: 'Sandbox: settle case',
  },
  source: { SUBMITTED_BY_BUYER: 'Buyer', SUBMITTED_BY_SELLER: 'You (seller)', SUBMITTED_BY_PARTNER: 'Partner', REQUESTED_FROM_SELLER: 'PayPal asked you', REQUESTED_FROM_BUYER: 'PayPal asked buyer' },
  protection: { EXPANDED_SELLER_PROTECTION: 'Expanded Seller Protection', SELLER_PROTECTION: 'Seller Protection' },
  paypalStatus: {
    OPEN: 'Open', WAITING_FOR_SELLER_RESPONSE: 'Waiting for your response', WAITING_FOR_BUYER_RESPONSE: 'Waiting for the buyer',
    UNDER_REVIEW: 'Under PayPal review', RESOLVED: 'Closed by PayPal', OTHER: 'Other',
  },
  riskflag: { ADDRESS_MISMATCH: 'Address changed', NO_SHIPPING_ADDRESS: 'No ship-to address', CAPTURE_NOT_COMPLETED: 'Payment not settled', SIGNATURE_REQUIRED: 'Signature needed',
    NOT_PHYSICAL_GOODS: 'Not physical goods', NO_CAPTURE: 'Not captured', NO_ORDER_RECORD: 'No order record', SELLER_PROTECTION_NOT_ELIGIBLE: 'Not protected', SELLER_PROTECTION_PARTIALLY_ELIGIBLE: 'Partly protected' },
  capture: { COMPLETED: 'Completed', PENDING: 'Pending', DECLINED: 'Declined', REFUNDED: 'Refunded', PARTIALLY_REFUNDED: 'Partly refunded' },
  captureReason: { BUYER_COMPLAINT: 'held because the buyer opened a case', PENDING_REVIEW: 'under PayPal review', ECHECK: 'eCheck not cleared' },
};

export function human(kind, code) {
  if (code == null || code === '') return '';
  return LABELS[kind]?.[code] || String(code).toLowerCase().replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase());
}
