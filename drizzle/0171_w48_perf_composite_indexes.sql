-- === W48 api-db (PERF-API-4, PERF-API-11, PERF-API-17): additive composite
-- indexes for the hot read paths. No CONCURRENTLY (drizzle migrate runs in a
-- transaction); all IF NOT EXISTS. ===

-- PERF-API-4: merchant order board — WHERE "tenantId" [AND "status"] ORDER BY "createdAt" DESC
CREATE INDEX IF NOT EXISTS "orders_tenant_status_created_idx" ON "orders" ("tenantId", "status", "createdAt" DESC);
--> statement-breakpoint
-- PERF-API-4: conversations board — same shape (ordered by updatedAt)
CREATE INDEX IF NOT EXISTS "conversations_tenant_status_updated_idx" ON "conversations" ("tenantId", "status", "updatedAt" DESC);
--> statement-breakpoint
-- PERF-API-11/17: channel_messages tenant scans + phone pushdown
CREATE INDEX IF NOT EXISTS "channel_messages_tenant_created_idx" ON "channel_messages" ("tenantId", "createdAt" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "channel_messages_addr_idx" ON "channel_messages" ("tenantId", "fromAddress", "createdAt" DESC);
--> statement-breakpoint
-- PERF-API-17: wa_webhook_events retry sweep — status='failed' AND nextRetryAt <= now()
CREATE INDEX IF NOT EXISTS "wa_wh_retry_due_idx" ON "wa_webhook_events" ("nextRetryAt") WHERE "status" = 'failed';
--> statement-breakpoint
-- PERF-API-17: wallet_transactions tenant board ordered by created_at
CREATE INDEX IF NOT EXISTS "wallet_tx_tenant_created_idx" ON "wallet_transactions" ("tenant_id", "created_at" DESC);
