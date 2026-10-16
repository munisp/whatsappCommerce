// === W54 disputes ===
/**
 * J549 — DISP-4: Telegram dispute intake. A TG buyer's complaint message
 * routes through the SAME NLP engine (deterministic dispute shortcut — no LLM
 * dependency) into the shared raiseChatDispute service: the escrow is frozen,
 * an escrow_disputes row is created, and the TG buyer gets the confirmation
 * reply on Telegram. TG callback gating rules are untouched (engine dispatch
 * still only swallows menu/PO/order ids).
 */
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { TENANT_ID, assert, type World } from "../world";
import type { Journey } from "../runner";
import { ensureTelegramConfig, tgPost, tgTextUpdate, TG_SECRET } from "./j235-telegram-webhook-security";

export const journey: Journey = {
  id: "J549",
  name: "DISP-4: TG complaint intake creates a dispute + freezes escrow",
  feature: "W54 telegram dispute intake via shared raiseChatDispute",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { tg } = await import("../metaMock");
    const { recordConsent } = await import("../../server/services/consent");
    await ensureTelegramConfig(world);

    const chatId = "880549";
    await recordConsent(world.db, { tenantId: TENANT_ID, phone: `telegram:${chatId}`, channel: "telegram", granted: true });

    // Seed: the TG buyer's paid order + active escrow (mirrors a TG purchase).
    const orderId = `ord-j549-${randomUUID().slice(0, 8)}`;
    await world.db.insert(schema.orders).values({
      id: orderId, tenantId: TENANT_ID, customerId: `telegram:${chatId}`,
      orderNumber: `J549-${orderId.slice(-4)}`, status: "confirmed",
      totalAmount: "5000.00", currency: "NGN", paymentStatus: "completed", metadata: {},
    });
    const escrowId = randomUUID();
    await world.db.insert(schema.escrowTransactions).values({
      id: escrowId, tenantId: TENANT_ID, orderId, customerId: `telegram:${chatId}`,
      amount: "5000.00", currency: "NGN", state: "escrow_held",
    });

    const base = tg.callsFor("sendMessage").length;
    const res = await tgPost(world, TENANT_ID, TG_SECRET, tgTextUpdate(970549, chatId, 770549, "my order never arrived, I want to dispute"));
    assert(res.status === 200, `TG webhook acked (got ${res.status})`);
    await world.waitFor(() => tg.callsFor("sendMessage").length > base, 12000, "TG dispute confirmation reply");
    const reply = String(tg.callsFor("sendMessage").at(-1)!.body?.text ?? "");
    assert(reply.includes("dispute"), `TG reply confirms the dispute (got ${reply.slice(0, 200)})`);

    const disputes = await world.db.select().from(schema.escrowDisputes)
      .where(eq(schema.escrowDisputes.orderId, orderId));
    assert(disputes.length === 1, `dispute row created from TG intake (got ${disputes.length})`);
    assert(disputes[0].status === "open" && disputes[0].reason === "not_received",
      `dispute open with classified reason (got ${disputes[0].status}/${disputes[0].reason})`);
    const [e] = await world.db.select().from(schema.escrowTransactions)
      .where(eq(schema.escrowTransactions.id, escrowId));
    assert(e.state === "dispute_raised", `escrow frozen by TG intake (got ${e.state})`);
  },
};
