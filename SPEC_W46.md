# SPEC_W46 — Final backlog sweep: tenancy/KYC + UC greenfield + inventory depth + platform P2s (BINDING)

Source: /mnt/agents/output/w45/residual-backlog.md (verified evidence + fix sketches — READ IT). Base: main @ 227d740.

8 coders, non-overlapping. Journeys J387+; each coder owns 5. simulation.test.ts count is MERGER-owned. Migration ranges assigned per coder — use ONLY if you actually need one; journal chains from 0151 tip; cumulative snapshots full column union.

## Coder A — w46/kyc — J387–J391 — mig 0160
TEN-6 (KYC expiry: set expiresAt at approval per risk tier, cron expire + notify + re-verification flow), TEN-7 (appeal path: `appealed` status + different-reviewer enforcement + audit both decisions), TEN-9 (capability model: scoped roles — at minimum finance/catalog scoping enforced in moneyProcedure/catalog procedures; document if full Permify per-tenant is deferred), TEN-10 (removeMember → clear users.tenantId + revokeAllUserSessions + bust membership cache), TEN-12 (block merchant-owner erasure while sole owner of active tenant; require transfer/offboarding), TEN-13 (DSAR export: gate merchant wallet/ledger export to owner; scope to subject's own transactions).

## Coder B — w46/privacy-consent — J392–J396 — mig 0161
TEN-15 (age-restricted product flag + checkout age attestation incl. chat/agent order paths), TEN-16 (proof-of-consent versioning: store policy/template version + wamid evidence; log + rate-limit re-grants after withdrawal), TEN-17 (buyer-side requireApprovedKyb on inter-tenant PO submit; propagate tenant suspension into poFlow; cross-tenant dispute routing — minimal honest version), TEN-20 (new-device login: independent email OTP or TOTP second factor — not a mirror of the same OTP; anomaly notify owner; admin recovery with step-up + audit), TEN-22 (KYB review queue with SLA timestamps + escalation cron + breach alerts), TEN-19-residual (bind invite redemption to verified phone/SSO identity), TEN-18 (versioned/effective-dated supplier tax profiles + audit event; statements resolve as-of date).

## Coder C — w46/uc-money — J397–J401 — mig 0152–0153
UC-11 (auctions: auctions + auction_bids tables; guarded high-bid UPDATE claim-first; close sweep invoices winner via existing payment intent; anti-snipe extension optional), UC-15 (tipCents on orders + checkout prompt both channels; pass through escrow release), UC-16 (open-amount/donation product type + buyer-entered amount payment link; min-amount guard), UC-26 (order amendment pre-confirmation: amend intent in chat → recompute via escrowAmounts → delta payment link or refund; audit trail).

## Coder D — w46/uc-docs — J402–J406 — mig 0154
UC-12 (per-customer statement of account from orders+payments; WA/TG document delivery — reuse existing doc/pdf machinery), UC-19 (proforma invoice/quotation: render document reusing AR invoice machinery, send via chat document, convert-to-order action), UC-20 (agents/resellers: agents table + order attribution + commission statements feeding existing payout rails), UC-18 (resolve wholesale price tier from the buyer's ACTUAL type/group at quote time — replace hardcoded 'wholesale' in b2bCatalog; per-group discounts).

## Coder E — w46/uc-ux — J407–J411 — mig 0155–0156
UC-17 (venue_tables + QR deep link seeds cart metadata; kitchen board view), UC-21 (delivery_slots per tenant with capacity; checkout slot picker both channels; slot → courier booking seam), UC-23 (wishlists: "save this"/"my list" chat intents both channels; price-drop alert sweep), UC-24 (gift orders: orders.isGift/giftMessage/recipientPhone — additive columns; hide prices on receipt; gift-wrap fee line), UC-27 (tenant minOrderCents per fulfillment mode; checkout block + prompt both channels).

## Coder F — w46/inventory-depth — J412–J416 — mig 0157–0158
ORD-15 (products.barcode + scan endpoint; variant-level stock rows + reservation by variantId claim-first), ORD-16 (warehouse_stock table + allocation strategy at reserve time — single default warehouse migration of existing stock), ORD-20 (delivery_claims table: shipmentId, photos, type, resolution state machine), ORD-21 (inventory_batches productId+expiryDate+qty; FEFO reserve; expiry sweep alert). All stock mutations must write W43 stock_adjustments audit rows.

## Coder G — w46/orders-p2 — J417–J421 — mig 0159
ORD-19 (promisedDate = approvedAt + leadTimeDays on PO; breach sweep alerts), ORD-22 (product recall tool: order_items by productId+date range → targeted broadcast with opt-out logging), ORD-23 (order merging: same customer+address pre-ship; splitting via W43 fulfillment lines — document), ORD-25 (buyer free-text note captured onto orders.notes at chat checkout), ORD-24 if not fully covered by E's UC-24 (coordinate: E owns orders.isGift columns; you own nothing there unless E defers — check E's scope first, skip if covered).

## Coder H — w46/platform-p2 — J422–J426 — no migrations expected
PLT-15 (internal service auth: HMAC-signed requests ts+body with key versioning — additive alongside bearer, fail-closed in prod for sensitive routes), PLT-18 (Kafka client reconnect: backoff/jitter, reset latch, surface in /health/ready), PLT-21 (scheduled-payment tick uses DB clock: execute_at <= now() in SQL inside guarded UPDATE), PLT-22 (pre-migration logical dump step in migrate-prod to object storage + doc), PLT-24 (disable auto-topic-creation both producers + enable.idempotence; pre-provision topics list), PLT-25 (central redact() logger helper + apply to waLocation + worst PII console.* sites + lint note), MSG-23 (low-confidence locale detection → language picker instead of silent sticky English).

## Cross-cutting invariants (ALL coders)
- Additive-only schema; hand-written migrations; journal idx+prevId from 0151 tip; cumulative snapshots FULL column union (verify programmatically).
- Integer cents; claim-first FOR UPDATE on money/stock; idempotency keys; paymentConfirm.ts PINNED md5 2f77ea4816d1adc5cb35473bd35d1697 (adjacent seams only).
- Channel parity BOTH WhatsApp+Telegram via channelSender/notifyCustomer; register new channelParity categories (J246 subset semantics — never hard-code counts). Banner `// === W46 <topic> ===`.
- tenantId scoping + assertTenantActive on state mutations; W42 cronAuth scope+jti + scheduler.mjs allowlist for new cron routes (J178 contract); W42 keyring v2:<kid> for anything encrypted.
- Reuse W38–W45 contracts (cancelOrder, creditWallet, recordStockAdjustment, paymentOutbox, currencyExponent, initiateWithFallback) — never re-stub. No TEMP STUBs. No empty files. Lockfiles untouched. No new deps without flagging.
- File-ownership discipline: stay in your files; for shared files (schema.ts tail, channelParity.ts, runner.ts, nlp.ts, _core/index.ts) add banner-delimited additive blocks only.
- Gates before push: tsc 0 (NODE_OPTIONS=--max-old-space-size=8192), your 5 journeys N/N, pin md5, lockfiles, no empties. PUSH INCREMENTALLY every ~30 min AND after every commit verify tree completeness (git ls-tree -r HEAD | wc -l ≈ 2530+). /home wipes are LIVE this session — consider working in a /mnt clone despite slower npm, or re-clone aggressively. FUSE git errors → GIT_INDEX_FILE plumbing (recreate index file per command chain). Push branch to /mnt/agents/output/w46-share + ls-remote verify + cat-file -t <sha> in share. Fast-fail after 2 attempts — report, don't grind. Do NOT run the full suite (merger does).
