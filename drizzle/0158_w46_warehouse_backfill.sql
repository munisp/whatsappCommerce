-- === W46 inventory-depth (ORD-16): single-default-warehouse backfill ===
-- Existing stock predates warehouse_stock. This migration gives every tenant
-- that has stock ONE default warehouse ("Main Warehouse") and mirrors each
-- product's stockQuantity into a product-level warehouse_stock row
-- (variantId = '') so reserve-time allocation has real rows to claim.
-- Idempotent: NOT EXISTS guards make re-runs no-ops. ADDITIVE ONLY.
INSERT INTO "warehouses" ("id", "tenantId", "name", "isDefault", "createdAt")
SELECT 'wh-default-' || p."tenantId", p."tenantId", 'Main Warehouse', true, now()
FROM (SELECT DISTINCT "tenantId" FROM "products" WHERE "stockQuantity" > 0) p
WHERE NOT EXISTS (
	SELECT 1 FROM "warehouses" w WHERE w."id" = 'wh-default-' || p."tenantId"
);
--> statement-breakpoint
INSERT INTO "warehouse_stock" ("id", "tenantId", "warehouseId", "productId", "variantId", "qty", "updatedAt")
SELECT 'ws-default-' || p.id, p."tenantId", 'wh-default-' || p."tenantId", p.id, '', p."stockQuantity", now()
FROM "products" p
WHERE p."stockQuantity" > 0
	AND EXISTS (SELECT 1 FROM "warehouses" w WHERE w."id" = 'wh-default-' || p."tenantId")
	AND NOT EXISTS (SELECT 1 FROM "warehouse_stock" ws WHERE ws."id" = 'ws-default-' || p.id);
