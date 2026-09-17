/**
 * === W40 tenancy (Coder A, TEN-3) ===
 * J273 — WhatsApp phone-number-id uniqueness: duplicate claim rejected.
 *   1. tenant.updateWhatsAppConfig claiming a phone number id ALREADY held
 *      by another tenant → honest CONFLICT (pre-check, before the DB index).
 *   2. The admin tenant.update path has the same guard.
 *   3. Telegram botUsername duplicate claim → CONFLICT (W37 check preserved).
 *   4. Re-saving your OWN number id still succeeds (no false positive).
 */
import { PHONE_NUMBER_ID, SUPPLIER_TENANT_ID, TENANT_ID, WABA_ID, assert, type World } from "../world";
import type { Journey } from "../runner";
import { adminCaller, expectTrpcError } from "./helpers";

const TG_TOKEN_A = "900000001:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const TG_TOKEN_B = "900000002:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

export const journey: Journey = {
  id: "J273",
  name: "channel identity duplicate claim rejected (TEN-3)",
  feature: "updateWhatsAppConfig/tenant.update CONFLICT on duplicate whatsappPhoneNumberId; telegram botUsername CONFLICT; own-number re-save OK",
  async run(world: World) {
    const admin = await adminCaller();
    const settingsBefore = await world.tenantSettings();

    try {
      // ── 1. Supplier tenant tries to claim TENANT_ID's live WA number ──
      await expectTrpcError(
        admin.tenant.updateWhatsAppConfig({
          tenantId: SUPPLIER_TENANT_ID,
          phoneNumberId: PHONE_NUMBER_ID, // belongs to TENANT_ID
          wabaId: "waba_sim_hijack",
          accessToken: "sim-hijack-token",
          verifyToken: "sim-hijack-verify",
        }),
        "CONFLICT",
        "duplicate whatsappPhoneNumberId claim (operator path)",
      );

      // ── 2. Admin tenant.update path has the same honest guard ─────────
      await expectTrpcError(
        admin.tenant.update({ id: SUPPLIER_TENANT_ID, whatsappPhoneNumberId: PHONE_NUMBER_ID }),
        "CONFLICT",
        "duplicate whatsappPhoneNumberId claim (admin update path)",
      );

      // ── 3. Telegram botUsername duplicate → CONFLICT (W37 check) ──────
      await admin.tenant.updateTelegramConfig({
        tenantId: TENANT_ID,
        botToken: TG_TOKEN_A,
        botUsername: "simw40dupbot",
        enabled: false,
      });
      await expectTrpcError(
        admin.tenant.updateTelegramConfig({
          tenantId: SUPPLIER_TENANT_ID,
          botToken: TG_TOKEN_B,
          botUsername: "@SimW40DupBot", // case-insensitive duplicate
          enabled: false,
        }),
        "CONFLICT",
        "duplicate telegram botUsername claim",
      );

      // ── 4. Re-saving your OWN number id is not a false positive ───────
      const ok = await admin.tenant.updateWhatsAppConfig({
        tenantId: TENANT_ID,
        phoneNumberId: PHONE_NUMBER_ID,
        wabaId: WABA_ID,
        accessToken: "sim-wa-access-token",
        verifyToken: "sim-verify-token",
      });
      assert(ok.success === true, "own-number re-save succeeds");
    } finally {
      // Restore TENANT_ID settings (telegram block + whatsapp token) so
      // later journeys see the seeded world unchanged.
      await world.patchTenantSettings(settingsBefore);
    }
  },
};
