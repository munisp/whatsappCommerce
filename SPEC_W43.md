# SPEC_W43 — Orders P1s (BINDING)

Source: /mnt/agents/output/w36/audit-orders.md P1 cluster + p0-verification.md touchpoints. Base: main @ 050aeb6.

## Scope (3 coders, non-overlapping)

### Coder A — w43/fulfillment (partial fulfillment + backorders) — J322–J326, migrations 0130–0131
- **Partial fulfillment**: merchants can fulfill a subset of order lines. New table `order_fulfillments` (id, orderId, tenantId, status pending/partial/complete/cancelled, trackingCarrier, trackingNumber, createdAt, updatedAt) + `order_fulfillment_lines` (fulfillmentId, orderLineId, qty). Order status derives: `partially_fulfilled` when some-but-not-all lines fulfilled (additive enum value, no renames). Guard: cannot fulfill more qty than ordered minus already-fulfilled (claim-first: SELECT ... FOR UPDATE on order lines inside txn). Fulfilling decrements committed stock reservation exactly once (idempotent fulfillment key = fulfillmentId+orderLineId).
- **Backorders**: when stock insufficient at confirm, order line may be marked `backordered` (additive orderLine status) instead of blocking checkout (tenant-config flag `tenants.allowBackorders`, default false). Backordered lines create `backorder_requests` (id, tenantId, orderLineId, qty, status open/partially_filled/filled/cancelled). On inventory restock (existing restock path), open backorders for that SKU are auto-filled oldest-first within the same txn, notifying customer via channelSender notifyCustomer (new category `backorder_filled`, registered in channelParity).
- WhatsApp/Telegram parity: customer sees partial-fulfillment + backorder notifications on BOTH channels.

### Coder B — w43/exchanges (exchanges + stock-adjustment audit) — J327–J331, migrations 0132–0133
- **Exchanges**: `exchange_requests` (id, tenantId, orderId, rmaRequestId nullable FK to rma_requests, fromOrderLineId, toProductId, toVariantId nullable, qty, priceDeltaCents integer, status requested/approved/rejected/in_transit/received/completed/cancelled). Approved exchange with positive priceDeltaCents → payment link (reuse existing payment intent path); negative → refundToWallet (services/customerWallet.ts creditWallet — W41 contract, DO NOT re-stub). Stock: on `received`, fromLine qty restocked (or written off if damaged flag), toLine stock reserved claim-first. State machine enforced; illegal transitions rejected.
- **Stock-adjustment audit**: `stock_adjustments` (id, tenantId, productId, variantId nullable, deltaQty, reason enum(restock/damage/theft/correction/count/backorder_fill/exchange_in/exchange_out/other), refType, refId, actorId nullable, note, createdAt). ALL stock mutations (restock, fulfill, cancel-release, exchange, backorder fill) must write an audit row in the same txn. tRPC query `inventory.adjustmentHistory` tenant-scoped.

### Coder C — w43/dispatch (POD photo + address change post-dispatch) — J332–J336, migrations 0134–0135
- **Proof-of-delivery photo**: `delivery_proofs` (id, tenantId, orderId, fulfillmentId nullable, type photo/signature/otp, mediaUrl, capturedByDriverId nullable, capturedAt, createdAt). Courier/driver posts photo via new endpoint POST /api/delivery/proof (multipart or base64 JSON, media stored to existing media storage path used by WA media — reuse, no new deps) OR customer sends photo in chat (inbound media on either channel with active `awaiting_pod` order state). Order transitions to `delivered` only when POD present (tenant flag `tenants.requirePod`, default false → current behavior). POD photo viewable in order timeline; customer notified on both channels.
- **Address change post-dispatch**: `address_change_requests` (id, tenantId, orderId, requestedBy customer/merchant, oldAddress jsonb, newAddress jsonb, status pending/approved/rejected/applied/expired, feeCents integer default 0, createdAt, decidedAt). Allowed only while order in out_for_delivery/in_transit and tenant flag `tenants.allowPostDispatchAddressChange` default true. Customer requests in chat ("change my address") on BOTH channels → merchant approval card (WA interactive buttons + TG inline keyboard via channelParity) → on approve, order shippingAddress updated + audit row + optional feeCents charged via wallet/payment link. Reject/expire paths notify customer.

## Cross-cutting invariants (ALL coders)
- Additive-only schema; hand-written migrations only (drizzle-kit broken); migration journal idx + prevId chained from 0129 tip; cumulative snapshots. Non-overlapping migration ranges as assigned above.
- Integer cents everywhere; money mutations claim-first (FOR UPDATE) in txn; idempotency keys on all externally-triggered writes.
- paymentConfirm.ts PINNED md5 2f77ea4816d1adc5cb35473bd35d1697 — adjacent seams only, never edit the pinned region.
- Channel parity: every customer-facing notification goes through channelSender/notifyCustomer with the category registered in channelParity.ts — must work on WhatsApp AND Telegram. Banner edits `// === W43 <topic> ===`.
- tenantId scoping on every query; assertTenantActive where order state mutates.
- Fail-closed money, fail-open telemetry. No mocks presented as real. No TEMP STUBs. No empty files. Lockfiles untouched.
- Journeys lazy-import server services; sim harness world.ts has SIM_DATABASE_URL seam + world.db Proxy (W42) — do not regress.
- simulation.test.ts count is MERGER-owned; coders just register their journeys in runner.ts in their assigned range (merger resolves anchor conflicts).
- Gates before push: tsc 0 (NODE_OPTIONS=--max-old-space-size=8192), your journeys N/N, pin md5, lockfiles, no empties. Commit+push INCREMENTALLY every ~30 min (/home wipes). Push branch to share remote /mnt/agents/output/w43-share, ls-remote verify, report to lead. Fast-fail after 2 attempts on any blocker.
