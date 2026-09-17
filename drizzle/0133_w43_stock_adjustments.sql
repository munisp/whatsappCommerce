-- W43 (Coder B): stock_adjustments — append-only audit trail for EVERY
-- stock mutation (restock, fulfill, cancel-release, exchange, backorder
-- fill, manual counts/corrections). Rows are written in the SAME
-- transaction as the stock mutation they describe (see
-- server/services/stockAdjustments.ts recordStockAdjustment). ADDITIVE ONLY.
CREATE TABLE IF NOT EXISTS "stock_adjustments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"product_id" varchar(36) NOT NULL,
	"variant_id" varchar(36),
	"delta_qty" integer NOT NULL,
	"reason" varchar(20) NOT NULL,
	"ref_type" varchar(32),
	"ref_id" varchar(64),
	"actor_id" varchar(64),
	"note" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "stock_adjustments_reason_chk" CHECK ("reason" IN ('restock','damage','theft','correction','count','backorder_fill','exchange_in','exchange_out','other'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stock_adjustments_tenant_product_idx" ON "stock_adjustments" USING btree ("tenant_id","product_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stock_adjustments_tenant_created_idx" ON "stock_adjustments" USING btree ("tenant_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stock_adjustments_ref_idx" ON "stock_adjustments" USING btree ("tenant_id","ref_type","ref_id");
