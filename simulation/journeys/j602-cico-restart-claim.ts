// === W60 persistence ===
/**
 * J602 — W60-A CRITICAL #1: the two-step CICO confirm intent is DURABLE
 * (pending_cico_intents table, migration 0180), so it survives a simulated
 * restart and is claimed exactly once.
 *
 *   1. A pre-restart intent is inserted STRAIGHT INTO THE TABLE (this is
 *      exactly the state a freshly-booted process sees — the pre-W60
 *      in-proc Map would have lost it). CONFIRM via the real bankingChat
 *      handler still executes the cash movement.
 *   2. A second CONFIRM of the same ref is refused (atomic DELETE ...
 *      RETURNING consumed the row — exactly once).
 *   3. Concurrent double-claim: two parallel CONFIRMs race; exactly one
 *      executes, money moves once.
 */
import { eq } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { seedUcTenant } from "./w46-uc-docs-seed";

export const journey: Journey = {
  id: "J602",
  name: "CICO confirm intent survives restart; atomic exactly-once claim",
  feature: "W60 persistence: pending_cico_intents",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const chat = await import("../../server/services/bankingChat");
    const { tenantId } = await seedUcTenant(world, "602", 6021);
    const admin = world.newPhone("602");
    await world.db.update(schema.tenants).set({ settings: { adminPhone: admin, agentBanking: { enabled: true } } as any })
      .where(eq(schema.tenants.id, tenantId));
    await world.db.insert(schema.merchantWallets).values({ tenantId, custodyMode: "psp", availableBalance: "1000.00" }).onConflictDoNothing();
    const customer = "08031234567";

    // ── 1. Pre-restart intent (straight into the durable table) ────────
    const ref = "CICO-J602RST";
    await world.db.insert(schema.pendingCicoIntents).values({
      key: `${tenantId}:${ref}`,
      tenantId,
      agentIdentity: admin,
      kind: "cash_in",
      phone: customer,
      amountCents: 15_000,
      payload: null,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    }).onConflictDoNothing();

    // "Restart": the freshly-booted handler has no in-proc state — the
    // confirm is served entirely from the durable row.
    const done = await chat.handleBankingCommand({ db: world.db, tenantId, fromPhone: admin, text: `CONFIRM ${ref}`, channel: "whatsapp" });
    assert(done.handled && done.reply!.includes("completed"), `restart-surviving confirm executes (got ${done.reply})`);
    const { customerBalanceCents } = await import("../../server/services/agentBanking");
    assert(await customerBalanceCents(world.db, tenantId, customer) === 15_000, "cash-in settled after restart");

    // ── 2. Second CONFIRM refused (row claimed exactly once) ───────────
    const again = await chat.handleBankingCommand({ db: world.db, tenantId, fromPhone: admin, text: `CONFIRM ${ref}`, channel: "whatsapp" });
    assert(again.handled && !again.reply!.includes("completed"), "second confirm refused");
    assert(await customerBalanceCents(world.db, tenantId, customer) === 15_000, "no double money movement");

    // ── 3. Concurrent double-claim race: exactly one winner ────────────
    const ref2 = "CICO-J602RACE";
    await world.db.insert(schema.pendingCicoIntents).values({
      key: `${tenantId}:${ref2}`,
      tenantId,
      agentIdentity: admin,
      kind: "cash_in",
      phone: customer,
      amountCents: 20_000,
      payload: null,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    }).onConflictDoNothing();
    const [r1, r2] = await Promise.all([
      chat.handleBankingCommand({ db: world.db, tenantId, fromPhone: admin, text: `CONFIRM ${ref2}`, channel: "whatsapp" }),
      chat.handleBankingCommand({ db: world.db, tenantId, fromPhone: admin, text: `CONFIRM ${ref2}`, channel: "telegram" }),
    ]);
    const wins = [r1, r2].filter((r) => r.reply?.includes("completed")).length;
    assert(wins === 1, `exactly one concurrent claim wins (got ${wins})`);
    assert(await customerBalanceCents(world.db, tenantId, customer) === 35_000, "race settled exactly once");
  },
};
