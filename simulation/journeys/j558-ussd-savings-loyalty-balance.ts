// === W54 capabilities (CAP-2) ===
/**
 * J558 — USSD depth: "savings" reads the caller's stokvel circles
 * (contribution, cycle, NEXT PAYOUT info via the real rotation math) and
 * "loyalty" reads the ledger points balance — both READ-ONLY, END-terminated,
 * over the real Africa's Talking gateway (useCases.handleUssdRequest).
 * Unknown members get the honest empty state.
 */
import { TENANT_ID, assert, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J558",
  name: "USSD savings balance (+next payout) and loyalty balance, read-only",
  feature: "W54 capabilities: USSD depth (savings + loyalty)",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const phone = world.newPhone("551");
    const other = world.newPhone("551x");

    // ── Seed: a stokvel circle with the caller + one other member ────────
    const stokvel = await import("../../server/services/stokvel");
    await stokvel.createCircle(world.db as any, {
      tenantId: TENANT_ID,
      name: "J558 Esusu",
      contributionAmountCents: 50_000, // ₦500
      frequency: "weekly",
      members: [{ phone }, { phone: other }],
      createdByPhone: phone,
    });

    // ── Seed: loyalty points for the caller ──────────────────────────────
    const { awardPoints } = await import("../../server/services/loyalty");
    await awardPoints({ tenantId: TENANT_ID, customerPhone: phone, points: 42, reason: "J558 seed" }, world.db as any);

    // ── 1. USSD "savings" → circle + next payout info (END) ─────────────
    const sid = `w54-j551-${Date.now()}`;
    await world.ussd(sid, phone, "");
    const savings = await world.ussd(sid, phone, "savings");
    assert(savings.startsWith("END"), `savings is END-terminated (got ${savings.slice(0, 80)})`);
    assert(savings.includes("J558 Esusu"), `circle named (got ${savings.slice(0, 240)})`);
    assert(savings.includes("500.00") && /cycle 1/i.test(savings), `amount + cycle (got ${savings.slice(0, 240)})`);
    assert(/Next payout:/i.test(savings), `next payout info present (got ${savings.slice(0, 240)})`);
    // The caller is a member: the next-payout label is either themselves
    // (YOU) or the other member's phone — never empty.
    assert(/Next payout: (YOU|\d+)/i.test(savings), `next payout resolved (got ${savings.slice(0, 240)})`);

    // stokvel alias works too.
    const savings2 = await world.ussd(`w54-j551b-${Date.now()}`, phone, "stokvel");
    assert(savings2.includes("J558 Esusu"), "stokvel alias renders the same circle");

    // ── 2. USSD "loyalty" → points balance (END) ─────────────────────────
    const loyalty = await world.ussd(`w54-j551c-${Date.now()}`, phone, "loyalty");
    assert(loyalty.startsWith("END") && loyalty.includes("42"), `loyalty balance (got ${loyalty.slice(0, 160)})`);
    const points = await world.ussd(`w54-j551d-${Date.now()}`, phone, "points");
    assert(points.includes("42"), "points alias renders the same balance");

    // ── 3. Empty states are honest ───────────────────────────────────────
    const stranger = world.newPhone("551s");
    const none = await world.ussd(`w54-j551e-${Date.now()}`, stranger, "savings");
    assert(none.startsWith("END") && /not in any savings circle/i.test(none),
      `empty savings state (got ${none.slice(0, 160)})`);
    const zero = await world.ussd(`w54-j551f-${Date.now()}`, stranger, "loyalty");
    assert(zero.startsWith("END") && zero.includes("0"), `zero loyalty balance (got ${zero.slice(0, 160)})`);
  },
};
// === END W54 capabilities ===
