# ProofPilot

Dispute prevention and record-cited evidence for small PayPal sellers. **PayPal sandbox only.**

ProofPilot checks an order for things that can void PayPal Seller Protection *before* you ship, pushes tracking to PayPal, and, when a dispute arrives, builds an evidence pack in which every statement links to a real PayPal record (order, capture, tracker, refund). A checker refuses any statement without a linked record. You approve the exact pack before anything is sent.

> Not legal advice. Seller Protection rules vary by country and change. Every flag links to PayPal's own page.
> ProofPilot never claims an outcome: after you submit, the case shows **Under PayPal review** until PayPal itself closes it.

## What it does

| Page | What happens | PayPal APIs |
|---|---|---|
| `/` Demo shop | Real PayPal JS SDK button (sandbox). Our backend creates and captures the order; prices are server-side. | Orders v2 create + capture |
| `/seller` Orders & shipping | AG Grid of orders with a readiness score. Pre-ship check re-reads the order and capture from PayPal and flags: address redirect, missing shipping address, capture not completed, Seller Protection not eligible, USD 750+ without signature, digital goods. Blocking flags stop shipping unless you type an explicit override. Shipping adds tracking and reads the tracker back. | Orders v2 get, Payments v2 captures, Orders v2 `/track`, Shipment Tracking `/v1/shipping/trackers` |
| `/disputes` Dispute queue | AG Grid **Community** (no Enterprise features, no licence key) of live disputes: plain-language status, response deadline, what PayPal asks for, which actions PayPal offers. Auto-refresh. | Disputes v1 list + get |
| `/disputes/:id` Dispute detail | Reads what PayPal requests and the deadline. Offers **only the evidence types this dispute lists as requested** (never a fixed list). Builds a cited pack per type, shows gaps, shows a FIGHT / OFFER / ACCEPT / WAIT recommendation, then submits after you type APPROVE. Shows the status before and after. New disputes show **Waiting for PayPal** and poll every 15 s (PayPal takes about 3 to 5 minutes to offer actions). | Disputes v1 `provide-evidence` (multipart + PDF), `provide-supporting-info`, `make-offer`, `accept-claim` |
| `POST /api/webhooks/paypal` | Receives PayPal webhooks; verifies them with PayPal when `PAYPAL_SANDBOX_WEBHOOK_ID` is set, otherwise stores them marked unverified. | Webhooks verify-signature |

### How submission is guarded
1. The action must be one PayPal currently offers on the dispute (HATEOAS links).
2. The evidence type must be one the dispute requests.
3. Every claim must cite a record ProofPilot fetched from PayPal in this request (`NO_LINKED_RECORD` / `UNKNOWN_RECORD` otherwise).
4. The type's required record must be present (a tracker for `PROOF_OF_FULFILLMENT`, a completed refund for `PROOF_OF_REFUND`).
5. The pack hash you approved must match the pack being sent (`PACK_CHANGED` otherwise), and you must send `approved: true, confirm: "APPROVE"`.

## Tools used (AI and PayPal)
| Tool | How ProofPilot uses it | Status in this build |
|---|---|---|
| **Google Gemini** `gemini-3.8-flash` (Gemini API free tier; `GEMINI_API_KEY`, override with `GEMINI_MODEL`) | AI advisor: recommends fight / offer / accept / wait with a cited rationale and drafts the evidence narrative from the PayPal records ProofPilot fetched. Called via `generateContent` with JSON output. | Code and mocked tests done. **Not yet run against a real key** (no key configured yet). |
| **Groq** `openai/gpt-oss-20b` (OpenAI-compatible endpoint; `GROQ_API_KEY`, override with `GROQ_MODEL`) | Same advisor, alternative provider (`PROOFPILOT_LLM_PROVIDER=groq`). Groq retired its free Llama models on 16 Aug 2026, so the default is GPT-OSS 20B. | Code and mocked tests done. **Not yet run against a real key.** |
| ProofPilot rules engine `proofpilot-rules-v1` (deterministic, not AI) | Fallback when no key is set or the model call fails, and a sanity check on the model's recommendation. Labelled "rules engine" in the UI. | Live |
| PayPal Orders v2, Payments v2, Shipment Tracking, Disputes v1, Webhooks, JS SDK | See the table above. | Live in sandbox |
| AG Grid Community 32 | Dispute queue and orders grids with a custom theme and cell renderers (status chips, live deadline countdown, evidence chips, readiness bars). No Enterprise features. | Live |

### How the AI is kept honest
1. The model only sees digests of records ProofPilot fetched from PayPal (no buyer or seller emails or names) and must end every sentence with inline citations like `[capture:1AU666173Y707472F]`.
2. Each sentence is checked on its own by the citation checker in strict mode. It is refused if it cites nothing (`NO_LINKED_RECORD`), cites a record that was not fetched (`UNKNOWN_RECORD`), states an amount or id that is not in the cited record (`VALUE_NOT_IN_CITED_RECORD`), or predicts an outcome (`OUTCOME_CLAIM`). Refused sentences are shown, struck out, with the reason.
3. The model's action must be one PayPal currently offers; its evidence type must be one the dispute requests. A FIGHT without a complete cited pack is replaced by the rules engine's answer, and the UI shows whether the model agrees with the rules engine.
4. AI-drafted sentences the seller ticks are re-checked on the server at submit time, and the seller must approve the exact pack (hash-bound).
5. With no key, the UI says "AI not configured" and shows only the rules engine. No AI output is ever simulated.

## Run it

Requires Node 20+ and a PayPal **sandbox** REST app (developer.paypal.com → Apps & Credentials → Sandbox). Use your own sandbox keys; never use live keys.

```bash
npm install
export PAYPAL_SANDBOX_CLIENT_ID=...       # sandbox app client id
export PAYPAL_SANDBOX_CLIENT_SECRET=...   # sandbox app secret (never commit it; .env is git-ignored)
npm start                                 # http://localhost:3000
```

Optional env:
- AI: `GEMINI_API_KEY` (+ `GEMINI_MODEL`), `GROQ_API_KEY` (+ `GROQ_MODEL`), `PROOFPILOT_LLM_PROVIDER=gemini|groq`.
- `PAYPAL_SANDBOX_WEBHOOK_ID` (verify webhooks; dispute webhooks are then auto-analysed).
- `PROOFPILOT_DRY_RUN=1` (read-only, nothing is sent), `PROOFPILOT_WRITE_PASSCODE=...` (a public host asks for this passcode before shipping, submitting, sandbox tools or AI calls).
- `PROOFPILOT_ACCEPT_BELOW=10` (rules engine accept threshold), `PROOFPILOT_ENABLE_SANDBOX_TOOLS=1` (sandbox test helpers below), `PORT`.

The API base is hard-wired to `https://api-m.sandbox.paypal.com`.

### Sandbox app settings
- Enable **Customer disputes** (and Transaction search) on the app.
- Card checkout may not be enabled on a fresh sandbox business account; use the PayPal button with a sandbox **personal** account.

### Demo paths
**A. Existing dispute.** Open `/disputes`, click a dispute. If PayPal is reviewing it, it shows **Under PayPal review** and the engine recommends WAIT. If the sandbox offers `require_evidence` on that case, the detail page shows a clearly labelled sandbox tool that simulates PayPal requesting seller evidence (needs `PROOFPILOT_ENABLE_SANDBOX_TOOLS=1`), after which the evidence flow is available.

**B. Fresh dispute.**
1. Buy the USD 5.50 sticker pack on `/` with a sandbox personal account.
2. On `/seller`, select the order, run the pre-ship check, add tracking.
3. Open a dispute as the buyer: either in the sandbox buyer's Resolution Center, or with `POST /api/sandbox/disputes {buyerEmail, buyerTransactionId}` (needs `PROOFPILOT_ENABLE_SANDBOX_TOOLS=1`, the buyer's one-time *Log in with PayPal* consent for the app, and the **buyer-side** transaction id from the buyer's Activity page). Each transaction can only have one dispute.
4. Open the dispute: it shows **Waiting for PayPal** and polls until actions appear (about 3 to 5 minutes).
5. Review the cited pack, type APPROVE, submit. The page shows the status change, for example *Your response needed → Under PayPal review*.

## Testing instructions for judges
- **Fastest path:** open the hosted demo (URL in the Devpost entry once deployed), go to **Dispute queue**, open `PP-R-PGV-10190981`. It is a real sandbox dispute ProofPilot has worked on; see `docs/DEMO.md` for what each screen shows.
- **Run locally with your own sandbox:** create a sandbox REST app, set the two env vars above, `npm install && npm start`.
- **Sandbox test buyer for the demo shop:** `sb-nfcu353297565@personal.example.com` (US personal sandbox account). Passwords are not published: passwords come from the judges' own sandbox, so use a personal test account from your sandbox (developer.paypal.com → Testing Tools → Sandbox Accounts) together with your own sandbox app keys.
- Everything is PayPal **sandbox** test data. Tracking numbers are sandbox test numbers (no real parcel) and are labelled as such in the UI and in the evidence PDF.
- After evidence is accepted, PayPal shows the case as **Under PayPal review**. The sandbox does not settle cases by itself and ProofPilot never calls the sandbox `adjudicate` endpoint, so the demo never shows a case outcome.

## Tests
```bash
npm test               # unit + app + AI (mocked provider) tests. Never calls PayPal: the sandbox test is opt-in
npm run test:sandbox   # live sandbox (opt-in): token, list disputes, analyse PROOFPILOT_TEST_DISPUTE_ID (default PP-R-PGV-10190981), create one unapproved order
npm run secret-scan    # gitleaks if installed, plus env-value and key-pattern grep
```

## Deploy (optional)
`render.yaml` is a Render Blueprint. Set the sandbox env vars in the Render dashboard. The JSON store lives in `/tmp` there, so local seller data resets on restart; PayPal remains the source of truth.

## Limits
- AI advisor: Gemini and Groq integrations are implemented and tested with mocked providers only, until a key is configured.
- PayPal codes are shown in plain words (raw code on hover). A refund record that matches the dispute's `HOLD_PLACED` fund movement is PayPal's dispute hold, not a seller refund, and is never used as proof of refund.
- Requested evidence types ProofPilot cannot back with a PayPal record (for example a delivery signature) are shown as gaps and cannot be sent under that label. If PayPal refuses a type (`EVIDENCE_TYPE_IS_NOT_ALLOWED`), ProofPilot records it and stops recommending that type for the dispute.
- Sandbox only. The sandbox does not settle cases on its own; ProofPilot never calls `adjudicate` and never claims a case outcome.
- Seller Protection checks are a subset of PayPal's rules (address, signature threshold, capture state, eligibility PayPal reports, goods type).
- Local data (orders created here, approvals, webhook log) is a JSON file in `data/` (git-ignored).

## License
MIT. See `LICENSE`.
