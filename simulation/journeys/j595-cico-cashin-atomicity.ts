// === W59 banking-pos ===
/**
 * J595 — agent cash-in ATOMICITY: one transaction debits agent float and
 * credits the customer wallet; insufficient float is fail-closed with NO
 * partial state (no ledger row, no customer credit); capability flag gate
 * (settings.agentBanking.enabled) rejects disabled tenants.
 */
import { eq } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { seedUcTenant } from "./w46-uc-docs-seed";

async function enable(world: World, tenantId: string, on = true) {
  const schema = await import("../../drizzle/schema");
  await world.db.update(schema.tenants).set({ settings: { agentBanking: { enabled: on } } as any })
    .where(eq(schema.tenants.id, tenantId));
}

export const journey: Journey = {
  id: "J595",
  name: "cash-in atomicity + insufficient-float no-partial + capability gate",
  feature: "W59 banking-pos: agentBanking cash_in",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const svc = await import("../../server/services/agentBanking");
    const { tenantId } = await seedUcTenant(world, "595", 5951);
    const phone = world.newPhone("595");

    // ── 1. Capability gate ─────────────────────────────────────────────
    let gated = false;
    try {
      await svc.assertAgentBankingEnabled(world.db, tenantId);
    } catch (e: any) { gated = e?.code === "FORBIDDEN"; }
    assert(gated, "disabled tenant is FORBIDDEN");
    await enable(world, tenantId);
    await svc.assertAgentBankingEnabled(world.db, tenantId);

    // ── 2. Funded cash-in moves money exactly once ─────────────────────
    await world.db.insert(schema.merchantWallets).values({
      tenantId, custodyMode: "psp", availableBalance: "1000.00",
    }).onConflictDoNothing();
    const r1 = await svc.executeCico(world.db, { agentTenantId: tenantId, customerPhone: phone, kind: "cash_in", amountCents: 25_000, clientRef: "J595-1" });
    assert(!r1.duplicate && r1.status === "completed", "cash-in completed");
    assert(await svc.customerBalanceCents(world.db, tenantId, phone) === 25_000, "customer credited 250.00");
    assert(await svc.agentFloatCents(world.db, tenantId) === 75_000 + (r1.commissionCents), "agent float debited (plus commission credit)");
    // replay
    const r1b = await svc.executeCico(world.db, { agentTenantId: tenantId, customerPhone: phone, kind: "cash_in", amountCents: 25_000, clientRef: "J595-1" });
    assert(r1b.duplicate === true, "replay is duplicate");
    assert(await svc.customerBalanceCents(world.db, tenantId, phone) === 25_000, "replay moved no money");

    // ── 3. Insufficient float: fail-closed, NO partial ─────────────────
    let failed = false;
    try {
      await svc.executeCico(world.db, { agentTenantId: tenantId, customerPhone: phone, kind: "cash_in", amountCents: 9_000_000, clientRef: "J595-2" });
    } catch (e: any) { failed = /INSUFFICIENT_FLOAT/.test(e?.message ?? ""); }
    assert(failed, "insufficient float rejected");
    assert(await svc.customerBalanceCents(world.db, tenantId, phone) === 25_000, "no partial customer credit");
    const rows = await world.db.select().from(schema.agentCicoTransactions)
      .where(eq(schema.agentCicoTransactions.reference, "CICO-J595-2"));
    assert(rows.length === 0, "no ledger row survived the rollback");
    const [w] = await world.db.select().from(schema.merchantWallets).where(eq(schema.merchantWallets.tenantId, tenantId));
    assert(parseFloat(w.availableBalance) === 750 + r1.commissionCents / 100, "agent float untouched by failed cash-in");
  },
};
