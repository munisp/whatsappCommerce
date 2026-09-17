-- === W43 dispatch (Coder C): post-dispatch address change ===
-- ADDITIVE ONLY (hand-written; chained after 0134).
--
-- address_change_requests: buyer (chat, either channel) or merchant asks to
-- change the delivery address while the order is out_for_delivery /
-- in_transit. Merchant approves/rejects via the channelParity approval card
-- (WA interactive buttons / TG inline keyboard). feeCents (integer kobo,
-- default 0) is charged claim-first from the customer wallet on approve.
-- tenants.allowPostDispatchAddressChange (default TRUE) is the tenant gate.
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "allowPostDispatchAddressChange" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "address_change_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"order_id" varchar(36) NOT NULL,
	"requested_by" varchar(16) DEFAULT 'customer' NOT NULL,
	"requester_ref" varchar(64),
	"old_address" jsonb,
	"new_address" jsonb NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"fee_cents" integer DEFAULT 0 NOT NULL,
	"fee_status" varchar(16),
	"decided_by" varchar(64),
	"decision_note" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"decided_at" timestamp,
	"expires_at" timestamp
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "address_change_tenant_order_idx" ON "address_change_requests" USING btree ("tenant_id","order_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "address_change_tenant_status_idx" ON "address_change_requests" USING btree ("tenant_id","status");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "address_change_pending_uidx" ON "address_change_requests" USING btree ("order_id") WHERE "status" = 'pending';
