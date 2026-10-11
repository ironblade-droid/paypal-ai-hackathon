# ProofPilot (v0.4.0)

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
| `/disputes/:id` Dispute detail | Reads what PayPal requests and the deadline. Offers **only the evidence types this dispute lists as requested** (never a fixed list). Builds a cited pack per type, shows gaps, shows a FIGHT / OFFER / ACCEPT / WAIT recommendation, then submits after you type APPROVE (evidence packs are also hash-bound). Shows the status before and after. New disputes show **Waiting for PayPal** and poll every 15 s (PayPal takes about 3 to 5 minutes to offer actions). | Disputes v1 `provide-evidence` (multipart + PDF), `provide-supporting-info`, `make-offer`, `accept-claim` |
| `POST /api/webhooks/paypal` | Receives PayPal webhooks; verifies them with PayPal when `PAYPAL_SANDBOX_WEBHOOK_ID` is set, otherwise stores them marked unverified. | Webhooks verify-signature |

### How submission is guarded
1. The action must be one PayPal currently offers on the dispute (HATEOAS links).
2. The evidence type must be one the dispute requests, and not one PayPal already refused on this dispute at this stage (`TYPE_REFUSED_BY_PAYPAL`, see below).
3. What the checker verifies, and what it does not:
   - Every statement must cite a record ProofPilot fetched from PayPal in this request (`NO_LINKED_RECORD` / `UNKNOWN_RECORD`).
   - Any amount (`USD 5.50`, `$9`, `550 USD`), date (`2026-10-01`, `October 1`, `1 Oct 2026`, `10/01/2026`) or id (any letter case) in the sentence must appear in the cited record (`VALUE_NOT_IN_CITED_RECORD`).
   - No text after the last citation (`TEXT_AFTER_CITATION`), and a new sentence always needs its own citation, even if it starts in lowercase.
   - Wording that predicts or describes a case outcome is refused (`OUTCOME_CLAIM`). This is a pattern list, so it catches common phrasings, not every possible one.
   - A tracker registered after the dispute opened cannot be cited as shipment proof (`LATE_TRACKING`).
   - ProofPilot's own pack statements and the AI's are rendered from record fields (see "How the AI is kept honest"). A statement you type yourself is marked "Seller's own statement" in what PayPal receives: the checker verifies its citation and values, not the rest of your wording.
4. The type's required record must be present: a tracker registered **before** the dispute opened for `PROOF_OF_FULFILLMENT` (later tracking is labelled "added after dispute opened" and not used as proof of shipment), a completed seller refund for `PROOF_OF_REFUND`.
5. The pack hash you approved must match the pack being sent (`PACK_CHANGED` otherwise), and you must send `approved: true, confirm: "APPROVE"`.

### PayPal refusals are remembered
When PayPal answers `EVIDENCE_TYPE_IS_NOT_ALLOWED`, ProofPilot stores the type, stage and debug id. Refusals seen in the team sandbox are committed in `seed/paypal-refusals.json`, so a fresh install or the hosted demo knows them too. While the dispute is in that stage, neither the rules engine nor the AI advisor recommends that type, and the submit route refuses to send it. ProofPilot also reads the dispute's own history: if a type you already sent at an earlier stage is requested again, it shows a warning, because that is the pattern PayPal refused in the sandbox.

## Tools used (AI and PayPal)
| Tool | How ProofPilot uses it | Status in this build |
|---|---|---|
| **PayPal Agent Toolkit** `@paypal/agent-toolkit` 1.11.0 (Vercel AI SDK integration, `context.sandbox: true`) | The dispute agent's PayPal tools. Read tools run autonomously: `list_disputes`, `get_dispute`, `get_order`, `get_shipment_tracking`, `get_refund`, `list_transactions`. Write tools `accept_dispute_claim`, `create_shipment_tracking`, `create_refund` (plus ProofPilot's `propose_provide_evidence`, `propose_make_offer`) are **proposal-only**: enforced in code in `src/ai/agent.js` and `src/ai/proposals.js`, they are rebuilt from the dispute's own records and run only with the seller's single-use approval code. Every other toolkit tool is dropped. | Live with Gemini (run on 11 Oct 2026); mocked agent-loop tests. See "Agent" below. |
| **Google Gemini** `gemini-3.6-flash` by default (Gemini API; `GEMINI_API_KEY`, override with `GEMINI_MODEL`) via Vercel AI SDK 5 + `@ai-sdk/google` 2 | The model driving the agent: reads the case through the toolkit, recommends fight / offer / accept / wait and picks cited facts for the evidence draft. `gemini-3.6-flash` is a stable Flash model (`gemini-3.5-flash` is deprecated and routed to it). Live checks on 11 Oct 2026: 3.6-flash completed a function-call round trip, then hit the free tier's 20 requests per model per day; `gemini-3.5-flash-lite` answered but never called a tool; `gemini-2.5-flash` is closed to new users. | **Live runs done** on PP-R-PGV-10190981 (dry run). The run committed in `docs/agent-run-redacted.json` used `GEMINI_MODEL=gemini-3-flash-preview` because 3.6-flash's daily quota was used up; the model name Gemini reported back (`modelVersion`) is recorded there. The agent read the dispute and order and proposed `accept_dispute_claim`, which was **not approved or executed**. Screenshots 14 to 16. |
| **Groq** `openai/gpt-oss-20b` (OpenAI-compatible endpoint; `GROQ_API_KEY`, override with `GROQ_MODEL`) | Alternative plain advisor without the toolkit agent (`PROOFPILOT_LLM_PROVIDER=groq`). Groq retired its free Llama models on 16 Aug 2026, so the default is GPT-OSS 20B. | Code and mocked tests. Not run against a real key. |
| ProofPilot rules engine `proofpilot-rules-v1` (deterministic, not AI) | Fallback when no key is set or the model call fails, and a sanity check on the model's recommendation. Labelled "rules engine" in the UI. | Live |
| PayPal Orders v2, Payments v2, Shipment Tracking, Disputes v1, Webhooks, JS SDK | See the table above. | Live in sandbox |
| AG Grid Community 32 | Dispute queue and orders grids with a custom theme and cell renderers (status chips, live deadline countdown, evidence chips, readiness bars). No Enterprise features. | Live |

### Agent (PayPal Agent Toolkit + Gemini)
- **Read tools run on their own.** Before the model sees a result, and before it is written to the activity log, ProofPilot redacts secrets, emails, names, addresses, phone numbers and URLs.
- **Write tools only create proposals.** `guardTools()` rebuilds the tool set from an allowlist. For each write tool it keeps the toolkit's schema but replaces `execute` with a proposal recorder. The toolkit's real `execute` stays in server memory. This is enforced in code, not only in the prompt.
- **Proposals are bound server-side** (`src/ai/proposals.js`), once when the run ends and again on approval against a fresh PayPal read:
  - same dispute; a refund must use the dispute's own seller payment (capture), and tracking the dispute's own order;
  - amount parsed strictly (plain decimals only, so `1e-9` or `0x5` are refused), at least 0.01, at most the disputed amount, in the dispute's currency;
  - the action must match the run's **final** recommendation (accept or refund needs ACCEPT, an offer needs OFFER, evidence needs FIGHT); a WAIT answer leaves nothing executable. PayPal must offer the action, and a closed case blocks everything. Adding tracking during a dispute is never proposed, because late tracking is not proof of shipment;
  - one executable proposal per run.
- **The model's arguments never reach PayPal.** ProofPilot rebuilds canonical arguments from the dispute record and writes the accept-claim note, the refund `note_to_payer` and the offer note from templates. Only the *names* of the fields the model supplied are kept, for the log.
- **Approval is a server-issued, single-use code** (for example `APPROVE-UZZXP-JEA4G`), bound to the proposal id, the proposal's SHA-256 hash and the dispute. It is shown to the seller in the Agent activity panel (passcode-guarded route); the server stores only a digest. It expires after 30 minutes, is consumed on first use, and five wrong codes void the proposal. On approval ProofPilot re-reads the dispute from PayPal, binds the proposal again and requires the identical hash (`STALE_PROPOSAL` otherwise), then runs the held toolkit tool with the canonical arguments. Dry-run mode sends nothing. Star Fisheries' $999 cross-payment probe is a regression test (`test/proposals.test.js`).
- **The final answer goes through the same checks as the plain advisor:** fact ids, the hardened citation checker and the rules-engine fallback.
- **Agent activity panel.** The dispute page shows every tool call in plain words (with redacted results; for proposals, only the names of the fields the model supplied), the model name Gemini reported, and each proposal: what it would do, exactly what would be sent, why it is blocked if it is, and the approval code.
- **Why AI SDK 5.** The toolkit builds its tools for AI SDK v4. ProofPilot runs them on AI SDK v5 with `@ai-sdk/google` v2, because Gemini 3.x tool calling needs thought signatures passed back between steps. With the v4 Google provider, the second step failed live (403, or "missing a thought_signature").
- **The toolkit's ESM build fails on Node 20** (lodash named import), so ProofPilot loads its CommonJS build.

### How the AI is kept honest (structured claims)
1. ProofPilot renders a catalog of facts from fields of the records it fetched from PayPal, for example `capture:<id>:amount` → "The buyer paid USD 5.50." The model sees record digests (no buyer or seller emails or names) and this catalog.
2. The model returns an action, an evidence type and **fact ids** (`rationale_facts`, `narrative_facts`). It does not write the evidence text: ProofPilot does, from record data. Unknown fact ids are refused (`UNKNOWN_FACT`).
3. If the model returns free-text sentences instead, each one is checked in strict mode and passes only if it is exactly one of the catalog facts with the matching citation (`NOT_A_RECORDED_FACT` otherwise), after the citation, value, outcome and late-tracking checks above. Refused sentences are hidden behind a toggle that names the reasons in plain words; opening it shows the model's refused wording, struck out. It is never sent. In the 18 adversarial cases from the v0.2 review (`test/adversarial.test.js`), all 17 fabricated or misleading sentences are refused and the true control sentence is accepted. The v0.3 review probes (N1 to N10, the tool gate and the agent) are asserting tests in `test/adversarial-v03.test.js`.
   Before the outcome and value checks, every sentence (model or seller) is normalised: NFKC folding (full-width letters and digits), Cyrillic and Greek look-alikes mapped to Latin, and zero-width or bidi control characters refused outright (`HIDDEN_CHARACTERS`). Amounts are checked together with their currency: "EUR 5.50" or "₹5.50" does not pass on a USD 5.50 record.
4. The model's action must be one PayPal offers; its evidence type must be requested and not refused by PayPal; a FIGHT needs a complete pack; a recommendation with no reason that passes the checker falls back to the rules engine; an offer amount is only kept with OFFER, as a plain decimal of at least 0.01 and at most the disputed amount. The UI shows actions and evidence types in plain words, never the model's raw strings. The UI shows whether the model agrees with the rules engine.
5. At submit time the server re-checks every statement that is not one of ProofPilot's own pack statements and not marked as your own wording: it must be a catalog fact. This does not depend on the claim's id or on the browser saying it came from the model.
6. Limits: the checker proves that a fact is in a PayPal record, not that the fact helps your case or that the record is right. You still tick and approve each statement.
7. With no key, the UI says "AI not configured" and shows only the rules engine. No AI output is ever simulated.

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
- `PROOFPILOT_DRY_RUN=1` (read-only, nothing is sent), `PROOFPILOT_WRITE_PASSCODE=...` (reviewer passcode. Required for everything that writes to PayPal, spends AI quota, or returns PayPal or agent data: dispute list and detail, agent runs and approval codes, orders, webhook log, risk checks. Without a passcode those routes only answer requests from the same machine, so a public host must set one. `/healthz`, `/api/config` and `/api/catalog` stay open and carry no PayPal case data).
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
- AI: the Gemini agent has been run live in sandbox (read tools plus one proposal, not executed). The committed run log used `gemini-3-flash-preview` because the default `gemini-3.6-flash` had used its free daily quota; a full agent run on 3.6-flash is still to be recorded. Groq is tested with mocks only. Free-tier Gemini availability varies by model and over time; set `GEMINI_MODEL` if the default is unavailable.
- PayPal codes are shown in plain words (raw code on hover). A refund record that matches the dispute's `HOLD_PLACED` fund movement is PayPal's dispute hold, not a seller refund, and is never used as proof of refund.
- Requested evidence types ProofPilot cannot back with a PayPal record (for example a delivery signature) are shown as gaps and cannot be sent under that label. If PayPal refuses a type (`EVIDENCE_TYPE_IS_NOT_ALLOWED`), ProofPilot records it and stops recommending that type for the dispute.
- Sandbox only. The sandbox does not settle cases on its own; ProofPilot never calls `adjudicate` and never claims a case outcome.
- Seller Protection checks are a subset of PayPal's rules (address, signature threshold, capture state, eligibility PayPal reports, goods type).
- Local data (orders created here, approvals, webhook log) is a JSON file in `data/` (git-ignored).

## License
MIT. See `LICENSE`.
