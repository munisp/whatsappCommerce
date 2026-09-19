// === W47 merchant ===
/**
 * J436 — ONB-M-15 (Telegram bot reachability joins live validation when a
 * bot is configured) + ONB-M-18 (abandoned half-onboarded tenants are
 * nudged at 7d and churned at 45d, idempotently, only when they never
 * traded).
 */
import { eq } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { adminCaller } from "./helpers";

export const journey: Journey = {
  id: "J436",
  name: "telegram validation check + abandoned-onboarding sweep (ONB-M-15/M-18)",
  feature: "W47 merchant: channel-parity validation; abandoned tenant reaper",
  async run(world) {
    const schema = await import("../../drizzle/schema");
    const svc = await import("../../server/services/onboarding");
    const lc = await import("../../server/services/onboardingLifecycle");

    // ── M-15: checkTelegramBotToken via scripted fetch ───────────────────
    const okFetch = (async () => new Response("{}", { status: 200 })) as typeof fetch;
    const badFetch = (async () => new Response("unauthorized", { status: 401 })) as typeof fetch;
    const okCheck = await svc.checkTelegramBotToken("123:abc", okFetch);
    assert(okCheck.ok && okCheck.check === "telegram", "telegram check passes on getMe 200");
    const badCheck = await svc.checkTelegramBotToken("123:bad", badFetch);
    assert(!badCheck.ok && /401/.test(badCheck.detail ?? ""), "telegram check fails on 401");

    // runTenantValidation includes the telegram check only when configured.
    const admin = await adminCaller();
    const started = await admin.onboarding.start({ name: "J436 TG Store" });
    const { updateTenantSettings } = svc;
    await updateTenantSettings(started.tenantId, (s) => {
      (s as any).telegram = { enabled: true, botToken: "123:bad" };
    });
    const [tgTenant] = await world.db.select().from(schema.tenants).where(eq(schema.tenants.id, started.tenantId)).limit(1);
    const report2 = await svc.runTenantValidation(
      { id: tgTenant.id, whatsappPhoneNumberId: "pn-j436", settings: tgTenant.settings },
      // fetch that 200s the Graph call but 401s Telegram
      (async (url: any) => new Response("{}", { status: String(url).includes("telegram") ? 401 : 200 })) as typeof fetch,
    );
    const tgCheck = report2.checks.find((c) => c.check === "telegram");
    assert(tgCheck && !tgCheck.ok, "dead telegram bot fails validation");
    assert(report2.passed === false, "validation fails closed on dead telegram bot");

    // ── M-18: sweep nudges at 7d, churns at 45d, idempotent, skips live ──
    const mkTenant = async (name: string, ageDays: number) => {
      const s = await admin.onboarding.start({ name });
      await world.db.update(schema.tenants)
        .set({ createdAt: new Date(Date.now() - ageDays * 86_400_000) })
        .where(eq(schema.tenants.id, s.tenantId));
      return s.tenantId;
    };
    const fresh = await mkTenant("J436 Fresh", 2);
    const stale = await mkTenant("J436 Stale", 10);
    const ancient = await mkTenant("J436 Ancient", 60);
    const traded = await mkTenant("J436 Traded", 60);
    // The traded tenant has an order → never churned.
    await world.db.insert(schema.orders).values({
      id: `j436-order-${traded.slice(0, 8)}`,
      tenantId: traded,
      customerId: "j436-customer",
      orderNumber: `J436-${Date.now()}`,
      totalAmount: "1000",
    }).onConflictDoNothing();

    const run1 = await lc.sweepAbandonedOnboardingTenants(world.db);
    const statusOf = async (id: string) =>
      (await world.db.select({ status: schema.tenants.status }).from(schema.tenants).where(eq(schema.tenants.id, id)).limit(1))[0]?.status;
    assert(await statusOf(fresh) === "trial", "fresh tenant untouched");
    assert(await statusOf(stale) === "trial", "stale tenant nudged, not churned");
    assert(await statusOf(ancient) === "churned", "ancient no-order tenant churned");
    assert(await statusOf(traded) === "trial", "tenant with orders is never churned");

    const logs = await world.db.select().from(schema.onboardingReengagementLog);
    assert(logs.some((l: any) => l.tenantId === stale && l.kind === "nudge7d"), "nudge ledgered");
    assert(logs.some((l: any) => l.tenantId === ancient && l.kind === "churn45d"), "churn ledgered");

    // Idempotent: a second sweep changes nothing.
    const run2 = await lc.sweepAbandonedOnboardingTenants(world.db);
    assert(run2.nudged === 0 && run2.churned === 0, "second sweep is a no-op");

    const audit = await world.db.select().from(schema.auditLogs)
      .where(eq(schema.auditLogs.entityId, ancient));
    assert(audit.some((a: any) => a.action === "onboarding.abandoned_churn"), "churn audited");
  },
};
