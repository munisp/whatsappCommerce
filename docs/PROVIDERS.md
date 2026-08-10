# Universal Provider Framework (Wave 11)

**Status:** shipped — PRs #82/#83/#85, main @ `3b460cce`, verifier gate PASS 15/15
(1,657 tests / 0 failed, paymentConfirm money path byte-identical, 46/46 simulation regression)

Payments are no longer hardwired to one gateway. A provider registry + adapter pack +
per-tenant fallback chain routes **every** payment surface — order checkout, credit
repayments, PO pay-now — through pluggable providers, and a **zero-code custom gateway
factory** lets tenants add providers we've never heard of.

---

## 1. Architecture

```
Order checkout / credit repayment / PO pay-now / dunning
        │
        ▼
initiateWithFallback ──► getProviderForTenant(tenantId)
        │                     enabled providers, priority DESC
        │   provider A fails → captureException(warn) → provider B serves
        │   (servedProvider recorded on the intent)
        ▼
PaymentProvider adapter (initiate → authorizationUrl | instructions)
        │
        ▼  (customer pays)
POST /api/webhooks/payments/:provider
        │  adapter.verifyWebhook(headers, rawBody, creds) — fail-closed, timing-safe
        ▼  normalized {reference, amountCents, metadata}
confirmProviderPayment — the SAME claim-first money path as always
        (paymentConfirm.ts untouched; metadata conventions frozen:
         order / {kind:'credit_repayment',accountId} / {type:'po_payment',poId,poNumber})
```

Legacy safety: tenants with no configured provider rows degrade to the pre-registry
env-key behavior (`PAYSTACK_*` / `FLW_*` env) — nothing breaks on upgrade.

## 2. Built-in adapters

| Provider | Initiate | Webhook verification | Notes |
|---|---|---|---|
| **paystack** | transaction init → authorization_url | `x-paystack-signature` HMAC-SHA512 | Refactored from legacy code, zero behavior drift |
| **flutterwave** | v3 payments → data.link | `verif-hash` constant-time | NGN + multi-currency |
| **stripe** | raw REST checkout sessions (no SDK) | `Stripe-Signature` v1 HMAC-SHA256, 5-min tolerance | `client_reference_id` + metadata passthrough |
| **monnify** | init-transaction → checkoutUrl | HMAC-SHA512 on `monnify-signature` | Bearer-token cached per creds |
| **manual** | bank-transfer instructions | n/a (receipt-upload flow) | Formalizes the existing offline path |
| **custom** | declarative (see §3) | configurable HMAC | Zero-code gateway addition |

All adapters: fail-closed signatures (`timingSafeEqual`), 15s timeouts, secrets never
logged, credentials encrypted at rest (wave-10 AES-256-GCM).

## 3. Adding a provider WITHOUT code — `customHttp`

Tenants (or platform ops) define a gateway as JSON config — zod-validated, no eval,
prototype-pollution-safe dot-path mapping:

```json
{
  "id": "afripay", "displayName": "AfriPay",
  "baseUrl": "https://api.afripay.example",
  "authStyle": "bearer",
  "initiate": {
    "path": "/v1/charges", "method": "POST",
    "bodyTemplate": "{\"amount\":{{amountCents}},\"ref\":\"{{reference}}\",\"currency\":\"{{currency}}\",\"callback\":\"{{callbackUrl}}\",\"meta\":{{metadataJson}}}",
    "responseMapping": { "authorizationUrl": "data.checkout_url", "reference": "data.ref" }
  },
  "status": { "path": "/v1/charges/{{reference}}", "mapping": { "status": "data.state", "amountCents": "data.amount_minor" } },
  "webhook": { "signatureHeader": "x-afripay-sig", "algo": "hmac-sha256", "secret": "…", "signatureEncoding": "hex", "referencePath": "data.ref", "amountPath": "data.amount_minor" }
}
```

Template vars: `amountCents`, `reference`, `currency`, `callbackUrl`, `customerPhone`,
`customerEmail`, `metadataJson`. HMAC: sha256/sha512, hex/base64. The "AfriPay"
round-trip is proven in `customHttp.test.ts` and simulation journey J49.

## 4. Tenant configuration

**Provider Settings** (`/provider-settings`): catalog cards per adapter, masked
credential forms (encrypt-on-write; masked sentinel merges preserve stored secrets),
priority ordering (**higher = tried first**), enable toggles, test-connection probes,
fallback-chain preview, and the custom-gateway JSON editor.

Router (`paymentGateway` router, additive): `listProviderAdapters`,
`getTenantProviders`, `configureProvider`, `testProvider`, `setProviderPriority`,
`toggleProvider` — all tenant-gated.

## 5. Webhook operations

- Unified route: `POST /api/webhooks/payments/:provider` — per-adapter verification,
  401 + observability capture on bad signatures, 404 unknown provider, exactly-once
  confirm via the existing dedupe/claim-first path
- Legacy `/api/webhooks/paystack` stays mounted during transition
- Provider dashboards (Paystack/Flutterwave/Stripe/Monnify) should register the
  unified URL per tenant environment — see docs/PRODUCTION_CHECKLIST.md Phase 0/2

## 6. Verification

- Verifier gate @ `3b460cce`: **PASS 15/15** — money-path 0-byte diff, per-adapter
  fail-closed citations, fallback chain proof, custom-factory injection safety,
  encryption continuity, boot wiring, legacy compatibility, no new deps
- Simulation journeys **J47–J52**: multi-provider tenants side-by-side, manual
  transfer, custom-gateway round-trip + tamper rejection, fallback under failure +
  all-fail graceful, non-Paystack credit repayment (replay-safe), cross-adapter
  webhook isolation

## 7. Adding a provider WITH code (adapter authors)

Implement `PaymentProvider` (`server/services/payments/providers/types.ts`):
`initiate` / `verifyWebhook` / `fetchStatus` / `testConnection`, register in
`registerAll.ts`. Hard requirements (verifier-enforced patterns): fail-closed
verification with `timingSafeEqual`, smallest-unit amounts, secrets redacted,
15s timeouts, mocked-HTTP tests incl. bad/missing/tampered signatures.

## 8. Roadmap hooks
- Refund/void operations across adapters (interface extension)
- Per-provider settlement reconciliation reports (reconMatch service exists)
- OPay/PalmPay native adapters (customHttp covers them today)
- Provider health dashboard (success rates from servedProvider + confirm outcomes)
