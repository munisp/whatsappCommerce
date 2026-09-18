// === W46 kyc (Coder A) ===
/**
 * J391 — TEN-13: DSAR export merchant-wallet gating.
 *  owner        → full wallet + ledger export (owner_full).
 *  operator     → NO wallet object; ledger scoped to transactions the
 *                 operator initiated or that settle their own orders
 *                 (subject_scoped).
 *  legacy solo  → no membership rows → users.tenantId holder = owner.
 */
import { randomUUID } from "node:crypto";
import { assert, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J391",
  name: "DSAR export: wallet gated to owner, ledger subject-scoped",
  feature: "TEN-13 exportMyData merchant-wallet owner gate + scoping",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { appRouter } = await import("../../server/routers");
    const mkCaller = (u: any) => appRouter.createCaller({
      user: { id: u.id, openId: u.openId, email: u.email, name: u.name, phone: u.phone ?? null, loginMethod: "keycloak", role: "user", tenantId: u.tenantId, createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
      req: { protocol: "http", headers: {} }, res: { clearCookie: () => {} },
    } as any);
    const mkUser = async (tag: string, tenantId: string) => {
      const [u] = await world.db.insert(schema.users).values({
        openId: `j391-${tag}-${randomUUID().slice(0, 8)}`, email: `j391-${tag}@sim.local`, name: `J391 ${tag}`,
        loginMethod: "keycloak", role: "user", tenantId, lastSignedIn: new Date(),
      }).returning();
      return u;
    };

    // ── Tenant with owner + operator staff ─────────────────────────────
    const tenantId = `j391-${randomUUID().slice(0, 8)}`;
    await world.db.insert(schema.tenants).values({
      id: tenantId, name: "J391 DSAR Store", slug: tenantId, status: "active",
    }).onConflictDoNothing();
    const owner = await mkUser("owner", tenantId);
    const operator = await mkUser("op", tenantId);
    await world.db.insert(schema.tenantMemberships).values([
      { tenantId, userId: String(owner.id), role: "owner" },
      { tenantId, userId: String(operator.id), role: "operator" },
    ]).onConflictDoNothing();

    const walletId = randomUUID();
    await world.db.insert(schema.merchantWallets).values({
      id: walletId, tenantId, availableBalance: "1000.00",
    }).onConflictDoNothing();
    // One tx initiated BY the operator, one by the owner (not the operator).
    await world.db.insert(schema.walletTransactions).values([
      { id: randomUUID(), walletId, tenantId, type: "escrow_release", amount: "100.00", balanceBefore: "0", balanceAfter: "100.00", metadata: { actorId: String(operator.id) } },
      { id: randomUUID(), walletId, tenantId, type: "withdrawal", amount: "50.00", balanceBefore: "100.00", balanceAfter: "50.00", metadata: { actorId: String(owner.id) } },
    ]);

    // owner → full export.
    const ownerExport = await mkCaller(owner).privacy.exportMyData();
    assert(ownerExport.merchantWallet, "owner sees the merchant wallet");
    assert((ownerExport.walletTransactions as unknown[]).length === 2, "owner sees the full ledger");
    assert((ownerExport as any).walletExportScope === "owner_full", "owner scope disclosed");

    // operator → wallet withheld, ledger scoped to their own tx.
    const opExport = await mkCaller(operator).privacy.exportMyData();
    assert(opExport.merchantWallet === null, "operator does NOT get the tenant wallet");
    const opTxs = opExport.walletTransactions as any[];
    assert(opTxs.length === 1 && opTxs[0].metadata?.actorId === String(operator.id),
      `operator ledger scoped to own transactions (got ${opTxs.length})`);
    assert((opExport as any).walletExportScope === "subject_scoped", "scoped export disclosed");

    // legacy solo merchant (no membership rows) → owner-equivalent export.
    const tenant2 = `j391b-${randomUUID().slice(0, 8)}`;
    await world.db.insert(schema.tenants).values({
      id: tenant2, name: "J391 Legacy Store", slug: tenant2, status: "active",
    }).onConflictDoNothing();
    const solo = await mkUser("solo", tenant2);
    const w2 = randomUUID();
    await world.db.insert(schema.merchantWallets).values({ id: w2, tenantId: tenant2 }).onConflictDoNothing();
    await world.db.insert(schema.walletTransactions).values(
      { id: randomUUID(), walletId: w2, tenantId: tenant2, type: "escrow_release", amount: "5.00", balanceBefore: "0", balanceAfter: "5.00", metadata: {} },
    );
    const soloExport = await mkCaller(solo).privacy.exportMyData();
    assert(soloExport.merchantWallet && (soloExport.walletTransactions as unknown[]).length === 1,
      "legacy solo merchant keeps the full export");
  },
};
// === END W46 kyc ===
