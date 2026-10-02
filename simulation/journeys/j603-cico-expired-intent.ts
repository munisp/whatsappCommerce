// === W60 persistence ===
/**
 * J603 — W60-A CRITICAL #1 (expiry): an EXPIRED pending CICO intent is
 * unclaimable — CONFIRM after the 10-minute window never moves money; the
 * stale row is lazily swept on the next park.
 */
import { eq } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { seedUcTenant } from "./w46-uc-docs-seed";

export const journey: Journey = {
  id: "J603",
  name: "expired CICO intent unclaimable; lazy sweep on park",
  feature: "W60 persistence: pending_cico_intents expiry",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const chat = await import("../../server/services/bankingChat");
    const { tenantId } = await seedUcTenant(world, "603", 6031);
    const admin = world.newPhone("603");
    await world.db.update(schema.tenants).set({ settings: { adminPhone: admin, agentBanking: { enabled: true } } as any })
      .where(eq(schema.tenants.id, tenantId));
    await world.db.insert(schema.merchantWallets).values({ tenantId, custodyMode: "psp", availableBalance: "1000.00" }).onConflictDoNothing();
    const customer = "08031234567";

    // Expired intent (parked 20 minutes ago, TTL 10 min).
    const ref = "CICO-J603OLD";
    await world.db.insert(schema.pendingCicoIntents).values({
      key: `${tenantId}:${ref}`,
      tenantId,
      agentIdentity: admin,
      kind: "cash_in",
      phone: customer,
      amountCents: 42_000,
      payload: null,
      expiresAt: new Date(Date.now() - 10 * 60 * 1000),
      createdAt: new Date(Date.now() - 20 * 60 * 1000),
    }).onConflictDoNothing();

    const out = await chat.handleBankingCommand({ db: world.db, tenantId, fromPhone: admin, text: `CONFIRM ${ref}`, channel: "whatsapp" });
    assert(out.handled && !out.reply!.includes("completed"), `expired intent refused (got ${out.reply})`);
    const { customerBalanceCents } = await import("../../server/services/agentBanking");
    assert(await customerBalanceCents(world.db, tenantId, customer) === 0, "expired intent moved no money");

    // Lazy sweep: the next park removes the expired row.
    const start = await chat.handleBankingCommand({ db: world.db, tenantId, fromPhone: admin, text: `CASH IN ${customer} 10`, channel: "whatsapp" });
    assert(start.handled && start.reply!.includes("CONFIRM CICO-"), "fresh park works");
    const stale = await world.db.select().from(schema.pendingCicoIntents)
      .where(eq(schema.pendingCicoIntents.key, `${tenantId}:${ref}`));
    assert(stale.length === 0, "expired row lazily swept on insert");
  },
};
