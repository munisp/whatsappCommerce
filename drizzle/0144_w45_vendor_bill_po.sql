-- === W45 orders-p0 (Coder C) ===
-- ORD-17: vendor_bills.po_id — links a captured vendor bill to the purchase
-- order it settles. When set, recordVendorBillPayment runs the claim-first
-- 3-way match (billed <= received) before any money moves. ADDITIVE ONLY.
ALTER TABLE "vendor_bills" ADD COLUMN IF NOT EXISTS "po_id" uuid;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vendor_bills_po_idx" ON "vendor_bills" USING btree ("po_id");
