// === W55 parity (PARITY-8) ===
/**
 * J564 — customer "wallet balance" self-serve on WA + TG + USSD (SMS rides
 * the same shared nlp block): READ-ONLY (customerWallet.walletBalance +
 * last ledger entries; no writes). WA replies via the shared nlp engine,
 * TG resolves the linked E.164 phone, USSD reuses the same read through
 * ussdBalances ("wallet" keyword).
 */
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { ensureTelegramConfig, tgPost, tgTextUpdate, TG_SECRET } from "./j235-telegram-webhook-security";

export const journey: Journey = {
  id: "J564",
  name: "wallet balance self-serve keyword on WA + TG + USSD",
  feature: "W55 parity: customer wallet balance keyword (PARITY-8)",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const wallet = await import("../../server/services/customerWallet");

    // ── 1. WA keyword → balance + ledger summary ────────────────────────
    const waPhone = world.newPhone("564");
    await world.grantConsent(waPhone);
    const credit = await wallet.creditWallet(TENANT_ID, waPhone, 250_000, "merchant_goodwill", "j564-seed-wa", world.db as any);
    assert(credit.ok === true, "wallet credit seeded");
    await world.text(waPhone, "wallet balance");
    await world.waitFor(() =>
      world.outbound.ofType("text", waPhone).some((c) =>
        JSON.stringify(c.body ?? {}).includes("Wallet balance")),
      12000, "WA wallet balance reply");
    const waReply = JSON.stringify(world.outbound.lastOfType("text", waPhone)?.body ?? {});
    assert(waReply.includes("2,500.00"), `WA reply carries the balance (got ${waReply.slice(0, 200)})`);
    assert(waReply.includes("Recent wallet activity") && waReply.includes("merchant_goodwill"),
      "WA reply carries the ledger summary");

    // A customer with no wallet gets the honest empty reply.
    const emptyPhone = world.newPhone("564e");
    await world.grantConsent(emptyPhone);
    await world.text(emptyPhone, "wallet");
    await world.waitFor(() =>
      world.outbound.ofType("text", emptyPhone).some((c) =>
        /don't have a wallet/i.test(JSON.stringify(c.body ?? {}))),
      12000, "WA no-wallet honest reply");

    // ── 2. TG keyword → same engine, linked E.164 identity ──────────────
    await ensureTelegramConfig(world);
    const { tg } = await import("../metaMock");
    const chatId = "95564001";
    const tgPhone = world.newPhone("564t");
    await world.db.insert(schema.telegramIdentities).values({
      tenantId: TENANT_ID, chatId, phoneE164: tgPhone, linkedVia: "j564_seed",
    }).onConflictDoNothing();
    const { recordConsent } = await import("../../server/services/consent");
    await recordConsent(world.db, { tenantId: TENANT_ID, phone: `telegram:${chatId}`, channel: "telegram", granted: true });
    await wallet.creditWallet(TENANT_ID, tgPhone, 75_000, "merchant_goodwill", "j564-seed-tg", world.db as any);
    const res = await tgPost(world, TENANT_ID, TG_SECRET, tgTextUpdate(9605640, chatId, 770564, "wallet"));
    assert(res.status === 200, "TG webhook acks wallet keyword");
    await world.waitFor(() => tg.callsFor("sendMessage").some((c) =>
      String(c.body?.chat_id) === chatId && /Wallet balance: NGN 750\.00/.test(String(c.body?.text ?? ""))),
      10000, "TG wallet balance reply carries the linked phone's balance");

    // ── 3. USSD keyword → read-only balance (ussdBalances reuse) ────────
    const ussdPhone = world.newPhone("564u");
    await wallet.creditWallet(TENANT_ID, ussdPhone, 10_000, "merchant_goodwill", "j564-seed-ussd", world.db as any);
    const sid = `w55-j564-${Date.now()}`;
    await world.ussd(sid, ussdPhone, "");
    const reply = await world.ussd(sid, ussdPhone, "wallet");
    assert(reply.startsWith("END"), `wallet balance END (got ${reply.slice(0, 80)})`);
    assert(reply.includes("Wallet balance") && reply.includes("100.00"),
      `USSD wallet balance reply (got ${reply.slice(0, 160)})`);
  },
};
