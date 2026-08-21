/**
 * J149 — Group buying EXPIRY path: a deal misses its threshold by the
 * deadline → the sweep expires it and every held participant is refunded
 * (captured paymentRef holds) or voided (authorization-only holds), via the
 * existing refund semantics. The sweep is idempotent; late joins after the
 * deadline are refused without taking payment.
 */
import { eq } from "drizzle-orm";
import { TENANT_ID, assert, assertIncludes, bodyText, type World } from "../world";
import type { Journey } from "../runner";
import { publicCaller } from "./helpers";

export const journey: Journey = {
  id: "J149",
  name: "group deal expiry → refunds/voids",
  feature: "groupBuy sweep: expire + refund/void, idempotent",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { createGroupDealTx, joinGroupDealTx, sweepGroupDealsTx, getGroupDealProgressTx } =
      await import("../../server/services/groupBuy");

    const deal = await createGroupDealTx(world.db, {
      tenantId: TENANT_ID,
      title: "Sugar 50kg — group price",
      unitPriceCents: 4_500_000, // ₦45,000.00
      thresholdQty: 50,
      deadline: new Date(Date.now() + 3600_000),
    });

    // ── 1. Two participants hold: one captured (paymentRef), one auth-only ─
    const payer = world.newPhone("gp");
    const authee = world.newPhone("gq");
    const j1 = await joinGroupDealTx(world.db, {
      dealId: deal.id, customerPhone: payer, quantity: 5, paymentRef: `pay_${deal.id.slice(0, 8)}_1`,
    });
    const j2 = await joinGroupDealTx(world.db, {
      dealId: deal.id, customerPhone: authee, quantity: 3,
    });
    assert(j1.ok && j2.ok, "both joins held");
    assert(j1.ok && j1.participant.status === "held", "captured hold recorded");
    const mid = await getGroupDealProgressTx(world.db, deal.id);
    assert(mid!.currentQty === 8 && mid!.percent === 16, `progress pre-expiry (got ${mid!.currentQty})`);

    // ── 2. Deadline passes with 8/50 → sweep expires the deal ────────────
    await world.db
      .update(schema.groupDeals)
      .set({ deadline: new Date(Date.now() - 60_000) })
      .where(eq(schema.groupDeals.id, deal.id));

    const sweep1 = await sweepGroupDealsTx(world.db);
    assert(sweep1.expired === 1, `sweep expired the deal (got ${sweep1.expired})`);
    assert(sweep1.refunded === 1, `captured hold refunded (got ${sweep1.refunded})`);
    assert(sweep1.voided === 1, `auth-only hold voided (got ${sweep1.voided})`);

    const [fresh] = await world.db.select().from(schema.groupDeals).where(eq(schema.groupDeals.id, deal.id)).limit(1);
    assert(fresh.status === "expired", `deal expired (got ${fresh.status})`);

    const participants = await world.db
      .select()
      .from(schema.groupDealParticipants)
      .where(eq(schema.groupDealParticipants.dealId, deal.id));
    const byPhone = new Map(participants.map((p) => [p.customerPhone, p.status]));
    assert(byPhone.get(payer) === "refunded", `payer refunded (got ${byPhone.get(payer)})`);
    assert(byPhone.get(authee) === "voided", `auth-only participant voided (got ${byPhone.get(authee)})`);

    // ── 3. Idempotence: a second sweep changes nothing ───────────────────
    const sweep2 = await sweepGroupDealsTx(world.db);
    assert(
      sweep2.expired === 0 && sweep2.refunded === 0 && sweep2.voided === 0,
      `second sweep is a no-op (got ${JSON.stringify(sweep2)})`,
    );

    // ── 4. Late join after expiry is refused, no payment taken ───────────
    const late = world.newPhone("gl");
    const jr = await joinGroupDealTx(world.db, { dealId: deal.id, customerPhone: late, quantity: 2 });
    assert(!jr.ok && jr.reason === "deal_not_open", "late join refused");

    // ── 5. WhatsApp surface: progress for an expired deal says refunded ──
    await world.grantConsent(payer);
    await world.text(payer, `deal ${deal.id.slice(0, 8)}`);
    const reply = bodyText(world.outbound.lastOfType("text", payer));
    assertIncludes(reply, "refunded/voided", "expiry notice over WhatsApp");

    // Participant-scoped public view still works and is minimal.
    const pub = await publicCaller();
    const mine = await pub.groupBuy.myParticipation({ dealId: deal.id, customerPhone: payer });
    assert(mine.status === "refunded", "public participation view shows refund");
  },
};
