/**
 * procurement directory + b2b catalog + menu registration tests.
 *
 *  - directory listing: active-only, category filter, self-exclusion,
 *    buyer credit summary attachment
 *  - supplier profile upsert (create + partial update)
 *  - wholesale catalog: wholesale_price_tiers > metadata.wholesalePrice >
 *    retail price; min quantities; inactive supplier → null; Medusa fallback
 *  - "procurement" use-case menu registration (renders for enabled tenants)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────────
const sendTextMock = vi.hoisted(() => vi.fn(async () => ({ sent: true })));
const sendInteractiveMock = vi.hoisted(() => vi.fn(async () => ({ sent: true })));
vi.mock("./services/waSender", () => ({
  sendWhatsAppText: (...a: any[]) => sendTextMock(...a),
  sendWhatsAppInteractive: (...a: any[]) => sendInteractiveMock(...a),
  sendWhatsAppMedia: vi.fn(async () => ({ sent: true })),
}));

const credit = vi.hoisted(() => ({
  getCreditAccount: vi.fn(async (_s: string, _b: string) => null as any),
  drawOnCredit: vi.fn(async () => ({ ok: true as const, ledgerId: "led-1", outstandingAfter: 0 })),
  suggestLimit: vi.fn(async () => ({ score: 50, suggestedLimitCents: 100_000, reasons: [] as string[] })),
}));
vi.mock("./services/tradeCredit", () => credit);

vi.mock("./services/medusaAdapter", () => ({
  listPriceLists: vi.fn(async () => { throw new Error("medusa not configured"); }),
  listProducts: vi.fn(async () => { throw new Error("medusa not configured"); }),
}));

vi.mock("./redis", () => ({ getRedis: vi.fn(async () => null) }));

import {
  getSupplierProfile,
  listSuppliers,
  upsertSupplierProfile,
} from "./services/procurement/directory";
import { getWholesaleCatalog, majorToCents } from "./services/procurement/b2bCatalog";
import { makeFakeDb, seedSupplierProfile } from "./services/procurement/fakeDb";
import { buildMenuEntries, renderWhatsAppMenu } from "./services/waMenu";
import { useCaseRegistry } from "./services/useCases";

const TENANTS = [
  { id: "buyer-1", name: "Buyer One", settings: null },
  { id: "supplier-1", name: "Ada Wholesale", settings: null },
  { id: "supplier-2", name: "Chidi Foods", settings: null },
  { id: "supplier-3", name: "Paused Supplies", settings: null },
];

function makeDb(seed: Parameters<typeof makeFakeDb>[0]) {
  return makeFakeDb({ tenants: TENANTS.map((t) => ({ ...t })), ...seed });
}

beforeEach(() => {
  vi.clearAllMocks();
  credit.getCreditAccount.mockResolvedValue(null);
});

describe("supplier directory", () => {
  it("lists ACTIVE suppliers only, excluding the buyer's own tenant", async () => {
    const { db } = makeDb({
      supplierProfiles: [
        seedSupplierProfile({ tenantId: "supplier-1" }),
        seedSupplierProfile({ tenantId: "supplier-2", categories: ["food"] }),
        seedSupplierProfile({ tenantId: "supplier-3", status: "paused" }),
        seedSupplierProfile({ tenantId: "buyer-1" }), // self — must be excluded
      ],
    });
    const list = await listSuppliers(db, { buyerTenantId: "buyer-1" });
    expect(list.map((s) => s.tenantId).sort()).toEqual(["supplier-1", "supplier-2"]);
    expect(list[0].name).toBeTruthy();
  });

  it("filters by category (case-insensitive)", async () => {
    const { db } = makeDb({
      supplierProfiles: [
        seedSupplierProfile({ tenantId: "supplier-1", categories: ["Beverages"] }),
        seedSupplierProfile({ tenantId: "supplier-2", categories: ["food"] }),
      ],
    });
    const list = await listSuppliers(db, { buyerTenantId: "buyer-1", category: "beverages" });
    expect(list.map((s) => s.tenantId)).toEqual(["supplier-1"]);
  });

  it("attaches the buyer's existing credit account summary", async () => {
    credit.getCreditAccount.mockResolvedValue({
      id: "acct-1", status: "active", limitCents: 200_000, outstandingCents: 50_000, termsDays: 30,
    } as any);
    const { db } = makeDb({ supplierProfiles: [seedSupplierProfile({ tenantId: "supplier-1" })] });
    const [entry] = await listSuppliers(db, { buyerTenantId: "buyer-1" });
    expect(credit.getCreditAccount).toHaveBeenCalledWith("supplier-1", "buyer-1");
    expect(entry.credit).toMatchObject({ accountId: "acct-1", limitCents: 200_000, outstandingCents: 50_000, termsDays: 30 });
  });

  it("returns null credit summary when the buyer has no account", async () => {
    const { db } = makeDb({ supplierProfiles: [seedSupplierProfile({ tenantId: "supplier-1" })] });
    const [entry] = await listSuppliers(db, { buyerTenantId: "buyer-1" });
    expect(entry.credit).toBeNull();
  });

  it("upsert creates then partially updates a supplier profile", async () => {
    const { db, store } = makeDb({});
    const created = await upsertSupplierProfile(db, {
      tenantId: "supplier-1", moqCents: 25_000, leadTimeDays: 5, termsOffered: [14, 30], categories: ["grain"],
    });
    expect(created).toMatchObject({ tenantId: "supplier-1", moqCents: 25_000, leadTimeDays: 5, status: "active" });
    const updated = await upsertSupplierProfile(db, { tenantId: "supplier-1", autoApproveBelowCents: 10_000 });
    expect(updated.moqCents).toBe(25_000); // untouched fields preserved
    expect(updated.autoApproveBelowCents).toBe(10_000);
    expect(store.supplierProfiles).toHaveLength(1);
    const fetched = await getSupplierProfile(db, "supplier-1");
    expect(fetched?.defaultTermsDays).toBe(14);
  });
});

describe("wholesale catalog", () => {
  const profile = seedSupplierProfile({ tenantId: "supplier-1", moqCents: 30_000, leadTimeDays: 4 });

  it("prefers wholesale_price_tiers over retail price, exposing tier min qty", async () => {
    const { db } = makeDb({
      supplierProfiles: [profile],
      products: [
        { id: "p1", tenantId: "supplier-1", sku: "R1", name: "Rice 50kg", price: "40000.00", currency: "NGN", status: "active", stockQuantity: 100, metadata: null },
      ],
      wholesaleTiers: [
        { id: "t1", tenantId: "supplier-1", productId: "p1", buyerType: "wholesale", minQuantity: 10, unitPrice: "35000.00", currency: "NGN" },
      ],
    });
    const catalog = await getWholesaleCatalog(db, { supplierTenantId: "supplier-1" });
    expect(catalog).not.toBeNull();
    expect(catalog!.source).toBe("local"); // Medusa threw → local fallback
    expect(catalog!.moqCents).toBe(30_000);
    expect(catalog!.leadTimeDays).toBe(4);
    expect(catalog!.items[0]).toMatchObject({ productRef: "p1", unitPriceCents: 3_500_000, minQty: 10 });
  });

  it("falls back to metadata.wholesalePrice, then retail price", async () => {
    const { db } = makeDb({
      supplierProfiles: [profile],
      products: [
        { id: "p1", tenantId: "supplier-1", sku: "A", name: "Beans", price: "2000.00", currency: "NGN", status: "active", stockQuantity: 5, metadata: { wholesalePrice: 1800 } },
        { id: "p2", tenantId: "supplier-1", sku: "B", name: "Oil", price: "5000.50", currency: "NGN", status: "active", stockQuantity: 5, metadata: null },
        { id: "p3", tenantId: "supplier-1", sku: "C", name: "Archived", price: "100.00", currency: "NGN", status: "archived", stockQuantity: 5, metadata: null },
      ],
    });
    const catalog = await getWholesaleCatalog(db, { supplierTenantId: "supplier-1" });
    const byRef = Object.fromEntries(catalog!.items.map((i) => [i.productRef, i]));
    expect(byRef.p1.unitPriceCents).toBe(180_000);
    expect(byRef.p2.unitPriceCents).toBe(500_050);
    expect(byRef.p3).toBeUndefined(); // inactive products excluded
  });

  it("returns null for suppliers without an ACTIVE profile", async () => {
    const { db } = makeDb({ supplierProfiles: [seedSupplierProfile({ tenantId: "supplier-1", status: "paused" })] });
    expect(await getWholesaleCatalog(db, { supplierTenantId: "supplier-1" })).toBeNull();
  });

  it("majorToCents converts major units safely", () => {
    expect(majorToCents("123.45")).toBe(12_345);
    expect(majorToCents(7)).toBe(700);
    expect(majorToCents("bad")).toBeNull();
    expect(majorToCents(-3)).toBeNull();
  });
});

describe("procurement use-case registration", () => {
  it("useCaseRegistry exposes a procurement handler", () => {
    expect(typeof (useCaseRegistry as any).procurement).toBe("function");
  });

  it("menu renders the procurement entry for tenants that enable it", () => {
    const config: any = {
      greeting: "Welcome to {businessName}!",
      useCases: [
        { id: "shop", label: "Shop products", enabled: true, order: 1 },
        { id: "procurement", label: "Restock / Buy supplies", enabled: true, order: 2 },
      ],
      customItems: [],
      fallback: "nlp",
    };
    const entries = buildMenuEntries(config);
    expect(entries.map((e) => e.id)).toEqual(["shop", "procurement"]);
    const rendered = renderWhatsAppMenu(config, { businessName: "Ada Stores" });
    expect(rendered).toContain("Restock / Buy supplies");
    expect(rendered).toContain("2.");
  });

  it("disabled procurement entries do not render", () => {
    const config: any = {
      greeting: "Hi",
      useCases: [{ id: "procurement", label: "Restock / Buy supplies", enabled: false, order: 1 }],
      customItems: [],
      fallback: "nlp",
    };
    expect(buildMenuEntries(config)).toHaveLength(0);
    expect(renderWhatsAppMenu(config)).not.toContain("Restock");
  });
});
