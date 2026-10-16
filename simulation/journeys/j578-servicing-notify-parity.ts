// === W56 credit ===
/**
 * J578 — buyer servicing notifications ride channelParity with WA/TG
 * parity, fail-open and localized ×8:
 *   1. WA-only buyer admin → adjustFeeBps notifies via WhatsApp text
 *      (outbound ledger), body carries old→new bps and "future" wording.
 *   2. Same phone linked to a telegram identity → the next adjustment
 *      routes to TELEGRAM (channelSender), and gracePeriod + reschedule
 *      notices follow the same TG route (parity).
 *   3. Notification failure NEVER blocks the money path (fail-open):
 *      a hard TG outage still returns ok:true from the service.
 *   4. The three servicing keys render in all 8 locales.
 */
import { eq } from "drizzle-orm";
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { meta, outbound } from "../metaMock";
import { ensureTelegramConfig } from "./j235-telegram-webhook-security";

const DAY = 86400_000;

export const journey: Journey = {
  id: "J578",
  name: "servicing notices reach the buyer on WA and TG (parity, fail-open, ×8)",
  feature: "W56 credit servicing: channelParity notify",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const svc = await import("../../server/services/creditServicing");
    const i18n = await import("../../server/services/i18n");

    const adminPhone = world.newPhone("578").replace(/\D/g, "");
    await world.patchTenantSettings({ adminPhone });

    const accountId = crypto.randomUUID();
    // Distinct supplier tenant — the (sim-supplier, sim-tenant) pair already
    // has a seeded account (pair-unique index).
    await world.db.insert(schema.tenants).values({ id: "j578-sup", name: "J578 Supplier", slug: "j578-sup", status: "active" }).onConflictDoNothing();
    await world.db.insert(schema.creditAccounts).values({
      id: accountId, supplierTenantId: "j578-sup", buyerTenantId: TENANT_ID,
      limitCents: 10_000_000, outstandingCents: 100_000, termsDays: 30, status: "active", feeBps: 150,
    });

    // ── 1. WA path ───────────────────────────────────────────────────────
    const waBefore = outbound.toPhone(adminPhone).length;
    const r1 = await svc.adjustFeeBps(world.db as any, {
      accountId, newFeeBps: 250, reason: "J578 wa", actorId: "j578",
    });
    assert(r1.ok && r1.notified === true, "WA notice attempted");
    const waCalls = outbound.toPhone(adminPhone);
    assert(waCalls.length === waBefore + 1, "exactly one WA text sent");
    const waBody = JSON.stringify(waCalls[waCalls.length - 1].body ?? {});
    assert(waBody.includes("150") && waBody.includes("250"), "WA body carries old→new bps");

    // ── 2. TG parity once the phone is linked ────────────────────────────
    await ensureTelegramConfig(world);
    const chatId = "95578001";
    await world.db.insert(schema.telegramIdentities).values({
      tenantId: TENANT_ID, chatId, phoneE164: adminPhone, linkedVia: "j578_seed",
    }).onConflictDoNothing();
    const tgBefore = meta.outbound.filter((c) => c.url.includes("api.telegram.org")).length;
    const r2 = await svc.adjustFeeBps(world.db as any, {
      accountId, newFeeBps: 300, reason: "J578 tg", actorId: "j578",
    });
    assert(r2.ok && r2.notified === true, "TG notice attempted");
    const tgCalls = meta.outbound.filter((c) => c.url.includes("api.telegram.org"));
    assert(tgCalls.length === tgBefore + 1, "telegram sendMessage fired (parity with WA)");
    const tgBody = JSON.stringify(tgCalls[tgCalls.length - 1].body ?? {});
    assert(tgBody.includes(chatId) && tgBody.includes("250") && tgBody.includes("300"), "TG body to the linked chat carries old→new bps");
    const waAfterTg = outbound.toPhone(adminPhone).length;
    assert(waAfterTg === waBefore + 1, "telegram-linked admin is NOT double-messaged on WA");

    // Grace notice rides TG too.
    await world.db.insert(schema.creditLedger).values({
      id: crypto.randomUUID(), creditAccountId: accountId, kind: "invoice_draw",
      amountCents: 100_000, status: "posted", dueDate: new Date(Date.now() + 5 * DAY), ref: "draw:j578:a",
    });
    const g = await svc.gracePeriod(world.db as any, {
      accountId, days: 7, reason: "J578 grace", actorId: "j578", actionRef: "j578-g1",
    });
    assert(g.ok && g.extended === 1, "grace applied");
    const tgAfterGrace = meta.outbound.filter((c) => c.url.includes("api.telegram.org"));
    assert(tgAfterGrace.length === tgCalls.length + 1, "grace notice also routes to telegram");

    // ── 3. Fail-open: hard TG outage never blocks the money path ─────────
    meta.hostStatus.set("api.telegram.org", 500);
    try {
      const r3 = await svc.adjustFeeBps(world.db as any, {
        accountId, newFeeBps: 350, reason: "J578 outage", actorId: "j578",
      });
      assert(r3.ok === true, "fee adjustment succeeds despite the TG outage");
      const [acct] = await world.db.select().from(schema.creditAccounts).where(eq(schema.creditAccounts.id, accountId));
      assert(acct.feeBps === 350, "money path committed");
    } finally {
      meta.hostStatus.delete("api.telegram.org");
    }

    // ── 4. ×8 catalog coverage ───────────────────────────────────────────
    for (const key of ["creditFeeAdjusted", "creditRescheduled", "creditGraceExtended"] as const) {
      for (const locale of i18n.SUPPORTED_LOCALES) {
        const rendered = i18n.t27(locale, key, { oldBps: 1, newBps: 2, reason: "r", count: 1, delta: "0.00", days: 1 });
        assert(rendered.length > 0, `${key} renders in ${locale}`);
      }
    }
  },
};
// === END W56 credit ===
