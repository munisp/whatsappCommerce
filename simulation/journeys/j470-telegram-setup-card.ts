/**
 * J470 — the Telegram settings card's server side: save, Test connection, Register webhook.
 *
 * Real router, real database; only Telegram's Bot API is the simulation mock. Proves:
 *   - the bot token is stored encrypted, returned only masked, and never appears in ANY response, audit row
 *     or error — while still being what the server uses to talk to Telegram;
 *   - re-saving without retyping the token keeps the stored one (toggle/username edits), and the first save
 *     without one is refused;
 *   - Test connection asks Telegram (getMe) with the STORED token, reports a mismatch with the saved
 *     username, and turns an invalid token into a plain message;
 *   - Register webhook builds the address itself (https app URL + tenant id), sends the STORED secret, and
 *     that secret is exactly what the webhook route then accepts;
 *   - every refusal (switch off, http app URL, business not enabled) happens BEFORE Telegram is contacted;
 *   - an analyst, and an owner of a different business, are refused everywhere, again without a Bot API call;
 *   - registrations (success and failure) are audited without secrets.
 */
import { and, eq } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { expectTrpcError, tenantCaller } from "./helpers";
import { tgPost, tgTextUpdate } from "./j235-telegram-webhook-security";

const TID = "j470-tg-setup";
const OTHER_TID = "j470-tg-other";
const TOKEN = "123456789:j470setupcardtokenABCDEFGH0123456789xyz";
const BOT = "j470_setup_bot";
const HTTPS_APP = "https://app.j470.example.test";

export const journey: Journey = {
  id: "J470",
  name: "telegram settings card: encrypted token, test connection, register webhook, gated",
  feature: "tenant.updateTelegramConfig (optional token) + testTelegramConnection + registerTelegramWebhook",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { tg } = await import("../metaMock");
    const { decryptSecret } = await import("../../server/services/crypto/secrets");
    const db = world.db;
    const saved = { enabled: process.env.TELEGRAM_ENABLED, app: process.env.APP_URL };
    tg.reset();
    tg.bot.username = BOT;

    try {
      process.env.TELEGRAM_ENABLED = "true";
      process.env.APP_URL = HTTPS_APP;

      for (const id of [TID, OTHER_TID]) {
        await db.insert(schema.tenants).values({ id, name: `J470 ${id}`, slug: id, status: "active" }).onConflictDoNothing();
      }
      await db.insert(schema.tenantMemberships).values([
        { tenantId: TID, userId: "4701", role: "owner" },
        { tenantId: TID, userId: "4702", role: "analyst" },
        { tenantId: OTHER_TID, userId: "4703", role: "owner" },
      ]).onConflictDoNothing();
      const owner = await tenantCaller(TID, { userId: 4701 });
      const analyst = await tenantCaller(TID, { userId: 4702 });
      const stranger = await tenantCaller(OTHER_TID, { userId: 4703 });

      const seen: string[] = []; // every response the browser could see (the one-time secret is excluded below)
      const keep = (label: string, v: unknown) => (seen.push(`${label}: ${JSON.stringify(v)}`), v);
      const storedTg = async () => {
        const [t] = await db.select({ settings: schema.tenants.settings }).from(schema.tenants).where(eq(schema.tenants.id, TID)).limit(1);
        return (((t.settings ?? {}) as any).telegram ?? {}) as Record<string, any>;
      };

      // ── 1. Nothing configured yet ────────────────────────────────────────
      const c0: any = keep("config0", await owner.tenant.getTelegramConfig({ tenantId: TID }));
      assert(c0.configured === false && c0.botToken === "" && c0.webhookSecretSet === false, `fresh business is unconfigured (got ${JSON.stringify(c0)})`);
      assert(c0.serverEnabled === true, "config reports the server switch");
      assert(c0.webhookUrl === `${HTTPS_APP}/api/webhooks/telegram/${TID}`, `webhook address built by the server (got ${c0.webhookUrl})`);
      process.env.APP_URL = "http://plain.j470.example.test";
      const cHttp: any = await owner.tenant.getTelegramConfig({ tenantId: TID });
      assert(cHttp.webhookUrl === null, "a non-https app address yields NO webhook address (Telegram would never deliver)");
      process.env.APP_URL = HTTPS_APP;

      await expectTrpcError(
        owner.tenant.updateTelegramConfig({ tenantId: TID, botUsername: BOT, enabled: true }),
        "BAD_REQUEST",
        "first save without a token",
      );

      // ── 2. Save: encrypted at rest, masked on read, secret shown once ────
      const s1: any = await owner.tenant.updateTelegramConfig({ tenantId: TID, botToken: TOKEN, botUsername: `@${BOT}`, enabled: true });
      assert(s1.success === true && typeof s1.webhookSecret === "string" && s1.webhookSecret.length >= 20, "first save returns the one-time webhook secret");
      assert(!JSON.stringify(s1).includes(TOKEN), "the save response never echoes the token");
      const oneTimeSecret: string = s1.webhookSecret;
      const at1 = await storedTg();
      assert(typeof at1.botToken === "string" && at1.botToken !== TOKEN && at1.botToken.startsWith("v2:"), `token stored as an encrypted envelope (got ${String(at1.botToken).slice(0, 6)}…)`);
      assert(at1.webhookSecret !== oneTimeSecret && String(at1.webhookSecret).startsWith("v2:"), "secret stored encrypted too");
      assert(decryptSecret(at1.webhookSecret) === oneTimeSecret, "the returned one-time secret is the one stored");
      const c1: any = keep("config1", await owner.tenant.getTelegramConfig({ tenantId: TID }));
      assert(c1.configured === true && c1.webhookSecretSet === true, "configured after save");
      assert(c1.botToken === `••••••••${TOKEN.slice(-4)}`, `token returned masked (got ${c1.botToken})`);
      assert(c1.botUsername === BOT, "username saved without the @");

      // ── 3. Re-save WITHOUT retyping the token keeps the stored one ───────
      const s2: any = await owner.tenant.updateTelegramConfig({ tenantId: TID, botUsername: BOT, enabled: true });
      assert(s2.success === true && s2.webhookSecret === undefined, "re-save returns no new secret");
      const at2 = await storedTg();
      assert(at2.botToken === at1.botToken, "the stored (encrypted) token is untouched by a toggle/username save");

      // ── 4. Roles and business isolation, and no Bot API call for refusals ─
      const callsBefore = tg.calls.length;
      for (const [who, caller] of [["analyst", analyst], ["other business's owner", stranger]] as const) {
        await expectTrpcError(caller.tenant.getTelegramConfig({ tenantId: TID }), "FORBIDDEN", `${who}: getTelegramConfig`);
        await expectTrpcError(caller.tenant.testTelegramConnection({ tenantId: TID }), "FORBIDDEN", `${who}: testTelegramConnection`);
        await expectTrpcError(caller.tenant.registerTelegramWebhook({ tenantId: TID }), "FORBIDDEN", `${who}: registerTelegramWebhook`);
        await expectTrpcError(caller.tenant.updateTelegramConfig({ tenantId: TID, botUsername: "hijack_bot", enabled: true }), "FORBIDDEN", `${who}: updateTelegramConfig`);
      }
      assert(tg.calls.length === callsBefore, "refused callers cause NO call to Telegram");
      assert((await storedTg()).botUsername === BOT, "a refused update changed nothing");

      // ── 5. Test connection ───────────────────────────────────────────────
      const t1: any = keep("test1", await owner.tenant.testTelegramConnection({ tenantId: TID }));
      assert(t1.ok === true && t1.botUsername === BOT && t1.matchesSaved === true, `Test connection ok and matching (got ${JSON.stringify(t1)})`);
      const getMe = tg.callsFor("getMe");
      assert(getMe.length === 1 && getMe[0].token === TOKEN, "the server tested with the STORED token (the browser never sent one)");
      tg.bot.username = "someone_elses_bot";
      const t2: any = keep("test2", await owner.tenant.testTelegramConnection({ tenantId: TID }));
      assert(t2.ok === true && t2.botUsername === "someone_elses_bot" && t2.matchesSaved === false, "a token for a different bot is flagged as a mismatch");
      tg.bot.username = BOT;
      tg.invalidTokens.add(TOKEN);
      const t3: any = keep("test3", await owner.tenant.testTelegramConnection({ tenantId: TID }));
      assert(t3.ok === false && /does not accept/i.test(String(t3.error)) && t3.matchesSaved === false, `an unknown token becomes a plain message (got ${JSON.stringify(t3)})`);
      tg.invalidTokens.delete(TOKEN);

      // ── 6. Register webhook: refusals happen BEFORE Telegram is contacted ─
      const setBefore = tg.callsFor("setWebhook").length;
      delete process.env.TELEGRAM_ENABLED;
      await expectTrpcError(owner.tenant.registerTelegramWebhook({ tenantId: TID }), "PRECONDITION_FAILED", "switch off");
      process.env.TELEGRAM_ENABLED = "true";
      process.env.APP_URL = "http://plain.j470.example.test";
      await expectTrpcError(owner.tenant.registerTelegramWebhook({ tenantId: TID }), "PRECONDITION_FAILED", "app address not https");
      process.env.APP_URL = HTTPS_APP;
      await owner.tenant.updateTelegramConfig({ tenantId: TID, botUsername: BOT, enabled: false });
      await expectTrpcError(owner.tenant.registerTelegramWebhook({ tenantId: TID }), "PRECONDITION_FAILED", "business not enabled");
      await owner.tenant.updateTelegramConfig({ tenantId: TID, botUsername: BOT, enabled: true });
      assert(tg.callsFor("setWebhook").length === setBefore, "no refusal reached Telegram");

      // ── 7. Register webhook: the happy path ──────────────────────────────
      const r1: any = keep("register1", await owner.tenant.registerTelegramWebhook({ tenantId: TID }));
      const expectedUrl = `${HTTPS_APP}/api/webhooks/telegram/${TID}`;
      assert(r1.ok === true && r1.webhookUrl === expectedUrl && r1.pendingUpdateCount === 0 && r1.lastErrorMessage === null, `registered (got ${JSON.stringify(r1)})`);
      const sw = tg.callsFor("setWebhook");
      assert(sw.length === 1 && sw[0].token === TOKEN, "setWebhook used the stored token");
      assert(sw[0].body.url === expectedUrl, `Telegram was given the server-built address (got ${sw[0].body.url})`);
      assert(sw[0].body.secret_token === oneTimeSecret, "Telegram was given the STORED secret (the same one shown once at first save)");

      // What the route accepts is exactly what was registered.
      const routeSecret = decryptSecret((await storedTg()).webhookSecret);
      const hit = await tgPost(world, TID, routeSecret, tgTextUpdate(970470, "880470", 770470, "hello"));
      assert(hit.status === 200 && hit.json?.received === true, `the webhook route accepts the registered secret (got ${hit.status})`);
      const miss = await tgPost(world, TID, `${routeSecret}x`, tgTextUpdate(970471, "880470", 770470, "hello"));
      assert(miss.status === 401, "…and refuses any other");

      // Telegram reports a delivery problem → surfaced, not hidden.
      tg.webhook.lastError = "Wrong response from the webhook: 502 Bad Gateway";
      const r2: any = keep("register2", await owner.tenant.registerTelegramWebhook({ tenantId: TID }));
      assert(r2.ok === true && /502/.test(String(r2.lastErrorMessage)), "a webhook error reported by Telegram is passed through");
      tg.webhook.lastError = null;

      // Telegram rejects the token during registration.
      tg.invalidTokens.add(TOKEN);
      const r3: any = keep("register3", await owner.tenant.registerTelegramWebhook({ tenantId: TID }));
      assert(r3.ok === false && /does not accept/i.test(String(r3.error)), `an invalid token fails registration plainly (got ${JSON.stringify(r3)})`);
      tg.invalidTokens.delete(TOKEN);

      // ── 8. Audit trail, without secrets ──────────────────────────────────
      const audit = await db.select().from(schema.auditLogs)
        .where(and(eq(schema.auditLogs.tenantId, TID), eq(schema.auditLogs.action, "tenant.registerTelegramWebhook")));
      assert(audit.length === 3, `every registration attempt is audited (got ${audit.length})`);
      assert(audit.some((a) => /registered for bot @/.test(a.summary ?? "")) && audit.some((a) => /failed/.test(a.summary ?? "")), "success and failure are both recorded");
      const everything = JSON.stringify(audit) + JSON.stringify(await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.tenantId, TID)));
      assert(!everything.includes(TOKEN) && !everything.includes(oneTimeSecret) && !everything.includes(routeSecret), "no audit row contains the token or the secret");

      // ── 9. Nothing the browser saw contains the token or the secret ──────
      const leaked = seen.filter((l) => l.includes(TOKEN) || l.includes(oneTimeSecret));
      assert(leaked.length === 0, `no response leaks a secret (leaked in: ${leaked.map((l) => l.split(":")[0]).join(", ")})`);
    } finally {
      for (const [k, v] of [["TELEGRAM_ENABLED", saved.enabled], ["APP_URL", saved.app]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  },
};
