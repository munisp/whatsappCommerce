// === W54 disputes ===
/**
 * J552 — DISP-8: merchant WA alert fallback. With settings.adminPhone ABSENT,
 * the dispute/ops alert path (sendAdminOpsAlert) falls back to the tenant
 * OWNER membership's users.phone instead of silently dropping the alert.
 * With neither configured it degrades to logs only (never throws).
 */
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { TENANT_ID, assert, bodyText, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J552",
  name: "DISP-8: admin alert falls back to owner membership phone",
  feature: "W54 admin-phone fallback for dispute alerts",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { sendAdminOpsAlert } = await import("../../server/services/payments/disputes");

    // Snapshot + strip settings.adminPhone.
    const [tenant] = await world.db.select({ settings: schema.tenants.settings })
      .from(schema.tenants).where(eq(schema.tenants.id, TENANT_ID)).limit(1);
    const originalSettings = (tenant?.settings ?? {}) as Record<string, unknown>;
    const stripped = { ...originalSettings };
    delete stripped.adminPhone;
    if (stripped.whatsapp && typeof stripped.whatsapp === "object") {
      stripped.whatsapp = { ...(stripped.whatsapp as any) };
      delete (stripped.whatsapp as any).adminPhone;
    }

    const ownerPhone = `23480${Math.floor(1000000 + Math.random() * 8999999)}`;
    const openId = `sim-j552-owner-${randomUUID().slice(0, 8)}`;
    let userId: number | null = null;
    try {
      await world.db.update(schema.tenants).set({ settings: stripped as any, updatedAt: new Date() })
        .where(eq(schema.tenants.id, TENANT_ID));
      const [u] = await world.db.insert(schema.users).values({
        openId, name: "J552 Owner", phone: ownerPhone, phoneVerified: true,
        loginMethod: "sim", role: "user", tenantId: TENANT_ID, lastSignedIn: new Date(),
      }).returning({ id: schema.users.id });
      userId = u.id;
      await world.db.insert(schema.tenantMemberships).values({
        tenantId: TENANT_ID, userId: String(userId), role: "owner", invitedBy: String(userId),
      }).onConflictDoNothing();
      await world.grantConsent(ownerPhone);

      const base = world.outbound.toPhone(ownerPhone).length;
      await sendAdminOpsAlert(world.db as any, TENANT_ID, "🚨 J552 fallback alert body", "payment_dispute_alert", null);
      await world.waitFor(
        () => world.outbound.toPhone(ownerPhone).length > base,
        10000, "alert delivered to the owner membership phone");
      const text = world.outbound.toPhone(ownerPhone).slice(base).map((c) => bodyText(c)).join("\n");
      assert(text.includes("J552 fallback alert body"), `owner received the alert (got ${text.slice(0, 160)})`);

      // No adminPhone AND no owner phone → logs only, never throws.
      await world.db.delete(schema.tenantMemberships)
        .where(eq(schema.tenantMemberships.userId, String(userId)));
      await sendAdminOpsAlert(world.db as any, TENANT_ID, "🚨 J552 logs-only alert", "payment_dispute_alert", null);
      // Reaching here without an exception IS the assertion (fail-open).
    } finally {
      await world.db.update(schema.tenants).set({ settings: originalSettings as any, updatedAt: new Date() })
        .where(eq(schema.tenants.id, TENANT_ID));
      if (userId != null) {
        await world.db.delete(schema.tenantMemberships)
          .where(eq(schema.tenantMemberships.userId, String(userId))).catch(() => {});
        await world.db.delete(schema.users).where(eq(schema.users.id, userId)).catch(() => {});
      }
    }
  },
};
