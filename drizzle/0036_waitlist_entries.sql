CREATE TABLE "waitlist_entries" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"tenantId" varchar(36) NOT NULL,
	"productId" varchar(36) NOT NULL,
	"phone" varchar(30) NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"notifiedAt" timestamp
);
--> statement-breakpoint
CREATE INDEX "waitlist_entries_tenant_idx" ON "waitlist_entries" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX "waitlist_entries_product_idx" ON "waitlist_entries" USING btree ("productId");--> statement-breakpoint
CREATE UNIQUE INDEX "waitlist_entries_tenant_product_phone_idx" ON "waitlist_entries" USING btree ("tenantId","productId","phone");
