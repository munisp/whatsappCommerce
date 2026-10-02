// === W58 statements ===
/**
 * J590 — merchant "statement" chat keyword, WA+TG parity: the tenant admin
 * phone gets the previous-month (or requested-month) statement generated on
 * demand + delivered as a PDF document; a NON-admin sender falls through
 * silently (no wallet data leak). TG resolves the linked E.164 identity and
 * rides the same handler (telegramInbound seam).
 */
import { eq } from "drizzle-orm";
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { ensureTelegramConfig, tgPost, tgTextUpdate, TG_SECRET } from "./j235-telegram-webhook-security";

export const journey: Journey = {
  id: "J590",
  name: "merchant STATEMENT keyword on WA + TG (admin-phone authz)",
  feature: "W58 statements: chat statement on demand",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const svc = await import("../../server/services/walletStatements");

    // Tenant admin phone + wallet with history (last month).
    const adminPhone = world.newPhone("590");
    await world.patchTenantSettings({ adminPhone });
    const [wallet] = await world.db.select().from(schema.merchantWallets)
      .where(eq(schema.merchantWallets.tenantId, TENANT_ID)).limit(1);
    let walletId = wallet?.id as string | undefined;
    if (!walletId) {
      walletId = "wal-w58-590";
      await world.db.insert(schema.merchantWallets).values({
        id: walletId, tenantId: TENANT_ID, availableBalance: "5000.00", currency: "NGN", isActive: true,
      }).onConflictDoNothing();
    }
    const period = svc.previousMonthPeriod(new Date());
    await world.db.insert(schema.walletTransactions).values({
      id: `wtx-590-${Date.now()}`, walletId, tenantId: TENANT_ID, type: "escrow_release",
      amount: "5000.00", balanceBefore: "0.00", balanceAfter: "5000.00", currency: "NGN",
      reference: "J590", createdAt: period.from,
    } as any).onConflictDoNothing();

    // ── 1. WA: admin phone → statement generated + document delivered ───
    await world.grantConsent(adminPhone);
    await world.text(adminPhone, "statement");
    await world.waitFor(() =>
      world.outbound.ofType("text", adminPhone).some((c) =>
        JSON.stringify(c.body ?? {}).includes("Wallet statement")),
      12000, "WA statement reply");
    const reply = JSON.stringify(world.outbound.lastOfType("text", adminPhone)?.body ?? {});
    assert(reply.includes(period.from.toISOString().slice(0, 10)), "reply names the statement period");
    assert(reply.includes("5,000.00"), "reply carries the closing balance");
    await world.waitFor(() => world.outbound.ofType("document", adminPhone).length >= 1,
      12000, "WA statement PDF document delivered");
    const waStatements = svc.listWalletStatements(TENANT_ID);
    assert(waStatements.some((s) => s.periodStart === period.from.toISOString().slice(0, 10)),
      "statement recorded in the manifest");

    // ── 2. WA: non-admin sender → silent fall-through (no leak) ─────────
    const stranger = world.newPhone("590s");
    await world.grantConsent(stranger);
    await world.text(stranger, "statement");
    await world.settle(600);
    assert(!world.outbound.ofType("text", stranger).some((c) =>
      JSON.stringify(c.body ?? {}).includes("Wallet statement")),
      "non-admin gets NO statement data");
    assert(world.outbound.ofType("document", stranger).length === 0, "non-admin gets NO document");

    // ── 3. TG: linked identity → same handler, same reply ───────────────
    await ensureTelegramConfig(world);
    const { tg } = await import("../metaMock");
    const chatId = "95590001";
    await world.db.insert(schema.telegramIdentities).values({
      tenantId: TENANT_ID, chatId, phoneE164: adminPhone, linkedVia: "j590_seed",
    }).onConflictDoNothing();
    const { recordConsent } = await import("../../server/services/consent");
    await recordConsent(world.db, { tenantId: TENANT_ID, phone: `telegram:${chatId}`, channel: "telegram", granted: true });
    const monthArg = period.from.toISOString().slice(0, 7);
    const res = await tgPost(world, TENANT_ID, TG_SECRET, tgTextUpdate(9605900, chatId, 770590, `statement ${monthArg}`));
    assert(res.status === 200, "TG webhook acks the statement command");
    await world.waitFor(() => tg.callsFor("sendMessage").some((c) =>
      String(c.body?.chat_id) === chatId && /Wallet statement/.test(String(c.body?.text ?? ""))),
      10000, "TG statement reply (same handler, linked phone)");
  },
};
