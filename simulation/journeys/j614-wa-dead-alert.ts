// === W62 findings ===
/**
 * J614 — F13: wa_webhook_events dead-row tenant-admin alert (audit W61 LOW
 * #11). Events exhausting 3 retries went status='dead' silently. Proves the
 * retry sweep wires alertTenantAdminWaWebhookDead and that the helper
 * resolves the tenant from phone_number_id and sends a WA ops alert to
 * settings.adminPhone (fail-open telemetry).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, type World, TENANT_ID, ADMIN_PHONE } from "../world";
import { outbound } from "../metaMock";
import type { Journey } from "../runner";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const journey: Journey = {
  id: "J614",
  name: "wa_webhook_events dead row alerts tenant admin",
  feature: "W62 findings F13: dead-row alert",
  async run(world: World) {
    // ── 1. The retry sweep wires the alert on the dead transition ───────
    const idx = fs.readFileSync(path.join(ROOT, "server/_core/index.ts"), "utf-8");
    assert(idx.includes("alertTenantAdminWaWebhookDead"), "wa-webhook-retry sweep wires the dead-row alert");

    // ── 2. The helper resolves tenant by phone_number_id and alerts ──────
    const schema = await import("../../drizzle/schema");
    const { eq } = await import("drizzle-orm");
    const [tenant] = await world.db
      .select({ phoneNumberId: schema.tenants.whatsappPhoneNumberId })
      .from(schema.tenants)
      .where(eq(schema.tenants.id, TENANT_ID))
      .limit(1);
    const { alertTenantAdminWaWebhookDead } = await import("../../server/services/waDeadAlert");
    const before = outbound.ofType("text", ADMIN_PHONE).length;
    const sent = await alertTenantAdminWaWebhookDead(world.db, {
      id: "j614-evt",
      phoneNumberId: tenant?.phoneNumberId ?? null,
      waPhoneNumber: "2348000000000",
      messageType: "text",
      retryCount: 3,
    }, "simulated persistent failure");
    if ((tenant?.phoneNumberId ?? null) !== null) {
      assert(sent === true, "alert sent when tenant resolvable");
      const alerts = outbound.ofType("text", ADMIN_PHONE).slice(before);
      assert(
        alerts.some((c: any) => String(c.body?.text?.body ?? "").includes("dead-lettered")),
        "admin WA alert body mentions the dead-letter",
      );
    }
    // Unknown phone_number_id → no alert, never throws (fail-open).
    const unsent = await alertTenantAdminWaWebhookDead(world.db, { id: "j614-x", phoneNumberId: "unknown-pnid" }, "x");
    assert(unsent === false, "unresolvable tenant is a quiet no-op");
  },
};
