// === W44 deposits-subs-digital (Coder C) ===
/**
 * J348 — Appointment cancel window + no-show:
 *  - Cancel OUTSIDE tenants.appointmentCancelWindowHours (default 24h) →
 *    deposit REFUNDED via the W38 provider-refund path (audit
 *    appointment.deposit_refunded).
 *  - Cancel INSIDE the window → deposit FORFEITED (no refund call; audit
 *    appointment.deposit_forfeited) — customer told honestly.
 *  - Merchant "APPT NOSHOW <id8>" → status no_show, deposit kept, audit.
 *  - Tenant window override (settings patch via migration column) honored.
 */
import { desc, eq } from "drizzle-orm";
import { assert, assertIncludes, bodyText, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { seedServiceProduct } from "./w44-seed";
import { paystackChargeSuccess } from "./helpers";
import { addStaffUser } from "./w43-dispatch-seed";

async function bookAndPay(world: World, phone: string, svc: { productId: string; name: string }, startsInHours: number) {
  const { bookAppointment } = await import("../../server/services/appointments");
  const r = await bookAppointment(world.db, {
    tenantId: TENANT_ID,
    customerRef: phone,
    serviceProductId: svc.productId,
    startsAt: new Date(Date.now() + startsInHours * 3600_000),
    channel: "whatsapp",
  });
  const dep = await paystackChargeSuccess(world, { reference: `appt-deposit:${r.appt.id}`, amountMajor: r.depositCents / 100 });
  assert(dep.status === 200, "deposit webhook accepted");
  const schema = await import("../../drizzle/schema");
  const [a] = await world.db.select().from(schema.serviceAppointments).where(eq(schema.serviceAppointments.id, r.appt.id));
  assert(a.status === "confirmed" && a.depositStatus === "paid", "deposit paid");
  return a;
}

export const journey: Journey = {
  id: "J348",
  name: "appointment cancel refund vs forfeit + no-show",
  feature: "cancel window policy + provider refund + audit + no-show",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const svc = await seedServiceProduct(world, "j348");

    // ── Cancel OUTSIDE the window → refund ──
    const phoneA = world.newPhone("j348a");
    await world.grantConsent(phoneA);
    const apptA = await bookAndPay(world, phoneA, svc, 72); // 72h > 24h window

    await world.text(phoneA, `cancel appointment ${apptA.id.slice(0, 8)}`);
    const replyA = bodyText(world.outbound.lastOfType("text", phoneA));
    assertIncludes(replyA, "cancelled", "cancel acknowledged");
    assertIncludes(replyA, "refund", "refund disclosed");

    const [aRow] = await world.db.select().from(schema.serviceAppointments).where(eq(schema.serviceAppointments.id, apptA.id));
    assert(aRow.status === "cancelled", `cancelled (got ${aRow.status})`);
    assert(aRow.depositStatus === "refunded", `deposit refunded (got ${aRow.depositStatus})`);

    const auditA: any[] = (await world.db.execute(
      `SELECT action FROM audit_logs WHERE tenant_id = '${TENANT_ID}' AND entity_id = '${apptA.id}' ORDER BY created_at DESC`,
    )) as any;
    const actionsA = (Array.isArray(auditA) ? auditA : (auditA as any)?.rows ?? []).map((r: any) => r.action);
    assert(actionsA.includes("appointment.deposit_refunded"), `refund audit row (got ${JSON.stringify(actionsA)})`);

    // Cancel again → state machine refuses (no active appointment matches).
    await world.text(phoneA, `cancel appointment ${apptA.id.slice(0, 8)}`);
    const again = bodyText(world.outbound.lastOfType("text", phoneA));
    assert(/couldn't find an active appointment|Could not cancel/i.test(again), `second cancel refused (got "${again}")`);

    // ── Cancel INSIDE the window → forfeit (NO refund call) ──
    const phoneB = world.newPhone("j348b");
    await world.grantConsent(phoneB);
    const apptB = await bookAndPay(world, phoneB, svc, 3); // 3h < 24h window
    const refundsBefore: any[] = (await world.db.execute(
      `SELECT count(*)::int AS n FROM refund_attempts WHERE tenant_id = '${TENANT_ID}'`,
    )) as any;

    await world.text(phoneB, `cancel appointment ${apptB.id.slice(0, 8)}`);
    const replyB = bodyText(world.outbound.lastOfType("text", phoneB));
    assertIncludes(replyB, "forfeited", "forfeit disclosed honestly");

    const [bRow] = await world.db.select().from(schema.serviceAppointments).where(eq(schema.serviceAppointments.id, apptB.id));
    assert(bRow.status === "cancelled", "B cancelled");
    assert(bRow.depositStatus === "forfeited", `deposit forfeited (got ${bRow.depositStatus})`);

    const auditB: any[] = (await world.db.execute(
      `SELECT action FROM audit_logs WHERE tenant_id = '${TENANT_ID}' AND entity_id = '${apptB.id}'`,
    )) as any;
    const actionsB = (Array.isArray(auditB) ? auditB : (auditB as any)?.rows ?? []).map((r: any) => r.action);
    assert(actionsB.includes("appointment.deposit_forfeited"), "forfeit audit row");
    const refundsAfter: any[] = (await world.db.execute(
      `SELECT count(*)::int AS n FROM refund_attempts WHERE tenant_id = '${TENANT_ID}'`,
    )) as any;
    const nBefore = Number((Array.isArray(refundsBefore) ? refundsBefore : [])[0]?.n ?? 0);
    const nAfter = Number((Array.isArray(refundsAfter) ? refundsAfter : [])[0]?.n ?? 0);
    assert(nAfter === nBefore, `forfeit path makes NO provider refund call (${nBefore} → ${nAfter})`);

    // ── No-show: deposit kept ──
    const merchant = world.newPhone("j348m");
    await world.grantConsent(merchant);
    await addStaffUser(world, "j348", merchant);
    const phoneC = world.newPhone("j348c");
    await world.grantConsent(phoneC);
    const apptC = await bookAndPay(world, phoneC, svc, 30);

    await world.text(merchant, `APPT NOSHOW ${apptC.id.slice(0, 8)}`);
    const mReply = bodyText(world.outbound.lastOfType("text", merchant));
    assertIncludes(mReply, "no-show", "merchant no-show ack");
    const [cRow] = await world.db.select().from(schema.serviceAppointments).where(eq(schema.serviceAppointments.id, apptC.id));
    assert(cRow.status === "no_show", `no_show (got ${cRow.status})`);
    assert(cRow.depositStatus === "paid", "no-show keeps the deposit");
    const auditC: any[] = (await world.db.execute(
      `SELECT action FROM audit_logs WHERE tenant_id = '${TENANT_ID}' AND entity_id = '${apptC.id}'`,
    )) as any;
    const actionsC = (Array.isArray(auditC) ? auditC : (auditC as any)?.rows ?? []).map((r: any) => r.action);
    assert(actionsC.includes("appointment.no_show"), "no-show audit row");
    await world.waitFor(() => {
      const t = world.outbound.lastOfType("text", phoneC);
      return !!t && bodyText(t).includes("missed your appointment");
    }, 10000, "customer no-show notice");

    // ── Tenant window override honored (4h window: +5h cancel → refund) ──
    await world.db.execute(`UPDATE tenants SET "appointmentCancelWindowHours" = 4 WHERE id = '${TENANT_ID}'`);
    const phoneD = world.newPhone("j348d");
    await world.grantConsent(phoneD);
    const apptD = await bookAndPay(world, phoneD, svc, 5); // 5h > 4h override
    await world.text(phoneD, `cancel appointment ${apptD.id.slice(0, 8)}`);
    const [dRow] = await world.db.select().from(schema.serviceAppointments).where(eq(schema.serviceAppointments.id, apptD.id));
    assert(dRow.depositStatus === "refunded", `4h override → refund (got ${dRow.depositStatus})`);
    await world.db.execute(`UPDATE tenants SET "appointmentCancelWindowHours" = 24 WHERE id = '${TENANT_ID}'`);

    // Non-staff cannot run merchant commands.
    await world.text(phoneA, `APPT NOSHOW ${apptC.id.slice(0, 8)}`);
    const denied = bodyText(world.outbound.lastOfType("text", phoneA));
    assertIncludes(denied, "only store staff", "staff gate on APPT commands");
    void desc;
  },
};
