/**
 * === W41 rma-fx (Coder C) ===
 * J301 — Buyer initiates a return with the WhatsApp "RETURN ..." command;
 * merchant approves/rejects with the WA "RMA APPROVE/REJECT <id>" command.
 * (Telegram inbound feeds the same NLP engine, so both channels are covered.)
 */
import { and, desc, eq } from "drizzle-orm";
import { TENANT_ID, assert, assertIncludes, bodyText, type World } from "../world";
import type { Journey } from "../runner";
import { seedRmaOrder } from "./w41-rma-seed";

export const journey: Journey = {
  id: "J301",
  name: "RMA via WA commands (buyer + merchant)",
  feature: "RETURN intake + RMA APPROVE/REJECT merchant command",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const phone = world.newPhone("j301");
    await world.grantConsent(phone);
    const seed = await seedRmaOrder(world, "j301", phone);

    // ── Buyer: "return arrived damaged" → requested + confirmation reply ──
    await world.text(phone, "return arrived damaged");
    const reply = bodyText(world.outbound.lastOfType("text", phone));
    assertIncludes(reply, "return request", "buyer gets return confirmation");
    assertIncludes(reply, seed.orderNumber, "reply references the order number");

    const [rma] = await world.db.select().from(schema.rmaRequests)
      .where(and(eq(schema.rmaRequests.tenantId, TENANT_ID), eq(schema.rmaRequests.orderId, seed.orderId)))
      .orderBy(desc(schema.rmaRequests.createdAt)).limit(1);
    assert(rma, "rma_requests row created");
    assert(rma.status === "requested", `requested (got ${rma.status})`);
    assert(rma.requestedVia === "whatsapp", "requested via whatsapp");
    assertIncludes(rma.reason, "damaged", "reason captured");

    // ── Non-staff sender cannot decide ──
    await world.text(phone, `RMA APPROVE ${rma.id}`);
    const denied = bodyText(world.outbound.lastOfType("text", phone));
    assertIncludes(denied, "staff", "non-staff decision refused");

    // ── Merchant: RMA APPROVE <id> ──
    const merchant = world.newPhone("j301m");
    await world.grantConsent(merchant);
    await world.db.insert(schema.users).values({
      openId: `sim-merchant-j301-${merchant}`,
      name: "Sim Merchant J301",
      phone: merchant,
      tenantId: TENANT_ID,
      lastSignedIn: new Date(),
    }).onConflictDoNothing();

    await world.text(merchant, `RMA APPROVE ${rma.id}`);
    const mReply = bodyText(world.outbound.lastOfType("text", merchant));
    assertIncludes(mReply, "approved", "merchant gets decision confirmation");

    const [decided] = await world.db.select().from(schema.rmaRequests)
      .where(eq(schema.rmaRequests.id, rma.id));
    assert(decided.status === "approved", `approved (got ${decided.status})`);
    assert(decided.decidedAt, "decidedAt stamped");

    // Buyer was notified on the status change.
    const buyerNotif = bodyText(world.outbound.lastOfType("text", phone));
    assertIncludes(buyerNotif, "approved", "buyer notified of approval");

    // Double decision is refused (guarded state machine).
    await world.text(merchant, `RMA REJECT ${rma.id} changed my mind`);
    const again = bodyText(world.outbound.lastOfType("text", merchant));
    assertIncludes(again, "Could not", "second decision refused");
  },
};
