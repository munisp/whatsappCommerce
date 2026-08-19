/**
 * J116 — C3 stakeholder journey: customer support conversation → the bot
 * handles the first message → the customer asks for a human via the REAL
 * WhatsApp handoff use case (menu "Talk to a human") → the conversation is
 * flagged + the admin is notified → a human agent claims it (W23 escalation
 * router) → the agent replies in-thread → resolution.
 *
 * Conversation state transitions exercised end-to-end:
 *   open (aiHandled=true, bot) → pending (handoff flag, escalatedAt) →
 *   human_active (agent assigned) → resolved (resolvedAt).
 *
 * Gap fixed this wave: server/routers/escalation.ts — a minimal, fully
 * tenant-guarded escalation router reusing the existing conversations /
 * customers tables (openConversation / escalate / resolve / get).
 */
import { eq } from "drizzle-orm";
import { ADMIN_PHONE, assert, assertIncludes, bodyText, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { expectTrpcError, tenantCaller } from "./helpers";

export const journey: Journey = {
  id: "J116",
  name: "support conversation → bot → human escalation → resolution",
  feature: "C3 escalation lifecycle end-to-end",
  async run(world) {
    const schema = await import("../../drizzle/schema");
    const phone = world.newPhone("c3");
    await world.grantConsent(phone);
    const agent = await tenantCaller(TENANT_ID, { userId: 3116 });
    const intruder = await tenantCaller(
      (await (await import("./helpers")).adminCaller()).onboarding.start({ name: "J116 Intruder" }).then((r) => r.tenantId),
      { userId: 3117 },
    );

    // ── 1. Bot handles the customer's first message ──────────────────────
    world.llm.when("j116 where is my order", {
      reply: "Your order is being prepared — it usually ships within 24h. Anything else I can help with?",
      intent: "faq",
      nextState: "browse",
      extractedItems: [],
      extractedProduct: null,
      extractedQuantity: null,
      extractedAddress: null,
      confidence: 0.92,
    });
    await world.text(phone, "j116 where is my order");
    const botReply = bodyText(world.outbound.lastOfType("text", phone));
    assertIncludes(botReply, "being prepared", "bot handled the first message");

    // The inbox opens a conversation for the thread — bot owns it.
    const opened = await agent.escalation.openConversation({ tenantId: TENANT_ID, customerPhone: phone, customerName: "C3 Customer" });
    assert(opened.created === true, "conversation row created");
    const convId = opened.conversation.id;
    assert(opened.conversation.status === "open" && opened.conversation.aiHandled === true,
      `bot owns the new conversation (got ${opened.conversation.status}, aiHandled=${opened.conversation.aiHandled})`);

    // ── 2. Customer escalates via the real "Talk to a human" handoff ─────
    await world.text(phone, "menu");
    assert(world.outbound.lastOfType("interactive", phone), "menu rendered");
    await world.text(phone, "3"); // default menu: 1 shop, 2 track, 3 handoff
    const handoffReply = bodyText(world.outbound.lastOfType("text", phone));
    assertIncludes(handoffReply, "human agent", "handoff reply promises a human");

    const [flagged] = await world.db.select().from(schema.conversations).where(eq(schema.conversations.id, convId)).limit(1);
    assert(flagged.status === "pending", `handoff flags the conversation pending (got ${flagged.status})`);
    assert(flagged.aiHandled === false, "bot marked as no longer handling");
    assert(flagged.escalatedAt, "escalatedAt stamped by the handoff");
    assert((flagged.metadata as any)?.handoffRequested === true, "handoff metadata recorded");
    const adminNotice = world.outbound.findByBody("Human handoff requested", ADMIN_PHONE).pop();
    assert(adminNotice, "tenant admin notified of the handoff");

    // ── 3. Human agent claims the conversation (W23 escalation router) ───
    await expectTrpcError(
      intruder.escalation.escalate({ conversationId: convId }),
      "FORBIDDEN", "cross-tenant escalation rejected",
    );
    const claimed = await agent.escalation.escalate({ conversationId: convId, note: "taking over" });
    assert(claimed.status === "human_active", `agent claim → human_active (got ${claimed.status})`);
    assert(claimed.assignedAgentId === "3116", "calling agent assigned");
    assert(claimed.escalatedAt, "escalatedAt preserved from the handoff");

    // ── 4. Agent replies in-thread via the tenant channel ────────────────
    await expectTrpcError(
      intruder.escalation.reply({ conversationId: convId, body: "intruder reply" }),
      "FORBIDDEN", "cross-tenant reply rejected",
    );
    const sent = await agent.escalation.reply({ conversationId: convId, body: "Hi! I've located your order — it ships today. 📦" });
    assert(sent.sent === true, `agent reply sent (got ${JSON.stringify(sent)})`);
    const delivered = world.outbound.findByBody("ships today", phone).pop();
    assert(delivered, "agent reply delivered over the tenant WhatsApp channel");
    const thread = await agent.conversation.getMessages({ tenantId: TENANT_ID, customerPhone: phone });
    assert(thread.some((m: any) => m.direction === "outbound" && /ships today/.test(m.body ?? "")),
      "agent reply persisted in the thread");

    // ── 5. Resolution → terminal state ────────────────────────────────────
    await expectTrpcError(
      intruder.escalation.resolve({ conversationId: convId }),
      "FORBIDDEN", "cross-tenant resolve rejected",
    );
    const resolved = await agent.escalation.resolve({ conversationId: convId });
    assert(resolved.status === "resolved" && resolved.resolvedAt, "conversation resolved with resolvedAt");

    // Idempotent resolve + no escalation of a resolved conversation.
    const again = await agent.escalation.resolve({ conversationId: convId });
    assert(again.status === "resolved", "resolve is idempotent");
    let threw = false;
    try {
      await agent.escalation.escalate({ conversationId: convId });
    } catch {
      threw = true;
    }
    assert(threw, "escalating a resolved conversation is rejected");

    // The full transition chain is observable on the row.
    const [final] = await world.db.select().from(schema.conversations).where(eq(schema.conversations.id, convId)).limit(1);
    assert(final.status === "resolved" && final.escalatedAt && final.resolvedAt && final.aiHandled === false,
      "final row carries the full escalation lifecycle");
  },
};
