// === W48 integrations ===
/**
 * J479 — PERF-INT-4: the portal agent reply (conversation.sendMessage)
 * routes through waSender.sendWhatsAppText instead of a raw Graph fetch.
 *
 * Was: raw fetch to graph.facebook.com/v19.0 — no timeout, no retry
 * classification, no ban-circuit check, no metering, and version drift vs
 * the platform's v21.0.
 *
 * Asserts:
 *   1. Source: conversation.ts no longer calls Graph directly; it delegates
 *      to waSender with notifType "portal_agent_reply".
 *   2. Behavior: the mutation succeeds through the waSender path (Graph
 *      intercepted by the sim metaMock), returns wamids, and records the
 *      outbound text for the timeline + outbound log.
 */
import { readFile } from "node:fs/promises";
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { tenantCaller } from "./helpers";

export const journey: Journey = {
  id: "J479",
  name: "portal agent reply routes through waSender (timeout/circuit/metering)",
  feature: "PERF-INT-4",
  async run(world: World) {
    const src = await readFile(new URL("../../server/routers/conversation.ts", import.meta.url), "utf8");
    // W48 merger fix: assert no raw Graph FETCH CALL (the URL literal also
    // appears in the explanatory comment D left above the waSender seam).
    assert(!/fetch\([^)]*graph\.facebook\.com/.test(src), "no raw Graph fetch call in conversation.ts");
    assert(src.includes('notifType: "portal_agent_reply"'), "reply is metered under its own notifType");
    // Merge with development: the reply goes through the channel-agnostic sendChannelMessage facade (so a Telegram
    // chat can be answered too), whose whatsapp branch is waSender.sendWhatsAppText.
    assert(src.includes("sendChannelMessage"), "reply routes through the channel facade");
    const facade = await readFile(new URL("../../server/services/channelSender.ts", import.meta.url), "utf8");
    assert(facade.includes("wa.sendWhatsAppText("), "the facade's whatsapp branch is waSender");

    const caller = await tenantCaller(TENANT_ID);
    const phone = "+2348017000479";
    // W48 merger fix: outbound.ofType compares `to` EXACTLY and waSender
    // normalizes the recipient to E.164 digits (no "+") — use the
    // digit-normalizing toPhone() view filtered by waType instead.
    const textsTo = () => world.outbound.toPhone(phone).filter((c) => c.waType === "text").length;
    const before = textsTo();
    const res = await caller.conversation.sendMessage({
      tenantId: TENANT_ID,
      toPhone: phone,
      body: "Hello from the portal — your order is on its way!",
    });
    assert(res.sent === true, `reply sent (got ${JSON.stringify(res)})`);
    assert(Array.isArray(res.wamids) && res.wamids.length >= 1, "wamids returned from the waSender path");
    await world.waitFor(() => textsTo() > before, 5000, "outbound reply recorded");

    // Timeline row persisted.
    const schema = await import("../../drizzle/schema");
    const { and, eq, desc } = await import("drizzle-orm");
    const rows = await world.db.select().from(schema.channelMessages)
      .where(and(eq(schema.channelMessages.tenantId, TENANT_ID), eq(schema.channelMessages.toAddress, phone)))
      .orderBy(desc(schema.channelMessages.createdAt)).limit(1);
    assert(rows.length === 1 && rows[0].direction === "outbound", "channelMessages timeline row persisted");
  },
};
