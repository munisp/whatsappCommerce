/**
 * J45 — Secrets at rest: transparent encrypt-on-write / decrypt-on-read.
 *
 * Proves the w10 envelope encryption (server/services/crypto/secrets.ts,
 * AES-256-GCM, v1: prefix) end-to-end against the REAL code paths:
 *
 * (a) tenant.updateWhatsAppConfig encrypts settings.whatsapp.accessToken —
 *     the DB value starts with "v1:" and contains no plaintext.
 * (b) A normal WhatsApp send (waSender.resolveTenantWaCredentials) puts the
 *     DECRYPTED token on the wire — the mock records the raw bearer token.
 * (c) Legacy passthrough: a hand-written plaintext row (pre-w10 shape) still
 *     sends, with the plaintext token used as-is.
 * (d) Writing again re-encrypts (lazy re-encryption of the legacy row).
 * (e) integrations.setConfig encrypts the Odoo apiKey; resolveIntegrationConfig
 *     (the outbox delivery read path) returns the plaintext.
 */
import {
  PHONE_NUMBER_ID,
  TENANT_ID,
  WABA_ID,
  WA_ACCESS_TOKEN,
  assert,
  type World,
} from "../world";
import type { Journey } from "../runner";
import { adminCaller } from "./helpers";

const NEW_TOKEN = "sim-wa-token-j45-rotated";
const LEGACY_TOKEN = "sim-wa-token-j45-legacy-plain";
const NEW_TOKEN_2 = "sim-wa-token-j45-rotated-2";
const ODOO_KEY = "odoo-api-key-j45-plaintext";
const ODOO_URL = "https://odoo.sim.local";

/** Last WhatsApp /messages call to a phone must carry this exact bearer token. */
function assertLastSendUsedToken(world: World, phone: string, token: string, label: string): void {
  const call = world.outbound.lastTo(phone);
  assert(call, `${label}: expected an outbound WhatsApp send to ${phone}`);
  assert(
    call!.authToken === token,
    `${label}: Graph call carried bearer ${JSON.stringify(call!.authToken)} — expected the decrypted ${JSON.stringify(token)}`,
  );
  // The recorded header map itself stays redacted (no secret in transcripts).
  assert(call!.headers.authorization === "Bearer <redacted>", `${label}: recorded header stays redacted`);
}

export const journey: Journey = {
  id: "J45",
  name: "secrets transparent round-trip",
  feature: "v1: envelope at rest, decrypted on the wire, legacy passthrough",
  async run(world) {
    const { decryptSecret, isEncrypted } = await import("../../server/services/crypto/secrets");
    const waBefore = (await world.tenantSettings()).whatsapp ?? {};
    const caller = await adminCaller();

    try {
      // ── (a) write path encrypts ──────────────────────────────────────────
      await caller.tenant.updateWhatsAppConfig({
        tenantId: TENANT_ID,
        phoneNumberId: PHONE_NUMBER_ID,
        wabaId: WABA_ID,
        accessToken: NEW_TOKEN,
        verifyToken: "sim-verify-token",
      });
      const stored1 = String((await world.tenantSettings()).whatsapp?.accessToken ?? "");
      assert(stored1.startsWith("v1:"), `(a) stored token is v1:-enveloped (got ${stored1.slice(0, 24)}…)`);
      assert(!stored1.includes(NEW_TOKEN), "(a) stored token contains no plaintext");
      assert(decryptSecret(stored1) === NEW_TOKEN, "(a) envelope round-trips to the written token");

      // The admin read path masks, never leaks ciphertext or plaintext.
      const cfgView = await caller.tenant.getWhatsAppConfig({ tenantId: TENANT_ID });
      assert(cfgView.accessToken.endsWith(NEW_TOKEN.slice(-4)) && cfgView.accessToken.startsWith("••••"),
        `(a) admin view masks the token (got ${JSON.stringify(cfgView.accessToken)})`);
      assert(cfgView.configured === true, "(a) tenant reports configured");

      // ── (b) read path decrypts — real send uses the plaintext on the wire ─
      const phoneB = world.newPhone("s45b");
      await world.grantConsent(phoneB);
      await world.text(phoneB, "menu");
      assertLastSendUsedToken(world, phoneB, NEW_TOKEN, "(b) encrypted row sends decrypted");

      // ── (c) legacy plaintext row still works (pre-w10 passthrough) ────────
      await world.patchTenantSettings({
        whatsapp: { ...waBefore, accessToken: LEGACY_TOKEN },
      });
      const storedLegacy = String((await world.tenantSettings()).whatsapp?.accessToken ?? "");
      assert(!isEncrypted(storedLegacy), "(c) hand-written row is plaintext (legacy shape)");
      const phoneC = world.newPhone("s45c");
      await world.grantConsent(phoneC);
      await world.text(phoneC, "menu");
      assertLastSendUsedToken(world, phoneC, LEGACY_TOKEN, "(c) legacy plaintext row sends as-is");

      // ── (d) next write re-encrypts (lazy re-encryption of legacy rows) ────
      await caller.tenant.updateWhatsAppConfig({
        tenantId: TENANT_ID,
        phoneNumberId: PHONE_NUMBER_ID,
        wabaId: WABA_ID,
        accessToken: NEW_TOKEN_2,
        verifyToken: "sim-verify-token",
      });
      const stored2 = String((await world.tenantSettings()).whatsapp?.accessToken ?? "");
      assert(stored2.startsWith("v1:"), "(d) rewritten value is v1:-enveloped again");
      assert(decryptSecret(stored2) === NEW_TOKEN_2, "(d) re-encrypted value round-trips");
      const phoneD = world.newPhone("s45d");
      await world.grantConsent(phoneD);
      await world.text(phoneD, "menu");
      assertLastSendUsedToken(world, phoneD, NEW_TOKEN_2, "(d) re-encrypted row sends decrypted");

      // ── (e) integrations path: odoo apiKey encrypted at rest, plain on read ─
      await caller.integrations.setConfig({
        tenantId: TENANT_ID,
        system: "odoo",
        url: ODOO_URL,
        apiKey: ODOO_KEY,
        enabled: true,
        extras: { database: "simdb", username: "simuser" },
      });
      const integ = (await world.tenantSettings()).integrations?.odoo ?? {};
      const storedKey = String(integ.apiKey ?? "");
      assert(storedKey.startsWith("v1:"), `(e) odoo apiKey stored v1:-enveloped (got ${storedKey.slice(0, 24)}…)`);
      assert(!storedKey.includes(ODOO_KEY), "(e) stored apiKey contains no plaintext");

      const { resolveIntegrationConfig } = await import("../../server/services/integrations/clients");
      const resolved = await resolveIntegrationConfig(world.db, TENANT_ID, "odoo");
      assert(resolved.apiKey === ODOO_KEY, "(e) resolveIntegrationConfig returns the plaintext apiKey");
      assert(resolved.url === ODOO_URL, "(e) resolved config keeps the url");

      // getConfig masks the decrypted value — never returns ciphertext/plain.
      const view = await caller.integrations.getConfig({ tenantId: TENANT_ID, system: "odoo" });
      const maskedKey = view.config?.apiKey;
      assert(
        typeof maskedKey === "string" && !maskedKey.startsWith("v1:") && !maskedKey.includes(ODOO_KEY)
          && maskedKey.endsWith(ODOO_KEY.slice(-4)),
        `(e) getConfig masks the apiKey (got ${JSON.stringify(maskedKey)})`,
      );
    } finally {
      // Restore the seed credential state so no other journey observes J45's
      // rotations (the mock never validates tokens, but keep the world tidy).
      await world.patchTenantSettings({ whatsapp: { ...waBefore, accessToken: WA_ACCESS_TOKEN } });
    }
  },
};
