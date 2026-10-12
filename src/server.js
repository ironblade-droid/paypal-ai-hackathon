import { loadConfig } from './config.js';
import { createPayPalClient } from './paypal/client.js';
import { createApi } from './paypal/api.js';
import { createStore } from './lib/store.js';
import { createDecisionEngine } from './engine/recommend.js';
import { createApp } from './app.js';
import { createLlmProvider } from './ai/providers.js';
import { loadToolkitTools } from './ai/agent.js';
import { log } from './lib/redact.js';
import { createPgMirror, attachPgMirror, createPgPool } from './lib/pgMirror.js';

const config = loadConfig();
const api = config.hasCredentials ? createApi(createPayPalClient(config)) : null;
const llm = createLlmProvider();
// PayPal Agent Toolkit tools (sandbox) for the Gemini agent; created lazily on the first agent run.
let toolkitTools = null;
const agentTools = llm?.languageModel && config.hasCredentials ? () => (toolkitTools ||= loadToolkitTools(config)) : null;
const store = createStore(config.dataFile);
const app = createApp({ api, store, engine: createDecisionEngine(), config, llm, agentTools });
// Listen first: the database (if any) attaches in the background, so a hanging DB host never blocks Render's health check.
export const ready = attachDatabase();
app.listen(config.port, () => {
  log(`ProofPilot (PayPal SANDBOX) on http://localhost:${config.port}  credentials=${config.hasCredentials ? 'set' : 'MISSING'} dryRun=${config.dryRun} ai=${llm ? llm.label + (agentTools ? ' + PayPal Agent Toolkit agent' : '') : 'not configured (rules engine only)'}`);
});
async function attachDatabase() {
  if (!config.databaseUrl) { log('Store: local file only (DATABASE_URL not set; resets on a Render restart)'); return; }
  try { await attachPgMirror(store, createPgMirror({ pool: await createPgPool(config.databaseUrl) })); log('Store: Postgres (DATABASE_URL) + local file'); }
  catch (e) { log('Postgres store unavailable, using the file store only:', e?.code || e?.message || 'error'); }
}
// On Render's SIGTERM (restart/redeploy) finish the last Postgres write, waiting at most 5 s.
process.once('SIGTERM', async () => { try { await store.pgMirror?.flushWithin(5000); } finally { process.exit(0); } });
