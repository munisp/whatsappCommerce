// === W59 banking-pos ===
/**
 * J596 — cash-out EXACT integer-cent split: customer debited amount+fee,
 * agent credited amount + commission (floor(amount×bps/10000) from the
 * platform fee wallet), platform nets fee−commission. floatSummary totals +
 * low-float flag + fail-open WA alert seam.
 */
import { eq } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { seedUcTenant } from "./w46-uc-docs-seed";

export const journey: Journey = {
  id: "J596",
  name: "cash-out exact split + float summary + low-float alert",
  feature: "W59 banking-pos: agentBanking cash_out / floatSummary",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const svc = await import("../../server/services/agentBanking");
    const { tenantId } = await seedUcTenant(world, "596", 5961);
    const phone = world.newPhone("596");
    await world.db.update(schema.tenants).set({ settings: { agentBanking: { enabled: true }, adminPhone: world.newPhone("596a") } as any })
      .where(eq(schema.tenants.id, tenantId));

    // Config: 100 bps commission, low-float threshold 500.00.
    await world.db.update(schema.escrowConfig).set({ agentCommissionBps: 100, agentFloatAlertThresholdCents: 50_000 } as any)
      .where(eq(schema.escrowConfig.id, 1));
    // Platform fee wallet funded (commission source); agent float empty.
    await world.db.insert(schema.merchantWallets).values({
      id: "platform-fee-wallet", tenantId: "platform-fees", custodyMode: "psp", availableBalance: "100.00",
    }).onConflictDoNothing();
    await world.db.insert(schema.merchantWallets).values({
      tenantId, custodyMode: "psp", availableBalance: "0",
    }).onConflictDoNothing();

    // Customer wallet funded via the claim-first customerWallet seam.
    const { creditWallet } = await import("../../server/services/customerWallet");
    const credit = await creditWallet(tenantId, phone, 100_000, "topup", "J596-TOPUP");
    assert(credit.ok, "customer funded");

    // Platform fee wallet is a shared-world singleton (earlier journeys fund
    // it) — assert the DELTA around this cash-out, not an absolute balance.
    const [pfwBefore] = await world.db.select().from(schema.merchantWallets).where(eq(schema.merchantWallets.id, "platform-fee-wallet"));
    const pfwBase = parseFloat(pfwBefore?.availableBalance ?? "100");
    // amount 250.00 (25000c) + fee 1.00 (100c); commission floor(25000*100/10000)=250c
    const r = await svc.executeCico(world.db, { agentTenantId: tenantId, customerPhone: phone, kind: "cash_out", amountCents: 25_000, feeCents: 100, clientRef: "J596-1" });
    assert(r.status === "completed" && r.commissionCents === 250, "exact floor commission");
    assert(await svc.customerBalanceCents(world.db, tenantId, phone) === 100_000 - 25_100, "customer debited amount+fee");
    assert(await svc.agentFloatCents(world.db, tenantId) === 25_000 + 250, "agent credited amount+commission");
    const [pfw] = await world.db.select().from(schema.merchantWallets).where(eq(schema.merchantWallets.id, "platform-fee-wallet"));
    assert(Math.abs(parseFloat(pfw.availableBalance) - (pfwBase + 1 - 2.5)) < 1e-9, "platform nets fee−commission");

    // floatSummary: below threshold → lowFloat
    const summary = await svc.floatSummary(world.db, tenantId);
    assert(summary.floatCents === 25_250 && summary.lowFloat === true, "float summary + low-float flag");
    assert(summary.todayCashOutCents === 25_000 && summary.todayCommissionCents === 250, "today totals");
    // Fail-open WA alert returns true (admin phone present, send simulated)
    const alerted = await svc.maybeAlertLowFloat(world.db, tenantId);
    assert(alerted === true, "low-float alert dispatched (fail-open)");
  },
};
