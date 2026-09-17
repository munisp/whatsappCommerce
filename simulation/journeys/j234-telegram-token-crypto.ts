// === W37 telegram (Coder A) ===
/**
 * J234 — tenant bot token encrypted round-trip REUSING the existing (W42: v2:<kid>)
 * crypto helpers (crypto/secrets — the same scheme whatsapp.accessToken
 * uses; no new crypto).
 *
 *   1. encryptSecret → v2:<kid> envelope; stored in settings.telegram.botToken;
 *      resolveTenantTelegramCredentials decrypts back to the exact token.
 *   2. Legacy plaintext passthrough (decryptSecret contract) still resolves.
 *   3. Tampered ciphertext → GCM auth failure → credential resolution fails
 *      CLOSED to simulation (send is simulated, never throws, no HTTP call).
 *   4. Per-tenant enabled:false → simulation even with a valid token.
 */
import { assert, type World, TENANT_ID } from "../world";
import type { Journey } from "../runner";
import { meta, outbound } from "../metaMock";

const CHAT = "770301";
const TOKEN = "998877:ROUNDTRIP_BOT_TOKEN";

async function setTelegramSettings(world: World, tg: Record<string, unknown>) {
  await world.db.execute(
    `UPDATE tenants SET settings = COALESCE(settings, '{}'::jsonb) || '${JSON.stringify({ telegram: tg })}'::jsonb WHERE id = '${TENANT_ID}'`,
  );
}

export const journey: Journey = {
  id: "J234",
  name: "telegram bot token: v2:<kid> encrypted round-trip via existing crypto helpers",
  feature: "W37 telegram outbound: tenant token storage parity with whatsapp.accessToken",
  async run(world: World) {
    const tg = await import("../../server/services/telegramSender");
    const { encryptSecret, decryptSecret, isEncrypted } = await import("../../server/services/crypto/secrets");

    process.env.TELEGRAM_ENABLED = "true";
    meta.hostStatus.set("api.telegram.org", 200);

    // ── 1. Encrypted round-trip ────────────────────────────────────────
    const stored = encryptSecret(TOKEN);
    assert(isEncrypted(stored) && stored.startsWith("v2:k1:"), "v2:<kid> envelope produced");
    assert(!stored.includes(TOKEN), "token never stored in plaintext");
    await setTelegramSettings(world, { botToken: stored, enabled: true });
    const creds = await tg.resolveTenantTelegramCredentials(TENANT_ID);
    assert(creds?.botToken === TOKEN, "resolver decrypts v2:<kid> token exactly");
    // The resolved token actually works against the Bot API base URL.
    const send = await tg.sendTelegramText(TENANT_ID, CHAT, "crypto round-trip");
    assert(send.sent === true, "live send with decrypted token");
    const call = outbound.all().filter((c: any) => String(c.url).includes("api.telegram.org")).pop();
    assert(String(call.url).includes(`/bot${TOKEN}/sendMessage`), "decrypted token is the one used on the wire");

    // ── 2. Legacy plaintext passthrough ────────────────────────────────
    assert(decryptSecret("plain-legacy-token") === "plain-legacy-token", "plaintext passthrough (decryptSecret contract)");
    await setTelegramSettings(world, { botToken: "plain-legacy-token", enabled: true });
    const legacy = await tg.resolveTenantTelegramCredentials(TENANT_ID);
    assert(legacy?.botToken === "plain-legacy-token", "legacy plaintext token resolves (read compatibility)");

    // ── 3. Tampered ciphertext → fail closed to simulation ─────────────
    const mid = Math.floor(stored.length / 2);
    const tampered = stored.slice(0, mid) + (stored[mid] === "A" ? "B" : "A") + stored.slice(mid + 1);
    let threw = false;
    try {
      decryptSecret(tampered);
    } catch {
      threw = true;
    }
    assert(threw, "GCM auth-tag failure throws (never returns partial plaintext)");
    await setTelegramSettings(world, { botToken: tampered, enabled: true });
    const bad = await tg.resolveTenantTelegramCredentials(TENANT_ID);
    assert(bad === null, "resolver fails closed on undecryptable token");
    const tgCallsBefore = outbound.all().filter((c: any) => String(c.url).includes("api.telegram.org")).length;
    const sim = await tg.sendTelegramText(TENANT_ID, CHAT, "should simulate");
    assert(sim.simulated === true, "undecryptable token → simulation (fail-open)");
    assert(
      outbound.all().filter((c: any) => String(c.url).includes("api.telegram.org")).length === tgCallsBefore,
      "no HTTP call with a bad token",
    );

    // ── 4. Per-tenant opt-out ──────────────────────────────────────────
    await setTelegramSettings(world, { botToken: stored, enabled: false });
    const optedOut = await tg.resolveTenantTelegramCredentials(TENANT_ID);
    assert(optedOut === null, "settings.telegram.enabled=false → simulation");
    const status = await tg.getTelegramSenderStatus(TENANT_ID);
    assert(status.globallyEnabled === true && status.configured === false && status.mode === "simulation",
      `honest status: enabled globally, unconfigured tenant (got ${JSON.stringify(status)})`);

    // Restore: telegram disabled globally again for later journeys.
    delete process.env.TELEGRAM_ENABLED;
    meta.hostStatus.delete("api.telegram.org");
    await setTelegramSettings(world, { enabled: false });
  },
};
