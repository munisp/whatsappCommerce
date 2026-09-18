// === W46 uc-docs ===
/**
 * J406 — UC-18: wholesale tier resolution from the buyer's ACTUAL
 * type/group at quote time. Resolution order: explicit > customer tags >
 * latest RFQ > 'wholesale' default. Tier brackets pick the deepest matching
 * tier; per-group discountPercent applies on top; the buyer's own type beats
 * the 'wholesale' fallback; and the b2bCatalog hardcode is gone — the local
 * catalog prices with the resolved buyer type.
 */
import { and, eq } from "drizzle-orm";
import { assert, SUPPLIER_TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { seedUcTenant } from "./w46-uc-docs-seed";

const PROD = "prod-w46-406";
const PHONE_DIST = "2348040000406";
const PHONE_ANON = "2348040001406";

export const journey: Journey = {
  id: "J406",
  name: "tier resolution from the buyer's actual type/group at quote time",
  feature: "W46 uc-docs: UC-18 tier pricing",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const tp = await import("../../server/services/tierPricing");
    const { getWholesaleCatalog } = await import("../../server/services/procurement/b2bCatalog");
    const { tenantId, caller } = await seedUcTenant(world, "406");

    // Product with wholesale + distributor tiers (distributor has 5% off).
    await world.db.delete(schema.products).where(eq(schema.products.id, PROD)).catch(() => undefined);
    await world.db.insert(schema.products).values({
      id: PROD, tenantId, sku: "SIM-W46-406", name: "W46 Tiered Product",
      price: "2000.00", currency: "NGN", status: "active", stockQuantity: 100,
      metadata: { wholesalePrice: "1800.00" },
    } as any);
    const tier = (buyerType: "wholesale" | "distributor", minQuantity: number, unitPrice: string, discountPercent?: string, maxQuantity?: number) =>
      world.db.insert(schema.wholesalePriceTiers).values({
        id: crypto.randomUUID(), tenantId, productId: PROD, buyerType, minQuantity,
        maxQuantity: maxQuantity ?? null, unitPrice, currency: "NGN", discountPercent: discountPercent ?? null,
        createdAt: new Date(), updatedAt: new Date(),
      } as any);
    await tier("wholesale", 10, "1500.00");
    await tier("wholesale", 50, "1200.00");
    await tier("distributor", 10, "1400.00", "5"); // per-group discount: 5% off

    // ── resolveBuyerType precedence ──────────────────────────────────────
    const anon = await tp.resolveBuyerType(world.db, { tenantId, phone: PHONE_ANON });
    assert(anon.buyerType === "wholesale" && anon.source === "default", "anonymous buyer keeps the legacy wholesale default");

    // RFQ self-declaration → government.
    await world.db.insert(schema.b2bRfq).values({
      id: crypto.randomUUID(), tenantId, buyerPhone: PHONE_ANON, buyerName: "Gov Buyer", buyerType: "government",
      items: [], currency: "NGN", status: "submitted", createdAt: new Date(), updatedAt: new Date(),
    } as any);
    const viaRfq = await tp.resolveBuyerType(world.db, { tenantId, phone: PHONE_ANON });
    assert(viaRfq.buyerType === "government" && viaRfq.source === "rfq", "buyerType from latest RFQ");

    // Customer tags beat RFQ history.
    await world.db.insert(schema.customers).values({
      id: crypto.randomUUID(), tenantId, whatsappPhone: PHONE_DIST, name: "Dist Buyer", tags: ["vip", "distributor"],
    } as any).onConflictDoNothing();
    const viaTags = await tp.resolveBuyerType(world.db, { tenantId, phone: PHONE_DIST });
    assert(viaTags.buyerType === "distributor" && viaTags.source === "customer_tags", "buyerType from customer tags");
    const explicit = await tp.resolveBuyerType(world.db, { tenantId, phone: PHONE_DIST, explicit: "retail" });
    assert(explicit.buyerType === "retail" && explicit.source === "explicit", "explicit wins");

    // ── resolveTierPrice brackets + per-group discount ───────────────────
    const w5 = await tp.resolveTierPrice(world.db, { tenantId, productId: PROD, buyerType: "wholesale", quantity: 5 });
    assert(w5?.unitPriceCents === 180_000 && w5.source === "metadata", "qty below min tier → metadata wholesale price");
    const w10 = await tp.resolveTierPrice(world.db, { tenantId, productId: PROD, buyerType: "wholesale", quantity: 10 });
    assert(w10?.unitPriceCents === 150_000 && w10.source === "tier", "wholesale tier min 10");
    const w60 = await tp.resolveTierPrice(world.db, { tenantId, productId: PROD, buyerType: "wholesale", quantity: 60 });
    assert(w60?.unitPriceCents === 120_000, "deepest bracket (min 50) wins");
    const d10 = await tp.resolveTierPrice(world.db, { tenantId, productId: PROD, buyerType: "distributor", quantity: 10 });
    assert(d10?.unitPriceCents === Math.round(140_000 * 0.95) && d10.discountPercent === 5, `distributor tier + 5% group discount (got ${d10?.unitPriceCents})`);
    // Retail buyer: no retail tiers → falls back to the wholesale tier.
    const r10 = await tp.resolveTierPrice(world.db, { tenantId, productId: PROD, buyerType: "retail", quantity: 10 });
    assert(r10?.unitPriceCents === 150_000 && r10.source === "tier_fallback_wholesale", "retail falls back to wholesale tier honestly");

    // ── quoteForBuyer (router surface) resolves the group from tags ──────
    const quote = await caller.ucDocs.quoteForBuyer({
      tenantId, phone: PHONE_DIST, items: [{ productId: PROD, quantity: 10 }],
    });
    assert(quote.buyerType === "distributor", "quote resolved distributor from tags");
    assert(quote.lines[0]!.resolution?.unitPriceCents === 133_000, "quote carries the discounted distributor price");
    assert(quote.totalCents === 1_330_000, `quote total (got ${quote.totalCents})`);

    // ── b2bCatalog: hardcoded 'wholesale' is gone ────────────────────────
    const { readFile } = await import("node:fs/promises");
    const src = await readFile(new URL("../../server/services/procurement/b2bCatalog.ts", import.meta.url), "utf8");
    assert(!src.includes('eq(wholesalePriceTiers.buyerType, "wholesale")'), "hardcoded buyerType='wholesale' removed from b2bCatalog");

    // Catalog prices with the buyer's ACTUAL type: the supplier tenant gets
    // a product + distributor tier, and a distributor buyer sees that price.
    await world.db.delete(schema.products).where(eq(schema.products.id, "prod-w46-406s")).catch(() => undefined);
    await world.db.insert(schema.products).values({
      id: "prod-w46-406s", tenantId: SUPPLIER_TENANT_ID, sku: "SIM-W46-406S", name: "Supplier Tiered",
      price: "1000.00", currency: "NGN", status: "active", stockQuantity: 100,
    } as any);
    await world.db.insert(schema.wholesalePriceTiers).values({
      id: crypto.randomUUID(), tenantId: SUPPLIER_TENANT_ID, productId: "prod-w46-406s",
      buyerType: "distributor", minQuantity: 1, unitPrice: "700.00", currency: "NGN",
      createdAt: new Date(), updatedAt: new Date(),
    } as any);
    const catAnon = await getWholesaleCatalog(world.db, { supplierTenantId: SUPPLIER_TENANT_ID, buyerPhone: PHONE_ANON });
    const itemAnon = catAnon?.items.find((i) => i.productRef === "prod-w46-406s");
    // Anonymous buyer (wholesale default): NO wholesale tier → retail price.
    assert(itemAnon?.unitPriceCents === 100_000, `anonymous buyer sees retail 100000 (got ${itemAnon?.unitPriceCents})`);
    const catDist = await getWholesaleCatalog(world.db, { supplierTenantId: SUPPLIER_TENANT_ID, buyerType: "distributor" });
    const itemDist = catDist?.items.find((i) => i.productRef === "prod-w46-406s");
    assert(itemDist?.unitPriceCents === 70_000, `distributor sees their tier 70000 (got ${itemDist?.unitPriceCents})`);

    // Cleanup so other journeys' supplier catalog queries stay deterministic.
    await world.db.delete(schema.wholesalePriceTiers)
      .where(and(eq(schema.wholesalePriceTiers.tenantId, SUPPLIER_TENANT_ID), eq(schema.wholesalePriceTiers.productId, "prod-w46-406s")));
    await world.db.delete(schema.products).where(eq(schema.products.id, "prod-w46-406s"));
  },
};
