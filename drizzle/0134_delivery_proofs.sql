-- === W43 dispatch (Coder C): proof-of-delivery photos ===
-- ADDITIVE ONLY (hand-written; journaled after 0129 tip, idx 0130–0133
-- reserved for Coders A/B per SPEC_W43 — merger re-chains).
--
-- delivery_proofs: photo/signature/otp evidence captured at handover,
-- either posted by the courier via POST /api/delivery/proof or sent by the
-- customer in chat while the order is in the awaiting-POD state
-- (shipment out_for_delivery/in_transit + tenants.requirePod = true).
-- tenants.requirePod (default FALSE) gates the → delivered transition:
-- when false the pre-W43 behavior is byte-identical.
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "requirePod" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "delivery_proofs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"order_id" varchar(36) NOT NULL,
	"fulfillment_id" varchar(36),
	"shipment_id" varchar(36),
	"type" varchar(16) DEFAULT 'photo' NOT NULL,
	"media_url" text,
	"media_key" text,
	"mime_type" varchar(64),
	"captured_by_driver_id" varchar(64),
	"captured_via" varchar(16) DEFAULT 'endpoint' NOT NULL,
	"idempotency_key" varchar(128),
	"captured_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "delivery_proofs_tenant_order_idx" ON "delivery_proofs" USING btree ("tenant_id","order_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "delivery_proofs_order_idx" ON "delivery_proofs" USING btree ("order_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "delivery_proofs_idem_uidx" ON "delivery_proofs" USING btree ("tenant_id","idempotency_key") WHERE "idempotency_key" IS NOT NULL;
