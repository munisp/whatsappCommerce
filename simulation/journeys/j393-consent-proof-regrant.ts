// === W46 privacy-consent (Coder B) ===
/**
 * J393 — TEN-16 proof-of-consent versioning + re-grant abuse guard:
 *   - A grant stamps policyVersion + proofTemplate + proofWamid evidence.
 *   - A re-grant after withdrawal is counted + journaled (regrantCount,
 *     lastRegrantAt) and clears the withdrawal.
 *   - More than MAX_REGRANTS_PER_DAY re-grants within 24h is REFUSED
 *     (ConsentRegrantRateLimited) — the withdrawal stands; silent re-grant
 *     abuse is impossible.
 */
import { eq, and } from "drizzle-orm";
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J393",
  name: "proof-of-consent versioning + re-grant rate limit",
  feature: "TEN-16 consent evidence + regrant guard",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const consent = await import("../../server/services/consent");
    const phone = world.newPhone("j393");
    const load = async () => {
      const [row] = await world.db.select().from(schema.consents)
        .where(and(
          eq(schema.consents.tenantId, TENANT_ID),
          eq(schema.consents.phone, phone),
          eq(schema.consents.channel, "whatsapp"),
        )).limit(1);
      return row;
    };

    // 1. Initial grant carries proof-of-consent versioning.
    await consent.recordConsent(world.db, {
      tenantId: TENANT_ID,
      phone,
      granted: true,
      proofWamid: "wamid.j393.grant.1",
    });
    let row = await load();
    assert(row?.granted === true, "grant persisted");
    assert(row.policyVersion === consent.CONSENT_POLICY_VERSION, "policy version stamped");
    assert(row.proofTemplate === consent.CONSENT_PROOF_TEMPLATE, "proof template stamped");
    assert(row.proofWamid === "wamid.j393.grant.1", "wamid evidence stamped");
    assert(Number(row.regrantCount) === 0, "no regrant count on a first grant");

    // 2. Withdraw → re-grant cycles are counted; each re-grant re-stamps
    //    evidence and clears the withdrawal.
    for (let i = 1; i <= consent.MAX_REGRANTS_PER_DAY; i++) {
      await consent.recordChannelRevocation(world.db, { tenantId: TENANT_ID, sessionKey: phone, channel: "whatsapp" });
      row = await load();
      assert(row?.granted === false && row?.withdrawnAt, `withdrawal ${i} persisted`);
      await consent.recordConsent(world.db, {
        tenantId: TENANT_ID,
        phone,
        granted: true,
        proofWamid: `wamid.j393.regrant.${i}`,
      });
      row = await load();
      assert(row?.granted === true && !row?.withdrawnAt, `re-grant ${i} restores consent`);
      assert(Number(row?.regrantCount) === i, `regrantCount=${i} (got ${row?.regrantCount})`);
      assert(row?.proofWamid === `wamid.j393.regrant.${i}`, `re-grant ${i} re-stamps wamid evidence`);
      assert(!!row?.lastRegrantAt, `re-grant ${i} journaled (lastRegrantAt)`);
    }

    // 3. The (MAX+1)-th re-grant inside the window is refused — withdrawal stands.
    await consent.recordChannelRevocation(world.db, { tenantId: TENANT_ID, sessionKey: phone, channel: "whatsapp" });
    let limited = false;
    try {
      await consent.recordConsent(world.db, { tenantId: TENANT_ID, phone, granted: true });
    } catch (e: any) {
      limited = e?.name === "ConsentRegrantRateLimited";
    }
    assert(limited, "re-grant flood rate-limited");
    row = await load();
    assert(row?.granted === false && !!row?.withdrawnAt, "rate-limited re-grant keeps the withdrawal standing");

    // 4. Wiring contract: the chat re-opt-in path surfaces the rate-limit
    //    reply instead of crashing the flow.
    const { readFile } = await import("node:fs/promises");
    const useCases = await readFile(new URL("../../server/services/useCases.ts", import.meta.url), "utf8");
    assert(useCases.includes("ConsentRegrantRateLimited"), "useCases handles the re-grant rate limit");
  },
};
