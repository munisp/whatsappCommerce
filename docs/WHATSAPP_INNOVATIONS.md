# WhatsApp & Integration Innovations — Implementation Record

**Date:** 2026-08-08
**Range:** main `e9a4f6b8` → `6cd2cb0a` (PRs #56–#59)
**Tests:** 920 → 1,027 passed / 7 skipped / 0 failed (63 files). `tsc --noEmit` 0 errors; `npm run build` clean.

Ten innovations focused strictly on the WhatsApp channel and the Meta integration surface, plus closure of the remaining channel-level gaps.

## Messaging reliability (PR #56)

1. **Per-message delivery pipeline** — Meta status callbacks (`statuses[]`) now drive a state machine on every logged send: sent → delivered → read, with per-status timestamps; failures capture the full Meta error payload. Visible in the admin Message Log with ✓/✓✓/⚠/✖ glyphs.
2. **Failed-send auto-retry + dead-letter** — retriable errors (5xx/429/network) retry on a 1m/5m/15m/1h backoff (max 4 attempts) via `/api/scheduled/wa-send-retry`; permanent errors (4xx) and exhausted sends become `dead` and alert the tenant admin on WhatsApp. Every sender (text, template, interactive, media, location) persists a replayable payload. **Closes the fire-and-forget gap.**
3. **Read receipts** — inbound messages are marked read immediately after the idempotency claim, giving buyers instant "seen" feedback across every conversation branch.

## Commerce surface (PR #57)

4. **Native location collection** — the delivery-address step sends a WhatsApp location request; a pinned location flows through the identical checkout path (quote → order → payment link), persists `deliveryCoords` into order + shipment metadata, and doubles as the customer's saved default address. **Closes the ops-map coordinates gap.**
5. **Meta Product Catalog sync** — per-tenant catalog push (create/update on product mutations, delete on archive) with price/availability mapping from live stock; sync status + manual resync in Integration Settings. Products become browsable natively inside WhatsApp.
6. **Visual product search** — a buyer's product photo (when not a payment receipt) is vision-matched against the tenant catalog and answered with a product image card ("reply BUY …"); feature-flagged per tenant.

## Messaging operations (PR #58)

7. **24h session-window manager** — per-contact window state (Redis + replies-table fallback) drives automatic text↔template switching everywhere (broadcasts included); unpaid orders approaching window expiry trigger a buyer nudge + one-time admin flag.
8. **Template management** — Meta message-template API per tenant: list/status-sync (APPROVED/PENDING/REJECTED cached), create-and-submit; broadcast picker offers approved templates with free-form override; WABA id validated during onboarding.
9. **Click-to-WhatsApp links + QR campaigns** — per-tenant wa.me deep links and token-guarded QR PNGs (print-ready); campaign keywords attribute inbound customers (`campaign:<kw>` tag) and trigger mapped actions (menu/track/support/promo).
10. **Messaging quality monitor** — Meta quality rating + messaging-limit tier pulled daily; broadcasts are blocked at LOW quality and throttled at MEDIUM; dashboard widget with manual refresh.

**Bonus:** contact auto-provisioning (profile name from webhook contacts → customer upsert, name only when empty, metered).

## Frontend (PR #59)

- **WA Templates page** (`/wa-templates`): template library (sync, create with `{{n}}` preview, WABA setup hint) + Message Log tab (delivery-status glyphs, error/attempt tooltips, filters).
- **Links & QR tab** in Tenant Settings: canned links, campaign table with inline QR images, create/delete.
- **Quality widget** on Dashboard (admin): rating badge, tier, LOW-rating broadcast-block callout.
- **Integration Settings**: Meta Catalog card + Visual Search toggle.

## Validation

- Every PR gated on `tsc --noEmit` = 0 + full `vitest run` green before merge
- Final independent verifier gate on fresh checkout @ `6cd2cb0a`: see final report
- Cumulative: **1,027 passed / 7 skipped / 0 failed**, `npm run build` clean

**Operator-side remaining:** cron wiring for the new scheduled endpoints (`wa-send-retry`, `window-expiry-check`, `wa-quality-refresh`), `settings.whatsapp.wabaId` per tenant for template management, Meta Catalog permissions for catalog sync, client-bundle redeploy.
