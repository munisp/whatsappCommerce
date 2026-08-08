# Platform Innovations — Implementation Record

**Date:** 2026-08-08
**Range:** main `7c025b66` → `e9a4f6b8` (PRs #51–#55)
**Tests:** 729 → 920 passed / 7 skipped / 0 failed (54+ test files). `tsc --noEmit` 0 errors; `npm run build` clean.

Twenty innovations across four tracks, plus closure of every remaining residual from prior waves.

## Conversational experience (PRs #52, #53)

1. **Interactive menus** — `sendWhatsAppInteractive` (buttons ≤3 / lists ≤10) with automatic text fallback; the menu engine renders native WhatsApp interactive messages instead of plain numbered lists whenever the option count allows.
2. **Media sender** — `sendWhatsAppMedia` (image/document); product queries return image cards; closes the media-send gap.
3. **Order action cards** — every order confirmation carries [Track Order][Pay Now][Cancel Order] buttons; cancel enforces ownership + pending-only + stock release through the claim-first reservation path.
4. **PDF menu auto-push** — tenant's `settings.menuDocUrl` document is sent on menu/catalog requests (parity-plus on the competitor's PDF menu step).
5. **Smart reorder** — "repeat my last order" rebuilds the cart from the last paid order at live catalog prices, noting price changes.
6. **Abandoned-cart recovery** — carts idle >30 min trigger one consent-gated recovery message per 24 h; replying resumes checkout.
7. **Voice-note ordering** — inbound audio is transcribed (Whisper via `OPENAI_API_KEY`, fail-soft localized fallback) and fed into the same NLP pipeline as text.
8. **Multilingual platform** — en/fr/ha/yo/ig locale packs, heuristic detection, sticky per-customer locale; menus, consent, recovery, and system replies localized.
9. **Tenant FAQ knowledge base** — `settings.faq` consulted before NLP/handoff; CRUD in Tenant Settings.
10. **Chat dispute self-service** — buyers raise disputes/complaints in-thread; shared validation with the escrow dispute path; admin notified.

## Commerce engine (PR #54)

11. **Promo codes** — percent/fixed, min-total, expiry, max-uses with claim-first atomic usage; accepted in chat ("use code X") and `orderCrud.create`; integer minor-unit math, never-negative totals.
12. **Back-in-stock waitlist** — shortage replies offer NOTIFY ME; restock (admin update *or* Medusa/Odoo inbound sync) fan-outs notifications; STOP unsubscribes.
13. **Low-stock admin alerts** — threshold from `inventoryConfig`, deduped 6 h, on reserve/commit paths (fire-and-forget, rollback-safe).
14. **Scheduled + segmented broadcasts** — `scheduleAt` (cron dispatch, claim-first) and segments (tags, min orders, min spend, recency); dry-run returns segment-matched counts; consent gating unchanged.
15. **Digital receipts** — on payment confirmation: branded, itemized receipt (discount, fee, total, payment ref, delivery PIN, tracking link) with figures taken from the confirmed order row only.

## Platform operations (PRs #51, #55)

16. **Webhook idempotency ledger** — insert-first claim on every Meta event id; retries are acked but never reprocessed; 7-day sweep; fail-closed in production.
17. **Recon auto-match** — HMAC-verified settlement feed matches flagged receipts (±₦100, ≤72 h) and confirms them *through* `paymentConfirm` (never bypassing the money path); unmatched stay in manual review.
18. **Usage metering + plan quotas** — per-tenant monthly counters (messages in/out, orders), plan limits in settings, 80 %/100 % admin warnings, graceful hard gate; admin widget on the dashboard.
19. **Env boot gate + deep readiness** — production startup throws with an explicit missing-var list; `/health/ready` live-checks DB/Redis/Keycloak/TigerBeetle with latencies (503 on failure).
20. **ETA engine + live logistics map** — zone-based ETAs with status offsets injected into shipment pushes and the public tracking payload; MapLibre ops map with status-colored markers, popups (ETA, masked PIN), 30 s polling, honest empty states.

## Bonus deliveries

21. **System-health dashboard** (`/system-health`) and **audit log viewer** (`/audit-logs`, filters + CSV export).
22. **`customers.create`** tenant-scoped upsert (closes the gap noted by the integrations wave).
23. **Menu renderer unification** — runtime and admin preview now share `shared/waMenu.ts` as the single source of truth; EN locale keys aligned.

## Residuals closed this wave

- Receipt-verification heuristic → now backed by recon auto-match (#17)
- Media sends → first-class `sendWhatsAppMedia` (#2)
- Renderer duplication → unified (#23)
- Missing TS customer-create → delivered (#22)
- Operator env checklist → codified as fail-fast boot gate (#19)

**Still operator-side (cannot be done in code):** set production secrets, wire cron schedules for `/api/scheduled/*` and `/api/cron/*` endpoints, provide `OPENAI_API_KEY` for voice notes, add lat/lng to shipments/zones for full map coverage, redeploy the client bundle.

## Validation

- Every PR gated on `tsc --noEmit` = 0 and full `vitest run` green before merge
- Final independent verifier gate on fresh checkout @ `e9a4f6b8`: see final report
- Cumulative: **920 passed / 7 skipped / 0 failed**, `npm run build` clean (vite + server bundle)
