// Policy references shown next to every flag. ProofPilot is not legal advice: rules vary by country and change,
// so each flag links to PayPal's own page for the seller to confirm.
export const POLICY = {
  sellerProtection: 'https://www.paypal.com/us/webapps/mpp/security/seller-protection',
  userAgreementSP: 'https://www.paypal.com/us/legalhub/paypal/useragreement-full#seller-protection',
  holdsAndTracking: 'https://www.paypal.com/us/cshelp/article/HELP129',
  disputesApi: 'https://developer.paypal.com/docs/api/customer-disputes/v1/',
  trackingApi: 'https://developer.paypal.com/docs/tracking/',
};
// US Seller Protection: signature confirmation is required for transactions of USD 750 or more (check current policy).
export const SIGNATURE_THRESHOLD_USD = 750;
