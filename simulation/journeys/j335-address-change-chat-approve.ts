// === W43 dispatch (Coder C) ===
/**
 * J335 — Post-dispatch address change, happy path on WhatsApp (telegram
 * inbound feeds the same NLP engine): buyer "change my address …" → pending
 * row + merchant approval card (WA interactive buttons with the
 * addrchg:approve/reject:<id> grammar) → merchant taps APPROVE →
 * shippingAddress updated + audit row + customer notified.
 */
import { and, desc, eq } from "drizzle-orm";
import { assert, assertIncludes, bodyText, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { addStaffUser, seedDispatchOrder } from "./w43-dispatch-seed";

export const journey: Journey = {
  id: "J335",
  name: "address change chat request → merchant card approve",
  feature: "address_change_requests + WA approval card + apply + audit + notify",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const phone = world.newPhone("j335");
    await world.grantConsent(phone);
    const seed = await seedDispatchOrder(world, "j335", phone);

    const merchant = world.newPhone("j335m");
    await world.grantConsent(merchant);
    await addStaffUser(world, "j335", merchant);
    await world.patchTenantSettings({ adminPhone: merchant });

    // ── Buyer requests the change in chat ──
    await world.text(phone, "change my address to 12 Adeola Odeku St, Victoria Island, Lagos");
    const reply = bodyText(world.outbound.lastOfType("text", phone));
    assertIncludes(reply, "pending merchant approval", "buyer gets pending confirmation");
    assertIncludes(reply, seed.orderNumber, "reply references order");

    const [req] = await world.db.select().from(schema.addressChangeRequests)
      .where(and(
        eq(schema.addressChangeRequests.tenantId, TENANT_ID),
        eq(schema.addressChangeRequests.orderId, seed.orderId),
      ))
      .orderBy(desc(schema.addressChangeRequests.createdAt))
      .limit(1);
    assert(req, "address_change_requests row created");
    assert(req.status === "pending", `pending (got ${req.status})`);
    assert(req.requestedBy === "customer", "requested by customer");
    assert((req.newAddress as any).line1.includes("Adeola Odeku"), "new address captured");
    assert((req.oldAddress as any).line1 === "1 Old Road", "old address snapshotted");
    assert(req.feeCents === 0, "no fee by default");
    assert(req.expiresAt, "expiry stamped");

    // ── Merchant got the approval card (WA interactive buttons) ──
    await world.waitFor(() => {
      const card = world.outbound.lastOfType("interactive", merchant);
      return !!card;
    }, 10000, "merchant approval card sent");
    const card = world.outbound.lastOfType("interactive", merchant)!;
    const cardJson = JSON.stringify(card);
    assert(cardJson.includes(`addrchg:approve:${req.id}`), "card carries approve button id");
    assert(cardJson.includes(`addrchg:reject:${req.id}`), "card carries reject button id");

    // ── Second request while pending → conflict ──
    await world.text(phone, "change my address to 99 Other St, Lagos");
    const dup = bodyText(world.outbound.lastOfType("text", phone));
    assertIncludes(dup, "already a pending address change", "duplicate pending refused");

    // ── Merchant taps APPROVE on the card ──
    await world.buttonReply(merchant, `addrchg:approve:${req.id}`, "✅ Approve");
    const mReply = bodyText(world.outbound.lastOfType("text", merchant));
    assertIncludes(mReply, "applied", "merchant gets applied confirmation");

    const [decided] = await world.db.select().from(schema.addressChangeRequests)
      .where(eq(schema.addressChangeRequests.id, req.id));
    assert(decided.status === "applied", `applied (got ${decided.status})`);
    assert(decided.decidedAt, "decidedAt stamped");

    // ── Order address updated + audit row ──
    const [order] = await world.db.select().from(schema.orders).where(eq(schema.orders.id, seed.orderId));
    assertIncludes((order.shippingAddress as any).line1, "Adeola Odeku", "shippingAddress updated");

    const audits = await world.db.execute(
      `SELECT action, entity_id FROM audit_logs WHERE tenant_id = '${TENANT_ID}' AND entity_id = '${req.id}' ORDER BY created_at DESC LIMIT 1`,
    ) as any;
    const auditRows: any[] = Array.isArray(audits) ? audits : (audits?.rows ?? []);
    assert(auditRows.length > 0 && auditRows[0].action === "address_change.applied", `audit row written (got ${JSON.stringify(auditRows[0] ?? null)})`);

    // ── Customer notified of the terminal state ──
    await world.waitFor(() => {
      const t = world.outbound.lastOfType("text", phone);
      return !!t && bodyText(t).includes("updated to");
    }, 10000, "customer applied notification");
    const notif = bodyText(world.outbound.lastOfType("text", phone));
    assertIncludes(notif, "Adeola Odeku", "notification shows the new address");

    // ── Double decision refused (state machine) ──
    await world.buttonReply(merchant, `addrchg:reject:${req.id}`, "❌ Reject");
    const again = bodyText(world.outbound.lastOfType("text", merchant));
    assertIncludes(again, "Could not", "second decision refused");
  },
};
