CREATE TABLE IF NOT EXISTS "purchase_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"po_number" varchar(32) NOT NULL,
	"buyer_tenant_id" varchar(36) NOT NULL,
	"supplier_tenant_id" varchar(36) NOT NULL,
	"status" varchar(20) DEFAULT 'draft' NOT NULL,
	"subtotal_cents" bigint DEFAULT 0 NOT NULL,
	"payment_mode" varchar(20) DEFAULT 'credit' NOT NULL,
	"credit_account_id" uuid,
	"terms_days" integer,
	"due_date" timestamp,
	"buyer_phone" varchar(30),
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "purchase_orders_po_number_unique" UNIQUE("po_number")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "po_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"po_id" uuid NOT NULL,
	"product_ref" varchar(128),
	"name" varchar(255) NOT NULL,
	"qty" integer NOT NULL,
	"unit_price_cents" bigint NOT NULL,
	"line_total_cents" bigint NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "po_items" ADD CONSTRAINT "po_items_po_id_purchase_orders_id_fk" FOREIGN KEY ("po_id") REFERENCES "public"."purchase_orders"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "purchase_orders_buyer_status_idx" ON "purchase_orders" USING btree ("buyer_tenant_id","status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "purchase_orders_supplier_status_idx" ON "purchase_orders" USING btree ("supplier_tenant_id","status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "po_items_po_idx" ON "po_items" USING btree ("po_id");
