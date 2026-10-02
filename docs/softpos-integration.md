# === W59 banking-pos === SoftPOS (Android tap-to-pay) integration contract

SoftPOS turns a merchant's Android phone into a contactless card terminal via
NFC. The platform never touches card data.

## Responsibilities

| Party | Responsibility |
| --- | --- |
| Platform (this repo) | Creates the payment session (amount, unique reference, expiry); exposes the session to the device; verifies the provider webhook; settles the merchant wallet claim-first; sends the chat receipt. |
| SoftPOS SDK (on device) | All NFC / kernel / PIN handling. Card PAN, track data and PIN NEVER transit or persist on the platform. |
| Provider (paystack / flutterwave / softpos aggregator) | Authorizes the card read and emits the charge webhook. |

## Flow

1. **Session creation** — merchant (portal `/pos-terminals`, chat
   `PAY BY POS <amount>`, or USSD) calls `posPayments.createSession`
   (`channel: "softpos"`). The platform stores a `pos_payment_sessions` row
   (`status='awaiting'`, unique `reference = POS-<code6>-<rand8>`,
   `expiresAt` = now + 15 min) and returns `{ reference, ussdCode, qrPayload }`.
2. **Device handoff** — the Android app receives `reference`, `amountCents`,
   and the `qrPayload` URI
   (`expresspay://pos/pay?ref=…&amt=<major>&cur=NGN&t=<tenantId>`). The
   SoftPOS SDK performs the NFC tap + PIN entirely on-device.
3. **Authorization** — the SDK submits the cryptogram to the provider; the
   provider (not the device) is the source of truth.
4. **Webhook confirmation** — the provider calls
   `POST /api/webhooks/pos/:provider` (`softpos` events are HMAC-SHA256 over
   the raw body with `POS_SOFTPOS_WEBHOOK_SECRET` in `x-softpos-signature`).
   Signature failures are rejected 401 (fail-closed). The platform flips the
   session claim-first (`awaiting → charged`, exactly one winner) and credits
   the merchant wallet in the same transaction.
5. **Receipt** — post-commit, the receipts seam (`sendOrderReceipt` for
   order-bound sessions, else a WA text to the merchant admin phone) delivers
   the receipt. Receipt delivery is fail-open and never affects settlement.
6. **Expiry** — `/api/scheduled/pos-expiry` flips stale `awaiting` sessions
   to `expired`, releasing the claim; a late webhook against an expired
   session is a duplicate no-op (no late settlement).

## Security invariants

- No PAN/CVV/track data is accepted, logged or stored by the platform — the
  session carries only `amountCents`, `reference`, and status.
- Webhook verification is fail-closed per provider; money movement is
  claim-first and idempotent on the session reference.
- Replays (webhook retries) are duplicate no-ops; expiry and charge race
  safely on the single conditional UPDATE.
