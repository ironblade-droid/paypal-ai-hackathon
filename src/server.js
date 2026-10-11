import { loadConfig } from './config.js';
import { createPayPalClient } from './paypal/client.js';
import { createApi } from './paypal/api.js';
import { createStore } from './lib/store.js';
import { createDecisionEngine } from './engine/recommend.js';
import { createApp } from './app.js';
import { createLlmProvider } from './ai/providers.js';
import { loadToolkitTools } from './ai/agent.js';
import { log } from './lib/redact.js';

const config = loadConfig();
const api = config.hasCredentials ? createApi(createPayPalClient(config)) : null;
const llm = createLlmProvider();
// PayPal Agent Toolkit tools (sandbox) for the Gemini agent; created lazily on the first agent run.
let toolkitTools = null;
const agentTools = llm?.languageModel && config.hasCredentials ? () => (toolkitTools ||= loadToolkitTools(config)) : null;
const app = createApp({ api, store: createStore(config.dataFile), engine: createDecisionEngine(), config, llm, agentTools });
app.listen(config.port, () => {
  log(`ProofPilot (PayPal SANDBOX) on http://localhost:${config.port}  credentials=${config.hasCredentials ? 'set' : 'MISSING'} dryRun=${config.dryRun} ai=${llm ? llm.label + (agentTools ? ' + PayPal Agent Toolkit agent' : '') : 'not configured (rules engine only)'}`);
});
