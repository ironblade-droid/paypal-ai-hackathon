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

## The "AI" part, honestly
No LLM key is configured in this build, so recommendations come from a **deterministic rules engine** (`src/engine/recommend.js`, `proofpilot-rules-v1`). The UI labels it as rules, not AI.

It is written as an **LLM hook**: any engine exposing `{ name, kind, recommend(context) }` can replace it. The contract is that an LLM engine may rank or explain, but every claim it proposes must still pass `validateClaims()` unchanged, and the seller still approves. Planned wiring: `@paypal/agent-toolkit` (Disputes and Shipment Tracking tools) with a model, when a key is available. That is **not built yet**.

## Run it

Requires Node 20+ and a PayPal **sandbox** REST app (developer.paypal.com → Apps & Credentials → Sandbox). Use your own sandbox keys; never use live keys.

```bash
npm install
export PAYPAL_SANDBOX_CLIENT_ID=...       # sandbox app client id
export PAYPAL_SANDBOX_CLIENT_SECRET=...   # sandbox app secret (never commit it; .env is git-ignored)
npm start                                 # http://localhost:3000
```

Optional env: `PAYPAL_SANDBOX_WEBHOOK_ID` (verify webhooks), `PROOFPILOT_DRY_RUN=1` (read-only, nothing is sent), `PROOFPILOT_ACCEPT_BELOW=10` (rules engine accept threshold), `PROOFPILOT_ENABLE_SANDBOX_TOOLS=1` (sandbox test helpers below), `PORT`.

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

## Tests
```bash
npm test               # unit + app tests; the sandbox integration test is skipped without the env vars
npm run test:sandbox   # live sandbox: token, list disputes, analyse PROOFPILOT_TEST_DISPUTE_ID (default PP-R-PGV-10190981), create one unapproved order
npm run secret-scan    # gitleaks if installed, plus env-value and key-pattern grep
```

## Deploy (optional)
`render.yaml` is a Render Blueprint. Set the sandbox env vars in the Render dashboard. The JSON store lives in `/tmp` there, so local seller data resets on restart; PayPal remains the source of truth.

## Limits
- Sandbox only. The sandbox does not settle cases on its own; ProofPilot never calls `adjudicate` and never claims a case outcome.
- Seller Protection checks are a subset of PayPal's rules (address, signature threshold, capture state, eligibility PayPal reports, goods type).
- Local data (orders created here, approvals, webhook log) is a JSON file in `data/` (git-ignored).

## License
MIT. See `LICENSE`.
