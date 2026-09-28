// === W54 capabilities (CAP-1) ===
/**
 * J555 — Telegram parity: the SAME deterministic membership engine answers
 * "membership" / "join membership <n>" / "my membership" on TG (telegram
 * inbound feeds the same nlp.processMessage block); join activates the free
 * tier against the TG buyer ref and the status reply reads it back.
 */
import { and, eq } from "drizzle-orm";
import { TENANT_ID, assert, type World } from "../world";
import type { Journey } from "../runner";
import { ensureTelegramConfig, tgPost, tgTextUpdate, TG_SECRET } from "./j235-telegram-webhook-security";

export const journey: Journey = {
  id: "J555",
  name: "TG membership parity: list → join → status on Telegram",
  feature: "W54 capabilities: consumer membership tiers (TG parity)",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { tg } = await import("../metaMock");
    const { recordConsent } = await import("../../server/services/consent");
    await ensureTelegramConfig(world);

    const svc = await import("../../server/services/membershipPlans");
    await svc.createMembershipPlan(world.db as any, {
      tenantId: TENANT_ID, name: "J555 Silver", priceCents: 0, period: "month",
      discountPercent: 5, pointsMultiplier: 1,
    });

    const chatId = "880548";
    const buyerRef = `telegram:${chatId}`;
    await recordConsent(world.db, { tenantId: TENANT_ID, phone: buyerRef, channel: "telegram", granted: true });

    const tgSend = async (updateId: number, text: string, label: string) => {
      const before = tg.callsFor("sendMessage").length;
      const res = await tgPost(world, TENANT_ID, TG_SECRET, tgTextUpdate(updateId, chatId, 770548, text));
      assert(res.status === 200, `${label}: webhook acked (got ${res.status})`);
      await world.waitFor(() => tg.callsFor("sendMessage").length > before, 12000, `${label}: TG reply`);
      return String(tg.callsFor("sendMessage").at(-1)!.body?.text ?? "");
    };

    // ── 1. plan list on TG ──
    const list = await tgSend(980548, "membership", "list");
    assert(list.includes("J555 Silver"), `TG list carries the plan (got ${list.slice(0, 200)})`);

    // ── 2. join on TG → ACTIVE ──
    const joined = await tgSend(980549, "join membership 1", "join");
    // Locale-agnostic: the reply is localized (see J554 note) — assert the plan name + welcome emoji.
    assert(joined.includes("J555 Silver") && joined.includes("🎉"), `TG join activates (got ${joined.slice(0, 200)})`);
    const rows = await world.db.select().from(schema.customerMemberships)
      .where(and(
        eq(schema.customerMemberships.tenantId, TENANT_ID),
        eq(schema.customerMemberships.status, "active"),
      ));
    assert(rows.length === 1, `exactly one live membership (got ${rows.length})`);
    // Unbound TG refs store the chat id as the customer ref (documented
    // convention — the w54BuyerRef falls back to the chat id when no
    // telegram_identity is linked).
    assert(rows[0]!.customerId === chatId || rows[0]!.customerId === buyerRef.slice(0, 36),
      `TG customer ref persisted (got ${rows[0]!.customerId})`);

    // ── 3. status on TG reads it back ──
    const status = await tgSend(980550, "my membership", "status");
    assert(status.includes("J555 Silver") && status.includes("5%"), `TG status reply (got ${status.slice(0, 200)})`);

    // ── 4. cancel on TG (free tier → immediate) ──
    const cancel = await tgSend(980551, "cancel membership", "cancel");
    assert(cancel.includes("J555 Silver") && cancel.includes("✅"), `TG cancel reply (got ${cancel.slice(0, 200)})`);
    const [after] = await world.db.select().from(schema.customerMemberships)
      .where(eq(schema.customerMemberships.id, rows[0]!.id));
    assert(after!.status === "cancelled", `free-tier cancel is immediate (got ${after!.status})`);
  },
};
// === END W54 capabilities ===
