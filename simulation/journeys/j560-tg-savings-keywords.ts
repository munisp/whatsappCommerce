// === W55 parity (PARITY-1) ===
/**
 * J560 — TG stokvel/insurance/voucher keyword flows: TG text now routes
 * through the SAME savingsWa.handleSavingsInbound the WA path uses (W55
 * pre-NLP seam in telegramInbound.dispatchToNlp, TG identity → linked
 * E.164). A "stokvel contribute <id>" from a linked TG chat RECORDS the
 * contribution (claim-first/idempotent inside stokvel.recordContribution —
 * a replay never double-records); "insure" and "voucher <code>" answer
 * deterministically instead of falling to the LLM.
 */
import { and, eq } from "drizzle-orm";
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { ensureTelegramConfig, tgPost, tgTextUpdate, TG_SECRET } from "./j235-telegram-webhook-security";

export const journey: Journey = {
  id: "J560",
  name: "TG stokvel contribute + insure/voucher keyword parity",
  feature: "W55 parity: TG text routed through savingsWa pre-NLP (PARITY-1)",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { tg } = await import("../metaMock");
    await ensureTelegramConfig(world);

    const chatId = "95560001";
    const phone = world.newPhone("560");
    const other = world.newPhone("560b");
    // Link the TG chat to the E.164 phone + grant TG consent (j346 pattern).
    await world.db.insert(schema.telegramIdentities).values({
      tenantId: TENANT_ID, chatId, phoneE164: phone, linkedVia: "j560_seed",
    }).onConflictDoNothing();
    const { recordConsent } = await import("../../server/services/consent");
    await recordConsent(world.db, { tenantId: TENANT_ID, phone: `telegram:${chatId}`, channel: "telegram", granted: true });

    // Seed a stokvel circle with the linked phone as a member.
    const stokvel = await import("../../server/services/stokvel");
    const { circle } = await stokvel.createCircle(world.db as any, {
      tenantId: TENANT_ID,
      name: "J560 Esusu",
      contributionAmountCents: 100_000,
      frequency: "weekly",
      members: [{ phone }, { phone: other }],
      createdByPhone: other,
    });

    // ── 1. TG "stokvel contribute <prefix>" → recorded ──────────────────
    const before = tg.callsFor("sendMessage").length;
    const res1 = await tgPost(world, TENANT_ID, TG_SECRET, tgTextUpdate(960560, chatId, 770560, `stokvel contribute ${circle.id.slice(0, 8)}`));
    assert(res1.status === 200, "TG webhook acks contribute");
    await world.waitFor(async () => {
      const rows = await world.db.select().from(schema.stokvelContributions)
        .where(and(eq(schema.stokvelContributions.circleId, circle.id), eq(schema.stokvelContributions.phone, phone)));
      return rows.length === 1;
    }, 12000, "TG stokvel contribution recorded for the linked phone");
    await world.waitFor(() => tg.callsFor("sendMessage").length > before, 10000, "TG reply sent");
    const reply1 = tg.callsFor("sendMessage").find((c) =>
      String(c.body?.chat_id) === chatId && /contribution/i.test(String(c.body?.text ?? "")));
    assert(reply1, "TG buyer gets the deterministic contribution reply (no LLM fallback)");

    // ── 2. Idempotent replay: same command again → still ONE row ────────
    const res2 = await tgPost(world, TENANT_ID, TG_SECRET, tgTextUpdate(960561, chatId, 770560, `stokvel contribute ${circle.id.slice(0, 8)}`));
    assert(res2.status === 200, "TG webhook acks replay");
    await world.waitFor(() => tg.callsFor("sendMessage").some((c) =>
      String(c.body?.chat_id) === chatId && /already|PENDING|recorded/i.test(String(c.body?.text ?? ""))), 10000, "replay answered");
    const contributions = await world.db.select().from(schema.stokvelContributions)
      .where(and(eq(schema.stokvelContributions.circleId, circle.id), eq(schema.stokvelContributions.phone, phone)));
    assert(contributions.length === 1, `claim-first idempotency — replay did not double-record (got ${contributions.length})`);

    // ── 3. insure keyword → deterministic menu (no products seeded) ─────
    const res3 = await tgPost(world, TENANT_ID, TG_SECRET, tgTextUpdate(960562, chatId, 770560, "insure"));
    assert(res3.status === 200, "TG webhook acks insure");
    await world.waitFor(() => tg.callsFor("sendMessage").some((c) =>
      String(c.body?.chat_id) === chatId && /insurance|add-on|🛡️/i.test(String(c.body?.text ?? ""))), 10000, "insure menu answered over TG");

    // ── 4. voucher keyword → deterministic not-found (no LLM) ───────────
    const res4 = await tgPost(world, TENANT_ID, TG_SECRET, tgTextUpdate(960563, chatId, 770560, "voucher ABCDEF12"));
    assert(res4.status === 200, "TG webhook acks voucher");
    await world.waitFor(() => tg.callsFor("sendMessage").some((c) =>
      String(c.body?.chat_id) === chatId && /voucher not found/i.test(String(c.body?.text ?? ""))), 10000, "voucher status answered over TG");
  },
};
