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
- Trackers on that capture: `9400100000000000000001` (registered by the spike's evidence submission) and `9400111899562537866358` (added through ProofPilot's Ship flow on 11 Oct 2026). Both are sandbox test numbers.
- Refund-type record `44V27761ED882372G` (USD 4.82, PENDING): this is PayPal's dispute hold (it matches the dispute's `HOLD_PLACED` fund movement to the second), not a refund the seller issued.

## Seeding a fresh dispute (for a clean video run)
1. Shop: buy the USD 5.50 sticker pack with the sandbox buyer (browser approval needed).
2. Orders & shipping: run the pre-ship check, add tracking.
3. Open the dispute as the buyer: buyer Resolution Center, or `POST /api/sandbox/disputes` with the buyer email and the **buyer-side** transaction id from the buyer's Activity page (needs the buyer's one-time *Log in with PayPal* consent for the app).
4. Open the dispute in ProofPilot: it shows **Waiting for PayPal** and polls until PayPal offers actions (about 3 to 5 minutes; start this before recording).
5. In the inquiry stage PayPal requested proof of fulfillment and accepted it in the spike; submit from the dispute page.

## Sandbox notes from live runs (11 Oct 2026, IST)
- 15:57: `require-evidence` (sandbox only) was called on `PP-R-PGV-10190981` from ProofPilot's sandbox tool. About 20 s later PayPal moved the case from **Under PayPal review** to **Your response needed** (claim stage), requesting proof of fulfillment, proof of refund and a delivery signature, due 15 Oct 2026 09:29 IST.
- 15:58 to 16:03: four seller submissions of proof of fulfillment through the approve-and-submit flow were refused by PayPal with `EVIDENCE_TYPE_IS_NOT_ALLOWED` (PayPal debug ids ca48d2e001e25, f951841e0bc57, f563062b0c644, f942795438d28, f555810c4f27c), with and without the PDF, and with only a freshly registered tracking number. The dispute state did not change. ProofPilot now records the refusal and stops recommending that type for the case.
- `adjudicate` is never called.

## Screenshots (`docs/screenshots/`)
01 queue under review · 02 dispute under review · 03 sandbox require-evidence clicked · 04 queue, response needed · 05 dispute, response needed · 06 evidence pack · 06b checker refuses an uncited claim · 07 approve before submit · 08 submit refused by PayPal (EVIDENCE_TYPE_IS_NOT_ALLOWED) · 09 dispute after refusal, still response needed · 10 queue after refusal · 11 orders & shipping · 12 demo shop.
