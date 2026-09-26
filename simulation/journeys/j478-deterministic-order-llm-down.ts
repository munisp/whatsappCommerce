/**
 * J478 — the shop flow survives a real LLM outage, on both channels.
 *
 * Found live 2026-09-25: `LLM_BASE_URL` was unset on the server (defaulting to an unreachable localhost Ollama),
 * so every "I want to place an order" — on WhatsApp AND Telegram — dead-ended in a canned "sorry I don't
 * understand" reply, in a RANDOM Nigerian language (a second bug: the fallback's own language guesser flagged
 * almost any English text, including the raw string "menu_3", because one of its "hints" was the bare letter "m").
 *
 * `llm.forceNetworkError` makes every LLM call throw exactly like a real connection refused (same code path,
 * same retry/backoff, `server/_core/llm.ts` unmodified) — this is not a shortcut around the bug, it reproduces it.
 * `classifyDeterministically` (server/services/deterministicShop.ts) is what should catch every buyer here instead.
 */
import { and, eq } from "drizzle-orm";
import { assert, assertIncludes, bodyText, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { ensureTelegramConfig, tgPost, tgTextUpdate, TG_SECRET } from "./j235-telegram-webhook-security";

export const journey: Journey = {
  id: "J478",
  name: "shop → order → pay survives a real LLM outage (WhatsApp + Telegram)",
  feature: "deterministic fallback for the AI ordering assistant",
  async run(world: World) {
    const { llm } = await import("../metaMock");
    const schema = await import("../../drizzle/schema");

    // ── 1. WhatsApp: the whole thing, LLM down throughout. ─────────────────
    const phone = world.newPhone("j478wa");
    await world.grantConsent(phone);

    llm.forceNetworkError = true;
    try {
      let before = world.outbound.ofType("text", phone).length;
      await world.text(phone, "shop");
      await world.waitFor(() => world.outbound.ofType("text", phone).length > before, 15000, "shop handoff");

      // A genuinely ambiguous message first — the EXACT string from the live bug report (a stray Telegram button id
      // that leaked into NLP as raw text): must stay in ENGLISH, not get flagged as Igbo because the old detector's
      // "hint" for Igbo was the single letter "m" (which "menu_3" — and almost any English sentence — contains),
      // and must not dead-end — it should still show the catalog, not just apologize.
      before = world.outbound.ofType("text", phone).length;
      await world.text(phone, "menu_3");
      await world.waitFor(() => world.outbound.ofType("text", phone).length > before, 20000, "reply despite LLM down");
      const greetReply = bodyText(world.outbound.lastOfType("text", phone));
      // The bug this guards: Yoruba/Hausa/Igbo fallback copy carries diacritics no English sentence has (ẹ ọ ṣ ị ụ
      // etc.) — a short, ambiguous message like this one used to get flagged as one of those languages from a
      // single-letter substring "hint" match. None of those characters should appear now.
      assert(!/[ẹọṣịụàáèéìíòóùúẖƙƴ]/i.test(greetReply), `reply must stay in English while the LLM is down, not a random-language dead end (got: ${greetReply.slice(0, 150)})`);
      assertIncludes(greetReply, "Jollof Rice", "an unrecognized message still shows the catalog, not just an apology");

      // Add a real item deterministically — real English, quantity + product name embedded in an ordinary sentence.
      before = world.outbound.ofType("text", phone).length;
      await world.text(phone, "I need 2 jollof rice please");
      await world.waitFor(() => world.outbound.ofType("text", phone).length > before, 20000, "add-to-cart reply (LLM down)");
      assertIncludes(bodyText(world.outbound.lastOfType("text", phone)), "Jollof Rice", "item added to cart without any LLM call");

      // Confirm — deterministically recognized, and the cart is real (nlpCart.ts's own matching + insert, not
      // anything this module fabricates).
      before = world.outbound.ofType("text", phone).length;
      await world.text(phone, "confirm");
      await world.waitFor(() => world.outbound.ofType("text", phone).length > before, 20000, "order summary (LLM down)");

      // Fulfillment: this step was ALREADY deterministic before today (server/routers/nlp.ts's own pre-LLM
      // "awaitingFulfillment" block) — confirms the two code paths compose correctly end to end.
      before = world.outbound.ofType("text", phone).length;
      await world.text(phone, "1"); // pickup
      await world.waitFor(() => world.outbound.ofType("text", phone).length > before, 15000, "fulfillment reply");
    } finally {
      llm.forceNetworkError = false;
    }

    const [waOrder] = await world.db.select().from(schema.orders)
      .where(and(eq(schema.orders.tenantId, TENANT_ID), eq(schema.orders.customerId, phone)))
      .orderBy(schema.orders.createdAt);
    assert(!!waOrder, "a real order must exist — the whole flow ran with the LLM unreachable throughout");
    assert(Number(waOrder.totalAmount) > 0, "order total must reflect the real catalog price, not a placeholder");
    const [tx] = await world.db.select().from(schema.paymentTransactions)
      .where(eq(schema.paymentTransactions.orderId, waOrder.id));
    assert(!!tx, "a real payment transaction (and so a real payment link) was created");

    // ── 2. Telegram: the same outage, same catalog, same deterministic module. ─────────────────────────────────
    await ensureTelegramConfig(world);
    const { tg } = await import("../metaMock");
    const { recordConsent } = await import("../../server/services/consent");
    const chatId = "478001";
    const sessionKey = `telegram:${chatId}`;
    let uid = 4780001;
    await recordConsent(world.db, { tenantId: TENANT_ID, channel: "telegram", phone: sessionKey, granted: true });
    const { getTelegramConfig } = await import("../../server/services/telegramInbound");
    await world.waitFor(async () => {
      const cfg = await getTelegramConfig(world.db, TENANT_ID);
      return !!(cfg?.enabled && cfg.webhookSecret && cfg.botToken);
    }, 5000, "telegram config visible to a fresh read"); // same setup race as J477 — see its comment

    const sendsToChat = () => tg.callsFor("sendMessage").filter((c: any) => String(c.body?.chat_id) === chatId);
    const send = (text: string) => tgPost(world, TENANT_ID, TG_SECRET, tgTextUpdate(uid++, chatId, 4780099, text));

    llm.forceNetworkError = true;
    try {
      let before = sendsToChat().length;
      await send("shop");
      await world.waitFor(() => sendsToChat().length > before, 15000, "tg shop handoff");

      before = sendsToChat().length;
      await send("2 grilled chicken");
      await world.waitFor(() => sendsToChat().length > before, 20000, "tg add-to-cart reply (LLM down)");
      assertIncludes(String(sendsToChat().at(-1)?.body?.text ?? ""), "Grilled Chicken", "item added to cart on Telegram without any LLM call");

      before = sendsToChat().length;
      await send("confirm");
      await world.waitFor(() => sendsToChat().length > before, 20000, "tg order summary (LLM down)");

      before = sendsToChat().length;
      await send("1"); // pickup
      await world.waitFor(() => sendsToChat().length > before, 15000, "tg fulfillment reply");
    } finally {
      llm.forceNetworkError = false;
    }

    const [tgOrder] = await world.db.select().from(schema.orders)
      .where(and(eq(schema.orders.tenantId, TENANT_ID), eq(schema.orders.customerId, sessionKey)))
      .orderBy(schema.orders.createdAt);
    assert(!!tgOrder, "a real order must exist for the Telegram chat too — same fallback, same channel-agnostic router");
  },
};
