// Approval-code delivery (review v0.5 e). The code for an agent write must reach the local operator but must not end up
// in stdout, a log stream, an HTTP response or the repo.
//   - Full code: written to a file with mode 0600 in a 0700 folder OUTSIDE the repo
//     (PROOFPILOT_APPROVAL_CODE_DIR, default ~/.proofpilot/approval-codes), one file per proposal, deleted when the code
//     is used or voided.
//   - stdout / logs: only the masked code (APPROVE-*****-**XYZ style, last 4 characters) and the file path.
//   - Interactive terminal: if stderr is a TTY, the full code is also shown once on stderr (not when output is piped
//     or captured by a host's log collector).
// Hosted demo: the host owner reads the file through the host's shell. PROOFPILOT_APPROVAL_CODE_TO_LOG=1 prints the
// full code to stderr even without a TTY; it is an explicit opt-in and anyone who can read that log can then approve.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function approvalCodeDir(env = process.env) {
  return env.PROOFPILOT_APPROVAL_CODE_DIR || path.join(os.homedir(), '.proofpilot', 'approval-codes');
}
const safeId = (id) => String(id).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
export function approvalCodeFile(proposalId, env = process.env) { return path.join(approvalCodeDir(env), `${safeId(proposalId)}.txt`); }
export function maskCode(code) { const s = String(code || ''); return s.length <= 4 ? '****' : s.slice(0, -4).replace(/[A-Z0-9]/g, (c, i) => (i < 8 ? c : '*')) + s.slice(-4); }

export function removeApprovalCodeFile(proposalId, env = process.env) { try { fs.rmSync(approvalCodeFile(proposalId, env), { force: true }); } catch { /* best effort */ } }

export function deliverApprovalCode({ proposalId, disputeId, description, code, expiresAt }, { env = process.env, stdout = process.stdout, stderr = process.stderr } = {}) {
  const dir = approvalCodeDir(env);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* not owner */ }
  const file = approvalCodeFile(proposalId, env);
  fs.rmSync(file, { force: true });
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeSync(fd, `${code}\n# proposal ${proposalId} on dispute ${disputeId}; single use; expires ${expiresAt}\n`); } finally { fs.closeSync(fd); }
  stdout.write(`\n[ProofPilot] Approval code for proposal ${proposalId} on dispute ${disputeId}\n  ${description}\n  Code: ${maskCode(code)} (masked; ends in ${String(code).slice(-4)}). Full code in ${file} (mode 0600). Single use, expires ${expiresAt}; type it on the dispute page to approve; never sent over the API.\n\n`);
  if (stderr?.isTTY || env.PROOFPILOT_APPROVAL_CODE_TO_LOG === '1') stderr.write(`[ProofPilot] Full approval code (shown once): ${code}\n`);
  return { file };
}
