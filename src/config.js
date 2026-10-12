// Central config. ProofPilot is SANDBOX ONLY: the API base is hard-wired and cannot be overridden.
export const PAYPAL_API_BASE = 'https://api-m.sandbox.paypal.com';
export const PAYPAL_SDK_URL = 'https://www.paypal.com/sdk/js'; // sandbox is selected by the sandbox client id

export function loadConfig(env = process.env) {
  return {
    clientId: env.PAYPAL_SANDBOX_CLIENT_ID || '',
    clientSecret: env.PAYPAL_SANDBOX_CLIENT_SECRET || '',
    databaseUrl: env.DATABASE_URL || '',
    webhookId: env.PAYPAL_SANDBOX_WEBHOOK_ID || '',
    port: Number(env.PORT || 3000),
    dryRun: env.PROOFPILOT_DRY_RUN === '1',
    writePasscode: env.PROOFPILOT_WRITE_PASSCODE || '',
    dataFile: env.PROOFPILOT_DATA_FILE || new URL('../data/store.json', import.meta.url).pathname,
    hasCredentials: Boolean(env.PAYPAL_SANDBOX_CLIENT_ID && env.PAYPAL_SANDBOX_CLIENT_SECRET),
  };
}
