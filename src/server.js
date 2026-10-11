import { loadConfig } from './config.js';
import { createPayPalClient } from './paypal/client.js';
import { createApi } from './paypal/api.js';
import { createStore } from './lib/store.js';
import { createDecisionEngine } from './engine/recommend.js';
import { createApp } from './app.js';
import { createLlmProvider } from './ai/providers.js';
import { log } from './lib/redact.js';

const config = loadConfig();
const api = config.hasCredentials ? createApi(createPayPalClient(config)) : null;
const llm = createLlmProvider();
const app = createApp({ api, store: createStore(config.dataFile), engine: createDecisionEngine(), config, llm });
app.listen(config.port, () => {
  log(`ProofPilot (PayPal SANDBOX) on http://localhost:${config.port}  credentials=${config.hasCredentials ? 'set' : 'MISSING'} dryRun=${config.dryRun} ai=${llm ? llm.label : 'not configured (rules engine only)'}`);
});
