// === W58 statements ===
/**
 * J589 — monthly statement sweep: /api/scheduled/monthly-statements is
 * registered (J178 contract: route + scheduler allowlist), generates the
 * PREVIOUS-month statement per active wallet, delivers a WA document when
 * the tenant has an admin phone, falls back to email when only an admin
 * email exists, skips honestly when neither exists — and is IDEMPOTENT per
 * (wallet, period): a replayed sweep does not re-deliver.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { seedUcTenant } from "./w46-uc-docs-seed";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const journey: Journey = {
  id: "J589",
  name: "monthly statement sweep: WA doc vs email fallback, idempotent",
  feature: "W58 statements: /api/scheduled/monthly-statements",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const svc = await import("../../server/services/walletStatements");

    // ── 1. J178 contract: route in index.ts AND scheduler allowlist ──────
    const indexSrc = fs.readFileSync(path.join(ROOT, "server/_core/index.ts"), "utf-8");
    assert(indexSrc.includes('app.post("/api/scheduled/monthly-statements"'), "monthly-statements route registered in index.ts");
    const scheduler = await import("../../services/scheduler/scheduler.mjs");
    assert(scheduler.SCHEDULE.some((r: { path: string }) => r.path === "/api/scheduled/monthly-statements"),
      "scheduler allowlist has monthly-statements");

    // ── 2. Seed three tenants: WA identity, email-only, no-channel ──────
    const waTenant = await seedUcTenant(world, "589wa", 5891);
    const emailTenant = await seedUcTenant(world, "589em", 5892);
    const noneTenant = await seedUcTenant(world, "589no", 5893);
    const waPhone = world.newPhone("589");

    const patchSettings = async (tenantId: string, settings: Record<string, unknown>) => {
      await world.db.update(schema.tenants).set({ settings: settings as any })
        .where(eq(schema.tenants.id, tenantId));
    };
    // WA creds on the tenant so the document push rides the meta mock and is
    // recorded in world.outbound (no creds → honest simulated send, unlogged).
    await world.db.update(schema.tenants).set({ whatsappPhoneNumberId: "pn_sim_589" } as any)
      .where(eq(schema.tenants.id, waTenant.tenantId));
    await patchSettings(waTenant.tenantId, {
      adminPhone: waPhone,
      whatsapp: { accessToken: "sim-wa-access-token", wabaId: "waba_sim_589", displayPhone: "2347000005890" },
    });
    await patchSettings(emailTenant.tenantId, { notifications: { email: "merchant589@sim.local" } });

    let tag = 0;
    for (const t of [waTenant, emailTenant, noneTenant]) {
      const walletId = `wal-w58-589-${tag++}`;
      await world.db.insert(schema.merchantWallets).values({
        id: walletId, tenantId: t.tenantId, availableBalance: "1000.00", currency: "NGN", isActive: true,
      }).onConflictDoNothing();
      await world.db.insert(schema.walletTransactions).values({
        id: `wtx-589-${tag}`, walletId, tenantId: t.tenantId, type: "escrow_release", amount: "1000.00",
        balanceBefore: "0.00", balanceAfter: "1000.00", currency: "NGN",
        createdAt: svc.previousMonthPeriod(new Date()).from, // first instant of last month
      } as any);
    }

    // ── 3. Sweep via the real cron route ────────────────────────────────
    const run1 = await world.runCron("/api/scheduled/monthly-statements");
    assert(run1.status === 200 && run1.json?.ok === true, `sweep ok (${JSON.stringify(run1.json)?.slice(0, 120)})`);
    const detail1 = (tenantId: string) => run1.json.run.details.find((d: any) => d.tenantId === tenantId)?.outcome;
    assert(detail1(waTenant.tenantId) === "delivered-wa", `WA tenant delivered via WA doc (got ${detail1(waTenant.tenantId)})`);
    assert(detail1(emailTenant.tenantId) === "delivered-email", `email-only tenant falls back to email (got ${detail1(emailTenant.tenantId)})`);
    assert(detail1(noneTenant.tenantId) === "no-channel", `no-channel tenant skipped honestly (got ${detail1(noneTenant.tenantId)})`);

    // WA document actually went out to the admin phone (simulated send).
    const docs = world.outbound.ofType("document", waPhone);
    assert(docs.length >= 1, "WA document message pushed to the admin phone");

    // Statement generated for the previous month on the WA tenant.
    const waStatements = svc.listWalletStatements(waTenant.tenantId);
    const periodKey = svc.previousMonthPeriod(new Date()).from.toISOString().slice(0, 10);
    assert(waStatements.length === 1 && waStatements[0]!.periodStart === periodKey, "previous-month statement generated");
    assert(waStatements[0]!.deliveries.length === 1 && waStatements[0]!.deliveries[0]!.channel === "whatsapp",
      "WA delivery recorded on the manifest");

    // ── 4. Idempotent replay: no re-delivery, no duplicate entry ────────
    const run2 = await world.runCron("/api/scheduled/monthly-statements");
    assert(run2.status === 200, "replay ok");
    assert(detail2(waTenant.tenantId) === "already-delivered", "replay skips the delivered wallet");
    assert(svc.listWalletStatements(waTenant.tenantId).length === 1, "no duplicate manifest entry");
    assert(world.outbound.ofType("document", waPhone).length === docs.length, "no second WA document on replay");

    function detail2(tenantId: string) {
      return run2.json.run.details.find((d: any) => d.tenantId === tenantId)?.outcome;
    }
  },
};
