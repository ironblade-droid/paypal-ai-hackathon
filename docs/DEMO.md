# ProofPilot demo and seed notes

Everything here is PayPal **sandbox** test data.

## Demo modes
| Mode | Env | Use |
|---|---|---|
| Full local | sandbox keys + `PROOFPILOT_ENABLE_SANDBOX_TOOLS=1` | Recording the video: every write goes to the sandbox. |
| Hosted for judges | sandbox keys + `PROOFPILOT_WRITE_PASSCODE=<passcode>` | Anyone can browse; shipping, submitting, sandbox tools and AI calls need the passcode (given to judges in Devpost testing instructions). |
| Read-only | `PROOFPILOT_DRY_RUN=1` | Nothing is sent to PayPal; submit shows the exact payload instead. |

## Seeded data (what already exists in the team sandbox)
- Dispute `PP-R-PGV-10190981`: item not received, USD 5.50, created through the API on 11 Oct 2026 by the spike (buyer consent + buyer-side transaction id `77W70831A6213602F`).
- Order `9H859131RH898413F`, capture `1AU666173Y707472F` (Seller Protection eligible).
- Trackers on that capture: `9400100000000000000001` (registered by the spike's evidence submission) and `9400111899562537866358` (added through ProofPilot's Ship flow on 11 Oct 2026). Both are sandbox test numbers and both were added after the dispute opened, so ProofPilot labels them "added after dispute opened" and does not use them as proof of shipment.
- Refund-type record `44V27761ED882372G` (USD 4.82, PENDING): this is PayPal's dispute hold (it matches the dispute's `HOLD_PLACED` fund movement to the second), not a refund the seller issued.

## Seeding a fresh dispute (for a clean video run)
1. Shop: buy the USD 5.50 sticker pack with the sandbox buyer (browser approval needed).
2. Orders & shipping: run the pre-ship check and add tracking **before** the buyer opens the dispute. Tracking added after the dispute opened is labelled "added after dispute opened" and is not used as proof of shipment.
3. Open the dispute as the buyer: buyer Resolution Center, or `POST /api/sandbox/disputes` with the buyer email and the **buyer-side** transaction id from the buyer's Activity page (needs the buyer's one-time *Log in with PayPal* consent for the app).
4. Open the dispute in ProofPilot: it shows **Waiting for PayPal** and polls until PayPal offers actions (about 3 to 5 minutes; start this before recording).
5. In the inquiry stage PayPal requested proof of fulfillment and accepted it in the spike; submit from the dispute page.

## Sandbox notes from live runs (11 Oct 2026, IST)
- 15:57: `require-evidence` (sandbox only) was called on `PP-R-PGV-10190981` from ProofPilot's sandbox tool. About 20 s later PayPal moved the case from **Under PayPal review** to **Your response needed** (claim stage), requesting proof of fulfillment, proof of refund and a delivery signature, due 15 Oct 2026 09:29 IST.
- 15:58 to 16:03: **five** seller submissions of proof of fulfillment through the approve-and-submit flow were refused by PayPal with `EVIDENCE_TYPE_IS_NOT_ALLOWED`. PayPal debug ids: ca48d2e001e25 and f951841e0bc57 (the first two; their exact times were not stored because refusal logging was added after them), then f563062b0c644 (16:01:35, no PDF), f942795438d28 (16:02:04, PDF) and f555810c4f27c (16:03:14, PDF, only the newly registered tracker). The dispute state did not change.
- All five are in the committed `seed/paypal-refusals.json`, so a fresh install or the hosted demo also knows that PayPal refused proof of fulfillment on this case at the claim stage: the rules engine and the AI advisor do not recommend it and the submit route refuses to send it again (`TYPE_REFUSED_BY_PAYPAL`).
- Both trackers on this capture were registered after the dispute opened (09:30:48 UTC by the spike's evidence submission and 10:31:48 UTC by ProofPilot's Ship flow; the case opened 09:22:26 UTC). ProofPilot v0.3 labels them "added after dispute opened" and does not use them as proof of shipment, so this dispute has no complete proof-of-fulfillment pack anyway.
- `adjudicate` is never called.

## Live agent run (11 Oct 2026, 16:59 to 17:01 IST, dry-run server, sandbox)
- Setup: Gemini `gemini-3.5-flash` on the PayPal Agent Toolkit 1.11.0, running against PP-R-PGV-10190981 (claim stage, response needed).
- What the agent did (each run): it called `get_dispute` (read, ran, result redacted), recommended ACCEPT, which agrees with the rules engine, and called `accept_dispute_claim`. That call was recorded as a proposal with status PENDING_SELLER_APPROVAL. **It was not approved or executed:** PayPal still shows the dispute as WAITING_FOR_SELLER_RESPONSE with update_time 10:27:52Z.
- Checked draft:
  - The reasons the model gave were facts rendered from the dispute and tracker records, including both "added after dispute opened" tracker facts.
  - In one earlier run the model also suggested 2 narrative facts (when the case opened, and the disputed amount); both passed the checker.
  - No free text was accepted.
- The first runs exposed a redaction gap: the toolkit returns results as JSON strings, so key-based redaction missed the sandbox buyer's name and payer id. This is now fixed (string results are parsed, redacted and re-serialised) and covered by a test. The screenshots were retaken after the fix.

- Those early run logs (unredacted, in the box's /tmp) were deleted in v0.4.0.

## v0.4.0 agent runs (11 Oct 2026, 17:15 to 17:17 IST, dry-run server, sandbox)
- Model availability on the project's free-tier key: the default `gemini-3.6-flash` completed a live function-call round trip, then reached the free tier's daily limit (20 requests per model per day). `gemini-3.5-flash-lite` answered (reported model `gemini-3.5-flash-lite`) but made no tool calls in two agent runs. The recorded run therefore used `GEMINI_MODEL=gemini-3-flash-preview`.
- `docs/agent-run-redacted.json` is the exported log of that run: requested model, the model Gemini reported back (`modelVersion`: `gemini-3-flash-preview`), each tool call with redacted results, and the bound proposal.
- What the agent did: it read the dispute (`get_dispute`) and the order (`get_order`) and recommended ACCEPT, which agrees with the rules engine. It then called `accept_dispute_claim` with its own note. ProofPilot dropped the model's note, bound the proposal to this dispute, wrote the template note `Seller-approved-accept-via-ProofPilot-PP-R-PGV-10190981`, and issued a single-use approval code. **It was not approved or executed.** Nothing was sent to PayPal, and the response deadline (15 Oct 2026, 09:29 IST) is still the seller's decision.

## v0.5.0 changes visible in the demo
- Evidence pack: the buyer-typed ship-to address is shown as a labelled quotation, **unticked**, and only sent if the seller ticks it.
- Agent panel: the approval code is no longer on the page. It is printed in the server console (the terminal running `npm start`), and the page has an input for it. Only one agent write per dispute: later proposals show "blocked" with the reason.
- AI card: each answer is badged **LIVE MODEL** or **RULES ENGINE FALLBACK**. When the model is rate-limited or not configured, a button shows the **CACHED DEMO RUN** (`docs/demo/cached-agent-run.json`, the 17:16 IST run above), labelled as recorded earlier, not live and not approvable.
- `docs/agent-run-redacted.json`: the sandbox `merchant_id` is now `[redacted]`.
- Screenshots 14 to 16 show v0.4.0 (the approval code was then visible in the panel). They have not been retaken for v0.5.0.

## Screenshots (`docs/screenshots/`)
01 queue under review · 02 dispute under review · 03 sandbox require-evidence clicked · 04 queue, response needed · 05 dispute, response needed · 06 evidence pack · 06b checker refuses an uncited claim · 07 approve before submit · 08 submit refused by PayPal (EVIDENCE_TYPE_IS_NOT_ALLOWED) · 09 dispute after refusal, still response needed · 10 queue after refusal · 11 orders & shipping · 12 demo shop · 13 fresh install (dry run, empty local store): the seeded PayPal refusals and the "added after dispute opened" tracker labels are shown, and proof of fulfillment is not offered for submission · 14 AI advisor with the live Gemini agent's checked draft (v0.4.0, plain words) · 15 Agent activity panel (v0.4.0: reads ran, accept proposal bound to the case with a template note and a single-use approval code, not executed) · 16 full dispute page with the agent. Screenshots 01 to 13 are from v0.3 and still show some raw PayPal codes that v0.4.0 replaces with plain words.
