// Cached demo run (review v0.4, finding 4). The Gemini free tier has tight rate limits, so a hosted demo
// can run out during judging. docs/demo/cached-agent-run.json is ONE real agent run recorded earlier on the sandbox
// (redacted). It is served only as kind CACHED_DEMO, with its recording time, model and dispute id, and its proposals are
// marked CACHED_NOT_APPROVABLE. ProofPilot never presents it as a live answer and never acts on it.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const CACHED_DEMO_FILE = fileURLToPath(new URL('../../docs/demo/cached-agent-run.json', import.meta.url));
export function loadCachedDemoRun(file = CACHED_DEMO_FILE) {
  let d; try { d = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  if (d?.kind !== 'CACHED_DEMO' || !d.run) return null;
  const run = { ...d.run, proposals: (d.run.proposals || []).map(({ tokenDigest: _t, approvalCode: _c, ...p }) => ({ ...p, status: 'CACHED_NOT_APPROVABLE', liveCode: false })) };
  return { ...d, kind: 'CACHED_DEMO', live: false, approvable: false, run };
}
