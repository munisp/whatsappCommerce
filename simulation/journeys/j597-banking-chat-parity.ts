// === W59 banking-pos ===
/**
 * J597 — banking chat WA+TG parity: BANK ACCOUNTS / CASH IN + CONFIRM
 * two-step / FLOAT / PAY BY POS handled identically on both channels by the
 * SAME handler (admin-phone authz; non-admin falls through silently).
 */
import { eq } from "drizzle-orm";
import { assert, type World, assertIncludes } from "../world";
import type { Journey } from "../runner";
import { seedUcTenant } from "./w46-uc-docs-seed";

export const journey: Journey = {
  id: "J597",
  name: "banking chat parity: WA+TG keywords, two-step CICO, admin gate",
  feature: "W59 banking-pos: bankingChat",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const chat = await import("../../server/services/bankingChat");
    const { tenantId } = await seedUcTenant(world, "597", 5971);
    const admin = world.newPhone("597");
    await world.db.update(schema.tenants).set({ settings: { adminPhone: admin, agentBanking: { enabled: true } } as any })
      .where(eq(schema.tenants.id, tenantId));
    await world.db.insert(schema.merchantWallets).values({ tenantId, custodyMode: "psp", availableBalance: "1000.00" }).onConflictDoNothing();

    // Non-admin silently falls through on BOTH channels
    for (const channel of ["whatsapp", "telegram"] as const) {
      const out = await chat.handleBankingCommand({ db: world.db, tenantId, fromPhone: world.newPhone("597x"), text: "FLOAT", channel });
      assert(out.handled === false, `${channel}: non-admin falls through`);
    }

    for (const channel of ["whatsapp", "telegram"] as const) {
      const base = { db: world.db, tenantId, fromPhone: admin, channel };
      const accts = await chat.handleBankingCommand({ ...base, text: "BANK ACCOUNTS" });
      assert(accts.handled && accts.reply, `${channel}: BANK ACCOUNTS handled`);

      const fl = await chat.handleBankingCommand({ ...base, text: "FLOAT" });
      assert(fl.handled && fl.reply!.includes("Float"), `${channel}: FLOAT handled`);

      const start = await chat.handleBankingCommand({ ...base, text: "CASH IN 08031234567 100" });
      assert(start.handled && start.reply!.includes("CONFIRM CICO-"), `${channel}: CASH IN parks intent`);
      const ref = start.reply!.match(/CONFIRM (CICO-[A-Z0-9]+)/)![1];
      const done = await chat.handleBankingCommand({ ...base, text: `CONFIRM ${ref}` });
      assert(done.handled && done.reply!.includes("completed"), `${channel}: CONFIRM executes`);
      // replay of the same ref: intent consumed → notFound (never double-executes)
      const again = await chat.handleBankingCommand({ ...base, text: `CONFIRM ${ref}` });
      assert(again.handled && !again.reply!.includes("completed"), `${channel}: confirm replay does not re-execute`);

      const pos = await chat.handleBankingCommand({ ...base, text: "PAY BY POS 500" });
      assert(pos.handled && /code \*\d{6}\*/.test(pos.reply!), `${channel}: PAY BY POS returns a 6-digit code`);
    }
    // CICO actually landed (100.00 × 2 channels = 200.00 credited)
    const { customerBalanceCents } = await import("../../server/services/agentBanking");
    assert(await customerBalanceCents(world.db, tenantId, "08031234567") === 20_000, "both channel CICOs settled exactly once each");
  },
};
