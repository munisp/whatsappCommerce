/**
 * J150 — Stokvel circle full cycle with deterministic rotating payout.
 * 3 members × weekly 50,000 cents: each cycle every member contributes via
 * the real WhatsApp keyword flow ("stokvel contribute <id>"), the pooled
 * 150,000 cents pays out to the next member in rotation order, and after 3
 * cycles every member has received exactly one payout and the circle
 * completes. Conservation (Σpayouts == Σcontributions) and the append-only
 * audit trail are asserted end to end.
 */
import { and, eq } from "drizzle-orm";
import { TENANT_ID, assert, bodyText, type World } from "../world";
import type { Journey } from "../runner";
import { adminCaller } from "./helpers";

export const journey: Journey = {
  id: "J150",
  name: "stokvel circle full rotation",
  feature: "group savings circle → rotating payout → completion + audit trail",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const phones = [world.newPhone("s1"), world.newPhone("s2"), world.newPhone("s3")];
    for (const p of phones) await world.grantConsent(p);

    const admin = await adminCaller();
    const { circle, members } = await admin.stokvel.createCircle({
      tenantId: TENANT_ID,
      name: "Sim Esusu Circle",
      contributionAmountCents: 50_000,
      frequency: "weekly",
      members: phones.map((p, i) => ({ phone: p, name: `Member ${i + 1}` })),
      createdByPhone: phones[0],
    });
    assert(circle.status === "active", "circle starts active");
    assert(members.length === 3, "three members enrolled");
    assert(members.every((m: any, i: number) => m.rotationPosition === i), "rotation order = join order");

    const prefix = circle.id.slice(0, 8);
    const payouts: any[] = [];
    for (let cycle = 1; cycle <= 3; cycle++) {
      for (const p of phones) {
        await world.text(p, `stokvel contribute ${prefix}`);
        const reply = bodyText(world.outbound.lastOfType("text", p));
        assert(reply.includes("Contribution") || reply.includes("already recorded"), `contribution ack for ${p} (got: ${reply})`);
      }
      const [payout] = await world.db.select().from(schema.stokvelPayouts)
        .where(and(eq(schema.stokvelPayouts.circleId, circle.id), eq(schema.stokvelPayouts.cycle, cycle)));
      assert(payout, `cycle ${cycle} payout recorded`);
      assert(payout.amountCents === 150_000, `cycle ${cycle} pool = 3 × 50,000 (got ${payout.amountCents})`);
      assert(payout.status === "paid", `cycle ${cycle} payout paid`);
      // Deterministic rotation: cycle N pays member at rotationPosition N-1.
      const expected = members.find((m: any) => m.rotationPosition === cycle - 1);
      assert(payout.memberId === expected.id, `cycle ${cycle} pays rotation position ${cycle - 1}`);
      assert(payout.phone === expected.phone, `cycle ${cycle} pays ${expected.phone}`);
      payouts.push(payout);
    }

    // Circle completes after every member received exactly one payout.
    const [final] = await world.db.select().from(schema.stokvelCircles)
      .where(eq(schema.stokvelCircles.id, circle.id));
    assert(final.status === "completed", `circle completed (got ${final.status})`);
    assert(final.currentCycle === 4, "cycle counter advanced past the rotation");
    assert(final.rotationIndex === 3, "rotation index advanced deterministically");

    // Conservation: Σ payouts == Σ paid contributions, integer cents.
    const contribs = await world.db.select().from(schema.stokvelContributions)
      .where(eq(schema.stokvelContributions.circleId, circle.id));
    const paid = contribs.filter((c: any) => c.status === "paid");
    assert(paid.length === 9, `9 paid contributions (got ${paid.length})`);
    const sumIn = paid.reduce((s: number, c: any) => s + c.amountCents, 0);
    const sumOut = payouts.reduce((s, p) => s + p.amountCents, 0);
    assert(sumIn === sumOut && sumOut === 450_000, `conservation: ${sumIn} in == ${sumOut} out`);

    // Audit trail: creation + 9 contributions + 3 payouts + completion.
    const events = await world.db.select().from(schema.stokvelEvents)
      .where(eq(schema.stokvelEvents.circleId, circle.id));
    const kinds = events.map((e: any) => e.kind);
    assert(kinds.includes("circle_created"), "audit: circle_created");
    assert(kinds.filter((k: string) => k === "contribution_paid").length === 9, "audit: 9 contribution_paid");
    assert(kinds.filter((k: string) => k === "payout_paid").length === 3, "audit: 3 payout_paid");
    assert(kinds.includes("circle_completed"), "audit: circle_completed");

    // Contributing to a completed circle is rejected.
    await world.text(phones[0], `stokvel contribute ${prefix}`);
    const late = bodyText(world.outbound.lastOfType("text", phones[0]));
    assert(late.includes("⚠️") && late.includes("completed"), `completed circle rejects contributions (got: ${late})`);

    // Public member statement via HMAC token; tampered token rejected.
    const { token } = await admin.stokvel.memberToken({ tenantId: TENANT_ID, memberId: members[0].id });
    const { publicCaller } = await import("./helpers");
    const anon = await publicCaller();
    const view = await anon.stokvel.memberStatement({ token });
    assert(view.circleName === "Sim Esusu Circle", "member statement returns the circle");
    assert(view.payouts.length === 3, "member statement lists payouts");
    const { expectTrpcError } = await import("./helpers");
    await expectTrpcError(anon.stokvel.memberStatement({ token: `${token}x` }), "NOT_FOUND", "tampered member token rejected");
  },
};
