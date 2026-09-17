-- === W45 orders-p0 (Coder C) ===
-- ORD-17: goods_receipts (GRN lines) + po_items.received_qty — the 3-way
-- match (billed <= received) enforced claim-first before vendor-bill payment
-- release (server/services/goodsReceipts.ts).
-- ORD-9: products."weightKg" — per-unit shipping weight summed at chat
-- checkout for the delivery-fee quote. ADDITIVE ONLY.
CREATE TABLE IF NOT EXISTS "goods_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"po_id" uuid NOT NULL,
	"po_item_id" uuid NOT NULL,
	"received_qty" integer NOT NULL,
	"received_by" varchar(64),
	"note" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "goods_receipts_received_qty_chk" CHECK ("received_qty" > 0)
);
--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_po_id_purchase_orders_id_fk" FOREIGN KEY ("po_id") REFERENCES "public"."purchase_orders"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_po_item_id_po_items_id_fk" FOREIGN KEY ("po_item_id") REFERENCES "public"."po_items"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "goods_receipts_po_idx" ON "goods_receipts" USING btree ("po_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "goods_receipts_tenant_idx" ON "goods_receipts" USING btree ("tenant_id","created_at");
--> statement-breakpoint
ALTER TABLE "po_items" ADD COLUMN IF NOT EXISTS "received_qty" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "weightKg" numeric(8, 3);
