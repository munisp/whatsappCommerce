/**
 * simulation/world.ts — seeded tenant world + driving helpers.
 *
 * Boots the REAL platform against an embedded Postgres (PGlite exposed over
 * a local socket, so the unmodified postgres.js path in server/db.ts works)
 * with the Meta Cloud API / LLM / gateways mocked by simulation/metaMock.ts.
 *
 * Driving helpers:
 *   inbound(payload)   — POST the real /api/webhooks/whatsapp handler (HMAC-signed)
 *   text/button/…      — convenience wrappers around payloads.ts factories
 *   status(wamid, st)  — delivery-status callback through the same webhook
 *   runCron(path)      — drive /api/scheduled/* with a valid cron JWT
 *   ussd(...)          — POST /ussd (Africa's Talking form body)
 *   settle()/waitFor() — quiescence + condition polling (the webhook acks
 *                        200 immediately and processes asynchronously)
 *   advanceTime        — services accept `now` injections; elsewhere the
 *                        helpers below backdate rows directly in SQL.
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import http from "http";
import { SignJWT } from "jose";
import { and, eq, desc } from "drizzle-orm";

import { installFetchMock, meta, llm as llmMock, openai as openaiMock, outbound, onWaSend } from "./metaMock";
import * as payloads from "./payloads";
import { recorder } from "./transcript";

// ── Constants ────────────────────────────────────────────────────────────────

export const TENANT_ID = "sim-tenant";
export const TENANT_NAME = "Sim Store";
export const PHONE_NUMBER_ID = "pn_sim_001";
export const WABA_ID = "waba_sim_001";
export const CATALOG_ID = "cat_sim_001";
export const ADMIN_PHONE = "2348099900000";
export const DISPLAY_PHONE = "2347000000000";
export const USSD_SERVICE_CODE = "*928*77#";
export const APP_SECRET = "sim-app-secret-0123456789";
export const JWT_SECRET_VALUE = "sim-jwt-secret-0123456789abcdef";
export const WA_ACCESS_TOKEN = "sim-wa-access-token";

export const PRODUCTS = {
  jollof: { id: "p-jollof", sku: "SIM-JOLLOF", name: "Jollof Rice", price: "2500.00", stock: 50 },
  chicken: { id: "p-chicken", sku: "SIM-CHICKEN", name: "Grilled Chicken", price: "3000.00", stock: 50 },
  lastUnit: { id: "p-lastunit", sku: "SIM-LAST", name: "Last Unit Special", price: "1000.00", stock: 1 },
  soldOut: { id: "p-soldout", sku: "SIM-OOS", name: "Sold Out Sneakers", price: "15000.00", stock: 0 },
  ankara: {
    id: "p-ankara", sku: "SIM-ANKARA", name: "Ankara Fabric", price: "5000.00", stock: 50,
    imageUrl: "https://cdn.sim.local/ankara.jpg",
  },
  restock: { id: "p-restock", sku: "SIM-RESTOCK", name: "Restock Widget", price: "750.00", stock: 0 },
} as const;

// ── Wave 8: B2B supplier tenant (multi-tenant world) ─────────────────────────
// A second tenant ("Lagos Plastics Manufacturing") with its own phone number
// id, admin phone, ACTIVE supplier_profile, wholesale products and a trade
// credit account with the buyer tenant (TENANT_ID). Money is in CENTS (kobo)
// throughout the w8 tables — ₦500,000 = 50_000_000.
export const SUPPLIER_TENANT_ID = "sim-supplier";
export const SUPPLIER_NAME = "Lagos Plastics Manufacturing";
export const SUPPLIER_PHONE_NUMBER_ID = "pn_sim_supplier_001";
export const SUPPLIER_WABA_ID = "waba_sim_supplier_001";
export const SUPPLIER_ADMIN_PHONE = "2348099911111";
export const SUPPLIER_DISPLAY_PHONE = "2347000000099";

// ── Wave 9: platform conversational-onboarding number ────────────────────────
// Prospective tenants message this number; server/_core/index.ts routes it to
// waOnboarding BEFORE tenant resolution. Env is set at boot so the real branch
// executes end-to-end.
export const ONBOARDING_PHONE_NUMBER_ID = "pn_sim_onboarding_001";
export const ONBOARDING_WA_TOKEN = "sim-onboarding-wa-token";

export const CREDIT_ACCOUNT_ID = "c0a51e00-0000-4000-8000-000000000001";
/** ₦500,000 facility, net-14 terms, extended by the supplier to TENANT_ID. */
export const CREDIT_LIMIT_CENTS = 50_000_000;
export const CREDIT_TERMS_DAYS = 14;

export const SUPPLIER_MOQ_CENTS = 100_000; // ₦1,000
// ── Wave 16: Shopify connector + Meta embedded signup app credentials ───────
// Set at boot so ENV (module-scope, read-once) sees them; journeys sign real
// Shopify webhook HMACs with SHOPIFY_API_SECRET_VALUE and script the Meta
// embedded-signup exchange with META_APP_ID_VALUE / META_APP_SECRET_VALUE.
export const SHOPIFY_API_KEY_VALUE = "sim-shopify-api-key";
export const SHOPIFY_API_SECRET_VALUE = "sim-shopify-app-secret-0123456789";
export const META_APP_ID_VALUE = "sim-meta-app-id";
export const META_APP_SECRET_VALUE = "sim-meta-app-secret-0123456789";

export const SUPPLIER_PRODUCTS = {
  preforms: {
    id: "sp-preforms", sku: "SIM-PREFORM", name: "PET Preforms 500ml",
    price: "45.00", wholesalePrice: "40.00", minQty: 100, stock: 100_000,
  },
  crates: {
    id: "sp-crates", sku: "SIM-CRATE20", name: "Plastic Crates 20L",
    price: "2500.00", wholesalePrice: null, minQty: 1, stock: 5_000,
  },
} as const;

export interface World {
  port: number;
  baseUrl: string;
  db: any; // drizzle handle from getDb()
  pg: { query: (text: string, params?: any[]) => Promise<any> };
  stop: () => Promise<void>;

  // driving
  postWebhook: (payload: Record<string, unknown>) => Promise<number>;
  inbound: (payload: Record<string, unknown>) => Promise<void>;
  text: (phone: string, text: string, opts?: { profileName?: string; id?: string; settle?: boolean }) => Promise<void>;
  buttonReply: (phone: string, replyId: string, title: string) => Promise<void>;
  listReply: (phone: string, replyId: string, title: string) => Promise<void>;
  location: (phone: string, lat: number, lng: number, name?: string, address?: string) => Promise<void>;
  image: (phone: string, mediaId: string, caption?: string) => Promise<void>;
  audio: (phone: string, mediaId: string) => Promise<void>;
  reaction: (phone: string, messageId: string, emoji?: string) => Promise<void>;
  status: (wamid: string, status: "sent" | "delivered" | "read" | "failed", opts?: { errors?: any[]; recipientId?: string }) => Promise<void>;
  runCron: (path: string, body?: Record<string, unknown>) => Promise<{ status: number; json: any }>;
  ussd: (sessionId: string, phone: string, text: string) => Promise<string>;
  /** Post an inbound envelope to a specific tenant channel (phone number id). */
  inboundFor: (phoneNumberId: string, payload: Record<string, unknown>) => Promise<void>;
  /** Inbound text on the SUPPLIER tenant's WhatsApp channel. */
  supplierText: (phone: string, text: string, opts?: { profileName?: string }) => Promise<void>;
  /** Interactive button reply on the SUPPLIER tenant's channel (PO approve/reject). */
  supplierButtonReply: (phone: string, replyId: string, title: string) => Promise<void>;
  /** Inbound text on the PLATFORM onboarding number (wave 9 copilot intake). */
  onboardingText: (phone: string, text: string, opts?: { profileName?: string; id?: string }) => Promise<void>;
  /** Interactive button reply on the platform onboarding number (onb_approve:/onb_edit:). */
  onboardingButtonReply: (phone: string, replyId: string, title: string) => Promise<void>;
  settle: (minMs?: number, maxMs?: number) => Promise<void>;
  waitFor: (fn: () => boolean | Promise<boolean>, timeoutMs?: number, label?: string) => Promise<void>;

  // state
  resetJourneyState: () => Promise<void>;
  newPhone: (tag?: string) => string;
  grantConsent: (phone: string) => Promise<void>;
  tenantSettings: () => Promise<Record<string, any>>;
  patchTenantSettings: (patch: Record<string, unknown>) => Promise<void>;
  backdate: (sqlText: string, params?: any[]) => Promise<any>;

  llm: typeof llmMock;
  openai: typeof openaiMock;
  outbound: typeof outbound;
  meta: typeof meta;
  /** W12: scripted Keycloak realm mock (token endpoint + recorded calls). */
  keycloak: KeycloakMock;
}

// ── Env + boot ───────────────────────────────────────────────────────────────

let booted: Promise<World> | null = null;

function setEnv(name: string, value: string): void {
  process.env[name] = value;
}

async function freePort(preferred: number): Promise<number> {
  for (let p = preferred; p < preferred + 50; p++) {
    const ok = await new Promise<boolean>((resolve) => {
      const srv = net.createServer();
      srv.once("error", () => resolve(false));
      srv.listen(p, "127.0.0.1", () => srv.close(() => resolve(true)));
    });
    if (ok) return p;
  }
  throw new Error("no free port");
}
import net from "net";

// ── Wave 12: scripted Keycloak realm (OIDC token endpoint + discovery) ──────
// Journeys script authorization codes → claims; the REAL exchangeCode path in
// server/routers/keycloak.ts performs the token POST against this server
// (plain HTTP on localhost, so the unmodified fetch path executes). Every
// token call is recorded in keycloakMock.tokenCalls for hard assertions.
export interface KeycloakScriptedClaims {
  sub?: string;
  email?: string;
  name?: string;
  preferred_username?: string;
  realm_access?: { roles?: string[] };
  resource_access?: Record<string, { roles?: string[] }>;
}
export interface KeycloakTokenCall {
  realm: string;
  params: Record<string, string>;
}
const keycloakMock = {
  codes: new Map<string, { claims: KeycloakScriptedClaims; status?: number }>(),
  tokenCalls: [] as KeycloakTokenCall[],
  scriptCode(code: string, claims: KeycloakScriptedClaims, status?: number): void {
    this.codes.set(code, { claims, status });
  },
  reset(): void {
    this.codes.clear();
    this.tokenCalls.length = 0;
  },
};
export type KeycloakMock = typeof keycloakMock;

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

/** Mock Keycloak/auth server: answers GetUserInfoWithJwt for cron auth and
 *  the scripted OIDC discovery/token endpoints for W12 realm exchanges. */
async function startAuthMock(port: number): Promise<http.Server> {
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const url = req.url ?? "";
      if (req.method === "POST" && url.includes("GetUserInfoWithJwt")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          openId: "cron_sim",
          appId: "sim-app",
          name: "Sim Cron",
          email: null,
          platform: "manus",
          taskUid: "sim-task-1",
          platforms: [],
        }));
        return;
      }
      // OIDC discovery document.
      const wellKnown = /^\/realms\/([^/]+)\/\.well-known\/openid-configuration/.exec(url);
      if (req.method === "GET" && wellKnown) {
        const base = `http://127.0.0.1:${port}/realms/${wellKnown[1]}`;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          issuer: base,
          token_endpoint: `${base}/protocol/openid-connect/token`,
        }));
        return;
      }
      // OIDC authorization_code token exchange (scripted per code).
      const tokenPath = /^\/realms\/([^/]+)\/protocol\/openid-connect\/token/.exec(url);
      if (req.method === "POST" && tokenPath) {
        const params = Object.fromEntries(new URLSearchParams(body));
        keycloakMock.tokenCalls.push({ realm: tokenPath[1], params });
        const scripted = keycloakMock.codes.get(params.code ?? "");
        if (!scripted) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "invalid_grant", error_description: "sim: unscripted authorization code" }));
          return;
        }
        if (scripted.status && scripted.status >= 400) {
          res.writeHead(scripted.status, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "sim_scripted_error", error_description: `sim: scripted ${scripted.status}` }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          access_token: "sim-kc-access",
          refresh_token: "sim-kc-refresh",
          expires_in: 3600,
          id_token: `hdr.${b64url(scripted.claims)}.sig`,
        }));
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not-found" }));
    });
  });
  await new Promise<void>((resolve) => srv.listen(port, "127.0.0.1", resolve));
  return srv;
}

export async function bootWorld(): Promise<World> {
  if (booted) return booted;
  booted = (async () => {
    // 0. Pin UTC BEFORE anything touches dates: PGlite's session clock is UTC
    // while this box may run another TZ — mixing them corrupts comparisons on
    // `timestamp` (no-tz) columns (NOW() vs client-serialized Date params).
    process.env.TZ = "UTC";
    // 1. Env FIRST — server modules read process.env at import time.
    setEnv("NODE_ENV", process.env.NODE_ENV === "production" ? "test" : (process.env.NODE_ENV || "test"));
    const port = await freePort(4173);
    const pglitePort = await freePort(5455);
    const authPort = await freePort(8181);
    setEnv("PORT", String(port));
    setEnv("APP_URL", `http://localhost:${port}`);
    setEnv("DATABASE_URL", `postgres://postgres:postgres@127.0.0.1:${pglitePort}/postgres`);
    setEnv("PG_POOL_MAX", "1");
    setEnv("JWT_SECRET", JWT_SECRET_VALUE);
    setEnv("TRACKING_SECRET", "sim-tracking-secret-0123456789");
    setEnv("WHATSAPP_APP_SECRET", APP_SECRET);
    setEnv("WHATSAPP_VERIFY_TOKEN", "sim-verify-token");
    setEnv("LLM_BASE_URL", "http://llm.sim.local/v1");
    setEnv("LLM_API_KEY", "sim-llm-key");
    setEnv("OPENAI_BASE_URL", "http://openai.sim.local/v1");
    setEnv("KEYCLOAK_URL", `http://127.0.0.1:${authPort}`);
    setEnv("CORS_ORIGIN", "*");
    // payment.initiate + creditRepayLink need a Paystack secret (intercepted
    // by the fetch mock — never a real network call).
    setEnv("PAYSTACK_SECRET_KEY", "sk_sim_test");
    // W13: sim journeys draw on credit immediately after facility approval —
    // disable the first-draw tenure gate by default (J65 re-enables it
    // explicitly to test the gate itself). Mirrors simulation.test.ts.
    setEnv("CREDIT_TENURE_GATE_DAYS", "0");
    // Wave 9: platform onboarding intake number (waOnboarding) + resumable
    // upload app id (brand-studio profile photo push, intercepted by metaMock).
    setEnv("ONBOARDING_PHONE_NUMBER_ID", ONBOARDING_PHONE_NUMBER_ID);
    setEnv("ONBOARDING_WA_TOKEN", ONBOARDING_WA_TOKEN);
    setEnv("WHATSAPP_APP_ID", "app_sim_001");
    // W10: deterministic 32-byte master key for secrets at rest
    // (server/services/crypto/secrets.ts). Set explicitly for realism — a
    // dev/test fallback exists, but journeys J45/J46 prove the real envelope
    // path against an env-provided key.
    setEnv("SECRETS_MASTER_KEY", crypto.createHash("sha256").update("w10-sim-secrets-master-key").digest("base64"));
    // W16: Shopify app connector + Meta embedded-signup app credentials so
    // the REAL OAuth/HMAC/exchange paths execute (ENV is read at import).
    setEnv("SHOPIFY_API_KEY", SHOPIFY_API_KEY_VALUE);
    setEnv("SHOPIFY_API_SECRET", SHOPIFY_API_SECRET_VALUE);
    setEnv("SHOPIFY_APP_URL", `http://localhost:${port}`);
    setEnv("META_APP_ID", META_APP_ID_VALUE);
    setEnv("META_APP_SECRET", META_APP_SECRET_VALUE);
    // === W28 medusa-storefront (Coder B): deterministic adapter + webhook secret ===
    setEnv("MEDUSA_ADAPTER", "mock");
    setEnv("MEDUSA_WEBHOOK_SECRET", "sim-medusa-webhook-secret-0123456789");
    // === END W28 medusa-storefront ===

    // 2. Fetch interceptor BEFORE any server module can fire a request.
    installFetchMock();
    onWaSend((call, wamid, failStatus) => recorder.recordOutbound(call, wamid, failStatus));

    // 3. Embedded Postgres (PGlite) + socket server + migrations.
    const { PGlite } = await import("@electric-sql/pglite");
    const { PGLiteSocketServer } = await import("@electric-sql/pglite-socket");
    const pg = new PGlite();
    await pg.waitReady;
    const migDir = path.resolve(process.cwd(), "drizzle"); // cwd = repo root under tsx/vitest
    const migFiles = fs.readdirSync(migDir).filter((f) => f.endsWith(".sql")).sort();
    for (const f of migFiles) {
      const sqlText = fs.readFileSync(path.join(migDir, f), "utf8");
      for (const stmt of sqlText.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean)) {
        await pg.exec(stmt);
      }
    }
    const pgServer = new PGLiteSocketServer({ db: pg, port: pglitePort, host: "127.0.0.1" });
    await pgServer.start();

    const authServer = await startAuthMock(authPort);

    // 4. Boot the real Express server (auto-starts on import).
    await import("../server/_core/index");

    // 5. Wait for health.
    const health = `http://127.0.0.1:${port}/health`;
    let up = false;
    for (let i = 0; i < 120 && !up; i++) {
      await new Promise((r) => setTimeout(r, 250));
      up = await fetch(health).then((r) => r.ok).catch(() => false);
    }
    if (!up) throw new Error("sim server did not come up");

    const { getDb } = await import("../server/db");
    const db = await getDb();
    if (!db) throw new Error("getDb() returned null against PGlite");

    const baseUrl = `http://127.0.0.1:${port}`;

    const settle = async (minMs = 500, maxMs = 15000): Promise<void> => {
      const start = Date.now();
      let lastCount = -1;
      let quietSince = Date.now();
      while (Date.now() - start < maxMs) {
        const count = outbound.all().length;
        if (count !== lastCount) {
          lastCount = count;
          quietSince = Date.now();
        }
        const quietEnough = Date.now() - quietSince >= 300 && Date.now() - meta.lastActivityAt >= 300;
        if (Date.now() - start >= minMs && quietEnough) return;
        await new Promise((r) => setTimeout(r, 60));
      }
    };

    const waitFor = async (fn: () => boolean | Promise<boolean>, timeoutMs = 12000, label = "condition"): Promise<void> => {
      const start = Date.now();
      for (;;) {
        if (await fn()) return;
        if (Date.now() - start > timeoutMs) throw new Error(`waitFor timed out: ${label}`);
        await new Promise((r) => setTimeout(r, 75));
      }
    };

    const sign = (raw: string): string =>
      "sha256=" + crypto.createHmac("sha256", APP_SECRET).update(raw).digest("hex");

    const postWebhook = async (payload: Record<string, unknown>): Promise<number> => {
      const raw = JSON.stringify(payload);
      const res = await fetch(`${baseUrl}/api/webhooks/whatsapp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-hub-signature-256": sign(raw) },
        body: raw,
      });
      recorder.recordWebhook(payload);
      return res.status;
    };

    const world: World = {
      port,
      baseUrl,
      db,
      pg,
      async stop() {
        authServer.close();
        await pgServer.stop();
        await pg.close();
      },

      postWebhook,
      async inbound(payload) {
        const code = await postWebhook(payload);
        if (code !== 200) throw new Error(`webhook POST returned ${code}`);
        await settle();
      },
      async text(phone, text, opts = {}) {
        await world.inbound(payloads.inbound.text(PHONE_NUMBER_ID, phone, text, { profileName: opts.profileName, id: opts.id }));
      },
      async buttonReply(phone, replyId, title) {
        await world.inbound(payloads.inbound.buttonReply(PHONE_NUMBER_ID, phone, replyId, title));
      },
      async listReply(phone, replyId, title) {
        await world.inbound(payloads.inbound.listReply(PHONE_NUMBER_ID, phone, replyId, title));
      },
      async location(phone, lat, lng, name, address) {
        await world.inbound(payloads.inbound.location(PHONE_NUMBER_ID, phone, lat, lng, name, address));
      },
      async image(phone, mediaId, caption) {
        await world.inbound(payloads.inbound.image(PHONE_NUMBER_ID, phone, mediaId, caption));
      },
      async audio(phone, mediaId) {
        await world.inbound(payloads.inbound.audio(PHONE_NUMBER_ID, phone, mediaId));
      },
      async reaction(phone, messageId, emoji = "👍") {
        await world.inbound(payloads.inbound.reaction(PHONE_NUMBER_ID, phone, messageId, emoji));
      },
      async status(wamid, status, opts = {}) {
        const code = await postWebhook(payloads.statusEnvelope({
          phoneNumberId: PHONE_NUMBER_ID,
          statuses: [{ wamid, status, errors: opts.errors, recipientId: opts.recipientId }],
        }));
        if (code !== 200) throw new Error(`status webhook returned ${code}`);
        await settle(300);
      },
      async runCron(cronPath, body = {}) {
        const token = await new SignJWT({ openId: "cron_sim", appId: "sim-app", name: "Sim Cron" })
          .setProtectedHeader({ alg: "HS256", typ: "JWT" })
          .setExpirationTime(Math.floor(Date.now() / 1000) + 300)
          .sign(new TextEncoder().encode(JWT_SECRET_VALUE));
        const res = await fetch(`${baseUrl}${cronPath}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify(body),
        });
        const json = await res.json().catch(() => null);
        await settle(400);
        return { status: res.status, json };
      },
      async ussd(sessionId, phone, text) {
        const res = await fetch(`${baseUrl}/ussd`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ sessionId, serviceCode: USSD_SERVICE_CODE, phoneNumber: phone, text }).toString(),
        });
        await settle(300);
        const responseText = await res.text();
        recorder.ussd(sessionId, phone, text, responseText);
        return responseText;
      },
      async inboundFor(_phoneNumberId, payload) {
        await world.inbound(payload);
      },
      async supplierText(phone, text, opts = {}) {
        await world.inbound(payloads.inbound.text(SUPPLIER_PHONE_NUMBER_ID, phone, text, { profileName: opts.profileName }));
      },
      async supplierButtonReply(phone, replyId, title) {
        await world.inbound(payloads.inbound.buttonReply(SUPPLIER_PHONE_NUMBER_ID, phone, replyId, title));
      },
      async onboardingText(phone, text, opts = {}) {
        await world.inbound(payloads.inbound.text(ONBOARDING_PHONE_NUMBER_ID, phone, text, { profileName: opts.profileName, id: opts.id }));
      },
      async onboardingButtonReply(phone, replyId, title) {
        await world.inbound(payloads.inbound.buttonReply(ONBOARDING_PHONE_NUMBER_ID, phone, replyId, title));
      },
      settle,
      waitFor,

      async resetJourneyState() {
        // === W31 ar-invoices === wipe AR invoice tables + their payment
        // intents so J193–J196 never leak reminders/payments into each other.
        try {
          const schema = await import("../drizzle/schema");
          const { sql } = await import("drizzle-orm");
          await world.db.delete(schema.arInvoicePayments);
          await world.db.delete(schema.arInvoices);
          await world.db.execute(sql`DELETE FROM payment_intents WHERE metadata->>'kind' = 'ar_invoice_payment'`);
        } catch { /* W31 tables not migrated yet */ }
        // === END W31 ar-invoices ===
        // Restore seed stock so journeys never starve each other.
        try {
          const { products } = await import("../drizzle/schema");
          for (const p of Object.values(PRODUCTS)) {
            await world.db.update(products).set({ stockQuantity: p.stock }).where(eq(products.id, p.id));
          }
        } catch { /* world not seeded yet */ }
        // Wave 8 isolation: wipe PO/credit money movement and restore the
        // credit facility to its seed state so J31–J38 never leak into each
        // other (or into J01–J30, which never touch these tables).
        try {
          const schema = await import("../drizzle/schema");
          await world.db.delete(schema.poItems);
          await world.db.delete(schema.purchaseOrders);
          await world.db.delete(schema.creditLedger);
          await world.db
            .update(schema.creditAccounts)
            .set({
              limitCents: CREDIT_LIMIT_CENTS,
              outstandingCents: 0,
              termsDays: CREDIT_TERMS_DAYS,
              status: "active",
              // W13: order-access suspension + linked mandate must not leak
              // between journeys (dunning journeys suspend the seed account
              // at the +7d freeze; mandate journeys link payment_mandates).
              mandateId: null,
              suspended: false,
              suspendedAt: null,
              suspensionReason: null,
              updatedAt: new Date(),
            })
            .where(eq(schema.creditAccounts.id, CREDIT_ACCOUNT_ID));
        } catch { /* w8 tables not seeded yet */ }
        // === W27 Coder F: wipe wholesale/group-buy tables between journeys ===
        try {
          const schema = await import("../drizzle/schema");
          await world.db.delete(schema.groupDealParticipants);
          await world.db.delete(schema.groupDeals);
          await world.db.delete(schema.wholesaleOrders);
          await world.db.delete(schema.wholesaleListingTiers);
          await world.db.delete(schema.wholesaleListings);
        } catch { /* w27 tables not migrated yet */ }
        // === END W27 Coder F ===
        // === W28 medusa-storefront (Coder B): mappings, order links, synced
        // medusa products and the shared mock adapter never leak between
        // journeys (J158–J161). Platform-native seed products are untouched.
        try {
          const schema = await import("../drizzle/schema");
          const { sql: medusaSql } = await import("drizzle-orm");
          await world.db.delete(schema.medusaOrderLinks);
          await world.db.delete(schema.medusaStoreMappings);
          await world.db
            .delete(schema.products)
            .where(medusaSql`${schema.products.metadata}->>'source' = 'medusa'`);
          await world.db
            .delete(schema.tenantIntegrations)
            .where(eq(schema.tenantIntegrations.integrationType, "medusa"));
          const { mockMedusaAdapter } = await import("../server/services/medusa/adapter");
          mockMedusaAdapter.reset();
        } catch { /* w28 tables not migrated yet */ }
        // === END W28 medusa-storefront ===
        // === W31 scheduled-batch (Coder B): scheduled payments and batch
        // summaries never leak between journeys (J187–J190).
        try {
          const schema = await import("../drizzle/schema");
          await world.db.delete(schema.scheduledPayments);
          await world.db.delete(schema.paymentBatches);
        } catch { /* w31 tables not migrated yet */ }
        // === END W31 scheduled-batch ===
        // Wave 9 isolation: onboarding copilot sessions + the waOnboarding
        // in-memory pending-edit map never leak between journeys.
        try {
          const schema = await import("../drizzle/schema");
          await world.db.delete(schema.onboardingSessions);
        } catch { /* w9 tables not migrated yet */ }
        try {
          const { pendingEditProposals } = await import("../server/services/waOnboarding");
          pendingEditProposals.clear();
        } catch { /* waOnboarding unavailable */ }
        // Wave 10 isolation: observability ring buffer + error-webhook env
        // never leak between journeys.
        try {
          const { _resetRecentErrors } = await import("../server/services/observability");
          _resetRecentErrors();
        } catch { /* observability unavailable */ }
        // Wave 11 isolation: tenant provider-config rows created by J47–J52
        // (flutterwave/manual/stripe/custom chains) never leak between
        // journeys — restore the seed state (only the pgc-sim paystack row).
        try {
          const schema = await import("../drizzle/schema");
          const { ne } = await import("drizzle-orm");
          await world.db.delete(schema.paymentGatewayConfigs).where(ne(schema.paymentGatewayConfigs.id, "pgc-sim"));
        } catch { /* w11 configs not created yet */ }
        // Wave 12 isolation: SSO bindings, KYB applications/documents,
        // memberships, session revocations, marketplace sellers, BI rows and
        // ad-hoc tenants/credit accounts created by J53–J60 never leak
        // between journeys — restore the two-tenant seed world.
        try {
          const schema = await import("../drizzle/schema");
          const { ne, notInArray } = await import("drizzle-orm");
          await world.db.delete(schema.tenantSsoProfiles);
          await world.db.delete(schema.kycDocuments);
          await world.db.delete(schema.kycApplications);
          await world.db.delete(schema.tenantMemberships);
          await world.db.delete(schema.sessionRevocations);
          await world.db.delete(schema.marketplaceSellers);
          await world.db.delete(schema.churnPredictions);
          await world.db.delete(schema.cohortSnapshots);
          await world.db.delete(schema.temporalWorkflowRuns);
          // W13 isolation: mandate rows (FK → tenants) are cleared before
          // non-seed tenants are dropped.
          await world.db.delete(schema.paymentMandates);
          await world.db.delete(schema.creditLimitHistory);
          await world.db.delete(schema.creditAccounts).where(ne(schema.creditAccounts.id, CREDIT_ACCOUNT_ID));
          // Non-seed tenants (onboarding.start / KYB journeys) and their
          // supplier profiles are dropped; the two seeded tenants stay.
          await world.db.delete(schema.supplierProfiles).where(ne(schema.supplierProfiles.tenantId, SUPPLIER_TENANT_ID));
          await world.db.delete(schema.tenants).where(notInArray(schema.tenants.id, [TENANT_ID, SUPPLIER_TENANT_ID]));
          // === W30 auth-gates === the seed state now includes an APPROVED
          // KYB application for both seed tenants: the W30 KYB gate is a
          // hard precondition on money surfaces (createHold / withdrawal /
          // credit.accept), and the pre-W30 journeys exercise those rails
          // with the seed tenants. Journeys that need an UNVERIFIED tenant
          // (J174) create a fresh one.
          for (const tid of [TENANT_ID, SUPPLIER_TENANT_ID]) {
            await world.db.insert(schema.kycApplications).values({
              id: `kyb-seed-${tid}`,
              tenantId: tid,
              type: "kyb",
              status: "approved",
              applicantName: "Sim Owner",
              businessName: tid,
            }).onConflictDoNothing();
          }
          // === END W30 auth-gates ===
          // Supplier profile back to its seeded ACTIVE state (J59 may pause it).
          await world.db
            .update(schema.supplierProfiles)
            .set({ status: "active", moqCents: SUPPLIER_MOQ_CENTS })
            .where(eq(schema.supplierProfiles.tenantId, SUPPLIER_TENANT_ID));
          const { clearSessionCaches } = await import("../server/_core/sdk");
          clearSessionCaches();
          keycloakMock.reset();
        } catch { /* w12 tables not migrated yet */ }
        // Wave 14 isolation: bureau outbox rows, lender facilities and
        // provider/enforcement env created by J67–J72 never leak between
        // journeys. (Bureau rows reference account ids, not FKs, so order is
        // unconstrained; facilities are dropped after the W12 account wipe.)
        try {
          const schema = await import("../drizzle/schema");
          await world.db.delete(schema.bureauReportLog);
        } catch { /* w14 tables not migrated yet */ }
        try {
          const { creditFacilities } = await import("../server/services/creditFacilities/tables");
          await world.db.delete(creditFacilities);
        } catch { /* w14 tables not migrated yet */ }
        // === W27 bookkeeping === expense records + digest prefs/log never
        // leak between journeys (J131–J134).
        try {
          const schema = await import("../drizzle/schema");
          await world.db.delete(schema.bookkeepingDigestLog);
          await world.db.delete(schema.bookkeepingDigestPrefs);
          await world.db.delete(schema.expenses);
        } catch { /* w27 tables not migrated yet */ }
        // Wave 15 isolation: catalog-bootstrap drafts + ERP provisioning state
        // live in tenants.settings jsonb — strip them from the seed tenants;
        // drop ERP integration rows + memberships J76/J77 create (memberships
        // already wiped above; odoo/twenty rows are journey-owned).
        try {
          const schema = await import("../drizzle/schema");
          for (const tid of [TENANT_ID, SUPPLIER_TENANT_ID]) {
            const [t] = await world.db
              .select({ settings: schema.tenants.settings })
              .from(schema.tenants)
              .where(eq(schema.tenants.id, tid))
              .limit(1);
            const s = { ...((t?.settings ?? {}) as Record<string, any>) };
            if ("catalogDrafts" in s || "erpProvision" in s) {
              delete s.catalogDrafts;
              delete s.erpProvision;
              await world.db
                .update(schema.tenants)
                .set({ settings: s, updatedAt: new Date() })
                .where(eq(schema.tenants.id, tid));
            }
          }
        } catch { /* w15 settings keys absent */ }
        // Wave 16 isolation: Shopify connector / embedded signup / template
        // library / marketplace state all live in tenants.settings jsonb —
        // strip them from the seed tenants; drop Shopify-bridged orders and
        // their placeholder customers so no money/order rows leak; restore
        // the SHOPIFY_*/META_* env (and the read-once ENV mirror) plus the
        // injectable Shopify fetch and the 60s marketplace health cache.
        try {
          const schema = await import("../drizzle/schema");
          const { like } = await import("drizzle-orm");
          for (const tid of [TENANT_ID, SUPPLIER_TENANT_ID]) {
            const [t] = await world.db
              .select({ settings: schema.tenants.settings })
              .from(schema.tenants)
              .where(eq(schema.tenants.id, tid))
              .limit(1);
            const s = { ...((t?.settings ?? {}) as Record<string, any>) };
            if ("shopifyIntegration" in s || "embeddedSignup" in s || "waTemplateLibrary" in s || "marketplace" in s) {
              delete s.shopifyIntegration;
              delete s.embeddedSignup;
              delete s.waTemplateLibrary;
              delete s.marketplace;
              await world.db
                .update(schema.tenants)
                .set({ settings: s, updatedAt: new Date() })
                .where(eq(schema.tenants.id, tid));
            }
          }
          const bridged = await world.db
            .select({ id: schema.orders.id })
            .from(schema.orders)
            .where(like(schema.orders.orderNumber, "SHOPIFY-%"))
            .catch(() => [] as Array<{ id: string }>);
          for (const o of bridged) {
            await world.db.delete(schema.orderItems).where(eq(schema.orderItems.orderId, o.id)).catch(() => {});
            await world.db.delete(schema.orders).where(eq(schema.orders.id, o.id)).catch(() => {});
          }
          await world.db
            .delete(schema.customers)
            .where(like(schema.customers.whatsappPhone, "shopify-%"))
            .catch(() => {});
        } catch { /* w16 tables/keys absent */ }
        try {
          process.env.SHOPIFY_API_KEY = SHOPIFY_API_KEY_VALUE;
          process.env.SHOPIFY_API_SECRET = SHOPIFY_API_SECRET_VALUE;
          process.env.META_APP_ID = META_APP_ID_VALUE;
          process.env.META_APP_SECRET = META_APP_SECRET_VALUE;
          const { ENV } = await import("../server/_core/env");
          ENV.shopifyApiKey = SHOPIFY_API_KEY_VALUE;
          ENV.shopifyApiSecret = SHOPIFY_API_SECRET_VALUE;
          ENV.metaAppId = META_APP_ID_VALUE;
          ENV.metaAppSecret = META_APP_SECRET_VALUE;
        } catch { /* env module unavailable */ }
        try {
          const { resetShopifyFetch } = await import("../server/services/shopifyIntegration/client");
          resetShopifyFetch();
        } catch { /* shopify client unavailable */ }
        try {
          const { clearHealthCache } = await import("../server/services/marketplace");
          clearHealthCache();
        } catch { /* marketplace unavailable */ }
        try {
          const schema = await import("../drizzle/schema");
          await world.db.delete(schema.odooIntegrations);
          await world.db.delete(schema.twentyIntegrations);
        } catch { /* integration tables not present */ }
        // === W30 loans-credit (Coder A) isolation: funding-leg rows (FK
        // child of merchant_loans — delete BEFORE the loan wipe below) and
        // the platform funding facility (wiped by the W14 reset above) are
        // restored so J139–J141 + J162–J164 always exercise the real
        // funded-disbursement path with a deterministic commitment.
        try {
          const schema = await import("../drizzle/schema");
          await world.db.delete(schema.merchantLoanFunding);
          await world.db.delete(schema.creditFacilities);
          await world.db.insert(schema.creditFacilities).values({
            id: "f30f30f3-0000-4000-8000-000000000030",
            lenderName: "Sim Platform Lending SPV",
            facilityRef: "PLATFORM-MICROLOANS",
            commitmentCents: 1_000_000_000_00, // ₦1,000,000,000
            currency: "NGN",
            advanceRateBps: 10_000,
            status: "active",
          }).onConflictDoNothing();
        } catch { /* w30 tables not migrated yet */ }
        // === END W30 loans-credit ===
        // W27 credit isolation: merchant credit scores, micro-loans,
        // repayments and certificates created by J138–J141 never leak
        // between journeys (no FKs to tenants; delete order: repayments
        // before loans).
        try {
          const schema = await import("../drizzle/schema");
          await world.db.delete(schema.merchantLoanRepayments);
          await world.db.delete(schema.merchantLoans);
          await world.db.delete(schema.merchantCreditScores);
          await world.db.delete(schema.merchantCreditCertificates);
          // Wallet rails for non-seed (journey-created) merchants: J139–J141
          // disburse to / settle sales on a dedicated credit merchant wallet;
          // leftover escrow_release credits would be swept by later journeys.
          const { notInArray: notSeed } = await import("drizzle-orm");
          await world.db.delete(schema.walletTransactions)
            .where(notSeed(schema.walletTransactions.tenantId, [TENANT_ID, SUPPLIER_TENANT_ID]));
          await world.db.delete(schema.merchantWallets)
            .where(notSeed(schema.merchantWallets.tenantId, [TENANT_ID, SUPPLIER_TENANT_ID]));
        } catch { /* w27 tables not migrated yet */ }
        // === W28 odoo-sync (Coder A) isolation: outbox rows, configs and
        // mock-adapter state created by J154–J157 never leak between
        // journeys.
        try {
          const schema = await import("../drizzle/schema");
          await world.db.delete(schema.odooSyncOutbox);
          await world.db.delete(schema.odooConfigs);
        } catch { /* w28 tables not migrated yet */ }
        try {
          const { resetOdooAdapters } = await import("../server/services/odoo/adapter");
          resetOdooAdapters();
        } catch { /* odoo adapter unavailable */ }
        // === END W28 odoo-sync ===
        // === W31 vendor-bills (Coder A) isolation: bills + audit events
        // created by J183–J186 never leak between journeys.
        try {
          const schema = await import("../drizzle/schema");
          await world.db.delete(schema.vendorBillEvents);
          await world.db.delete(schema.vendorBills);
        } catch { /* w31 tables not migrated yet */ }
        // === END W31 vendor-bills ===
        delete process.env.CATALOG_EXTRACTION_PROVIDER;
        delete process.env.CATALOG_EXTRACTION_ENDPOINT;
        delete process.env.CATALOG_EXTRACTION_API_KEY;
        delete process.env.CATALOG_EXTRACTION_TIMEOUT_MS;
        delete process.env.BUREAU_PROVIDER;
        delete process.env.BUREAU_API_BASE;
        delete process.env.BUREAU_API_KEY;
        delete process.env.BUREAU_TIMEOUT_MS;
        delete process.env.CREDIT_ENFORCEMENT_STRICT;
        delete process.env.ERROR_WEBHOOK_URL;
        delete process.env.TEMPORAL_ADDRESS;
        delete process.env.KYC_GATE_DISABLED;
        // W13: journeys may re-enable the first-draw tenure gate (J65) —
        // restore the sim default (gate disabled) between journeys.
        process.env.CREDIT_TENURE_GATE_DAYS = "0";
        outbound.reset();
        llmMock.reset();
        openaiMock.reset();
        meta.sendFailures.length = 0;
        meta.failAllSendsStatus = null;
        delete process.env.OPENAI_API_KEY;
        const { __clearMemorySessions } = await import("../server/services/chatSession");
        __clearMemorySessions();
        const { __resetSessionWindowStoreForTests } = await import("../server/services/sessionWindow");
        __resetSessionWindowStoreForTests();
        const { __resetWindowFlagLedgerForTests } = await import("../server/services/sessionWindow");
        __resetWindowFlagLedgerForTests();
        const { __clearMemoryCartMarkers } = await import("../server/services/cartRecovery");
        __clearMemoryCartMarkers();
        const { __clearMemoryLocales } = await import("../server/services/i18n");
        __clearMemoryLocales();
      },
      newPhone(tag = "u") {
        return `234801${String(Math.floor(Math.random() * 90000000) + 10000000)}${tag.replace(/\D/g, "").slice(0, 1)}`.slice(0, 13);
      },
      async grantConsent(phone) {
        const { recordConsent } = await import("../server/services/consent");
        await recordConsent(db, { tenantId: TENANT_ID, phone, granted: true });
      },
      async tenantSettings() {
        const { tenants } = await import("../drizzle/schema");
        const [t] = await db.select({ settings: tenants.settings }).from(tenants).where(eq(tenants.id, TENANT_ID)).limit(1);
        return (t?.settings ?? {}) as Record<string, any>;
      },
      async patchTenantSettings(patch) {
        const { tenants } = await import("../drizzle/schema");
        const current = await world.tenantSettings();
        const next = { ...current, ...patch };
        await db.update(tenants).set({ settings: next, updatedAt: new Date() }).where(eq(tenants.id, TENANT_ID));
      },
      async backdate(sqlText, params = []) {
        return pg.query(sqlText, params);
      },

      llm: llmMock,
      openai: openaiMock,
      outbound,
      meta,
      keycloak: keycloakMock,
    };

    await seedWorld(world);
    return world;
  })();
  return booted;
}

// ── Seed ─────────────────────────────────────────────────────────────────────

async function seedWorld(world: World): Promise<void> {
  const schema = await import("../drizzle/schema");
  const db = world.db;

  await db.insert(schema.tenants).values({
    id: TENANT_ID,
    name: TENANT_NAME,
    slug: "sim-store",
    plan: "growth",
    status: "active",
    whatsappPhoneNumberId: PHONE_NUMBER_ID,
    whatsappBusinessAccountId: WABA_ID,
    defaultCurrency: "NGN",
    defaultLanguage: "en",
    settings: {
      plan: { tier: "growth", limits: { messagesPerMonth: 1_000_000, ordersPerMonth: 1_000_000 } },
      whatsapp: { accessToken: WA_ACCESS_TOKEN, wabaId: WABA_ID, displayPhone: DISPLAY_PHONE },
      adminPhone: ADMIN_PHONE,
      promos: [{ code: "SIM10", type: "percent", value: 10 }],
      faq: [
        { q: "What are your opening hours?", a: "We are open 8am to 8pm every day." },
        { q: "Do you deliver to Abuja?", a: "Yes — intercity delivery to Abuja takes 2 days." },
      ],
      commerce: {
        deliveryZones: [
          { zone: "same_city", label: "Lagos metro", etaMinutes: 45 },
          { zone: "intercity", label: "Intercity", etaMinutes: 2880 },
        ],
      },
      metaCatalog: { enabled: true, catalogId: CATALOG_ID, accessToken: "sim-catalog-token" },
      ctwa: {
        campaigns: [
          { id: "cmp-simdeal", keyword: "simdeal", label: "Sim Deal", action: "promo", reply: "🎉 You came via our Sim Deal campaign! Use code SIM10 for 10% off." },
        ],
      },
      broadcast: { templateName: "sim_broadcast", languageCode: "en_US", ratePerMin: 120 },
      inventory: { lowStockThreshold: 3 },
      ussd: { serviceCode: USSD_SERVICE_CODE },
      visualSearch: { enabled: true },
    },
  }).onConflictDoNothing();

  for (const p of Object.values(PRODUCTS)) {
    await db.insert(schema.products).values({
      id: p.id,
      tenantId: TENANT_ID,
      sku: p.sku,
      name: p.name,
      description: `${p.name} — simulation catalog item`,
      category: "sim",
      price: p.price,
      currency: "NGN",
      imageUrl: "imageUrl" in p ? (p as any).imageUrl : `https://cdn.sim.local/${p.id}.jpg`,
      status: "active",
      stockQuantity: p.stock,
      lowStockThreshold: 3,
    }).onConflictDoNothing();
  }

  // Active Paystack gateway so checkout creates real payment links (mocked).
  await db.insert(schema.paymentGatewayConfigs).values({
    id: "pgc-sim",
    tenantId: TENANT_ID,
    provider: "paystack",
    secretKey: "sk_sim_test",
    isActive: true,
  }).onConflictDoNothing();

  // Escrow config singleton (id 1) — custody pssp, no live bank.
  const [cfg] = await db.select().from(schema.escrowConfig).where(eq(schema.escrowConfig.id, 1)).limit(1);
  if (!cfg) {
    await db.insert(schema.escrowConfig).values({ id: 1, custodyMode: "pssp" });
  }

  // === W30 merge seam: KYB screening default in the SIM ===
  // D made KYB registry+sanctions screening default-ON in kyc.review
  // (V2#10, fail closed). The sim has no live registry/sanctions provider,
  // and pre-W30 journeys (J57–J69, J102) approve applications that carry no
  // registry fields. Use the explicit NON-PROD escape hatch so those
  // approve-flow journeys behave as before; the fail-closed semantics are
  // covered by unit tests (kycKybWiring/sanctions) and the KYB money gates
  // by J174/J177 via requireApprovedKyb (a separate flag).
  process.env.KYB_SCREENING_DISABLED ??= "true";
  // === END W30 merge seam ===

  // === W30 loans-credit (Coder A) ===
  // Platform wholesale facility funding the micro-loan book (verify-v1 #12):
  // every disbursement now atomically decrements credit_facilities
  // .commitment_cents (insufficient → honest rejection) and posts the
  // TigerBeetle funding leg. Seed one deterministic lender facility so the
  // loan journeys (J139–J141, J162–J164) exercise the real funding path.
  try {
    await db.insert(schema.creditFacilities).values({
      id: "f30f30f3-0000-4000-8000-000000000030",
      lenderName: "Sim Platform Lending SPV",
      facilityRef: "PLATFORM-MICROLOANS",
      commitmentCents: 1_000_000_000_00, // ₦1,000,000,000
      currency: "NGN",
      advanceRateBps: 10_000,
      status: "active",
    }).onConflictDoNothing();
  } catch { /* w30 table not migrated yet */ }
  // === END W30 loans-credit ===

  // ── Wave 8: supplier tenant + B2B network ────────────────────────────────
  await db.insert(schema.tenants).values({
    id: SUPPLIER_TENANT_ID,
    name: SUPPLIER_NAME,
    slug: "sim-supplier",
    plan: "growth",
    status: "active",
    whatsappPhoneNumberId: SUPPLIER_PHONE_NUMBER_ID,
    whatsappBusinessAccountId: SUPPLIER_WABA_ID,
    defaultCurrency: "NGN",
    defaultLanguage: "en",
    settings: {
      plan: { tier: "growth", limits: { messagesPerMonth: 1_000_000, ordersPerMonth: 1_000_000 } },
      whatsapp: { accessToken: WA_ACCESS_TOKEN, wabaId: SUPPLIER_WABA_ID, displayPhone: SUPPLIER_DISPLAY_PHONE },
      adminPhone: SUPPLIER_ADMIN_PHONE,
    },
  }).onConflictDoNothing();

  // ACTIVE supplier profile: MOQ ₦1,000, 5d lead time, terms 7/14/30, no
  // auto-approve threshold (every PO goes through the approval card).
  await db.insert(schema.supplierProfiles).values({
    tenantId: SUPPLIER_TENANT_ID,
    moqCents: SUPPLIER_MOQ_CENTS,
    leadTimeDays: 5,
    termsOffered: [7, 14, 30],
    defaultTermsDays: CREDIT_TERMS_DAYS,
    autoApproveBelowCents: null,
    categories: ["plastics", "packaging"],
    status: "active",
  }).onConflictDoNothing();

  // Wholesale products: preforms have a wholesale tier (min 100 @ ₦40),
  // crates sell at the retail price with no minimum.
  for (const p of Object.values(SUPPLIER_PRODUCTS)) {
    await db.insert(schema.products).values({
      id: p.id,
      tenantId: SUPPLIER_TENANT_ID,
      sku: p.sku,
      name: p.name,
      description: `${p.name} — simulation wholesale item`,
      category: "plastics",
      price: p.price,
      currency: "NGN",
      imageUrl: `https://cdn.sim.local/${p.id}.jpg`,
      status: "active",
      stockQuantity: p.stock,
      lowStockThreshold: 3,
    }).onConflictDoNothing();
    if (p.wholesalePrice) {
      await db.insert(schema.wholesalePriceTiers).values({
        id: `wtier-${p.id}`,
        tenantId: SUPPLIER_TENANT_ID,
        productId: p.id,
        buyerType: "wholesale",
        minQuantity: p.minQty,
        unitPrice: p.wholesalePrice,
        currency: "NGN",
      }).onConflictDoNothing();
    }
  }

  // Trade credit facility: supplier → buyer (Simply Green/sim tenant),
  // ₦500,000 limit, net-14. Draws/repayments mutate outstandingCents;
  // resetJourneyState restores this seed between journeys.
  await db.insert(schema.creditAccounts).values({
    id: CREDIT_ACCOUNT_ID,
    supplierTenantId: SUPPLIER_TENANT_ID,
    buyerTenantId: TENANT_ID,
    limitCents: CREDIT_LIMIT_CENTS,
    outstandingCents: 0,
    termsDays: CREDIT_TERMS_DAYS,
    status: "active",
  }).onConflictDoNothing();

  // Baseline Meta mock state.
  const { setQuality, setTemplates, registerGraphObject } = await import("./metaMock");
  setQuality(PHONE_NUMBER_ID, "GREEN", "TIER_10K");
  // Wave 9: onboarding validation (runTenantValidation) does live GET /{id}
  // lookups for the tenant phone number + WABA — register both seeded tenants'
  // ids as readable Graph objects.
  for (const id of [PHONE_NUMBER_ID, WABA_ID, SUPPLIER_PHONE_NUMBER_ID, SUPPLIER_WABA_ID]) {
    registerGraphObject(id);
  }
  setTemplates(WABA_ID, [
    {
      id: "tpl-approved-1",
      name: "sim_broadcast",
      category: "UTILITY",
      language: "en_US",
      status: "APPROVED",
      components: [{ type: "BODY", text: "Hello {{1}}, {{2}}" }],
    },
    {
      id: "tpl-pending-1",
      name: "sim_promo_blast",
      category: "MARKETING",
      language: "en_US",
      status: "PENDING",
      components: [{ type: "BODY", text: "Promo for {{1}}" }],
    },
  ]);
}

// ── Assertion helpers (shared by all journeys) ───────────────────────────────

export class AssertionError extends Error {}

export function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new AssertionError(message);
}

export function assertIncludes(haystack: string | undefined | null, needle: string, label: string): void {
  assert(typeof haystack === "string" && haystack.includes(needle), `${label}: expected ${JSON.stringify(haystack?.slice(0, 300))} to include ${JSON.stringify(needle)}`);
}

export function bodyText(call: { body: any } | undefined): string {
  const b = call?.body;
  if (!b) return "";
  if (b.text?.body) return String(b.text.body);
  if (b.interactive?.body?.text) return String(b.interactive.body.text);
  if (b.image?.caption) return String(b.image.caption);
  if (b.template) return `template:${b.template.name}`;
  return JSON.stringify(b);
}

// Common DB fetch helpers used across journeys.
export async function latestOrderForPhone(world: World, phone: string): Promise<any | null> {
  const schema = await import("../drizzle/schema");
  const rows = await world.db
    .select()
    .from(schema.orders)
    .where(and(eq(schema.orders.tenantId, TENANT_ID), eq(schema.orders.customerId, phone)))
    .orderBy(desc(schema.orders.createdAt))
    .limit(1)
    .catch(() => []);
  return rows?.[0] ?? null;
}

export async function orderById(world: World, id: string): Promise<any | null> {
  const schema = await import("../drizzle/schema");
  const [o] = await world.db.select().from(schema.orders).where(eq(schema.orders.id, id)).limit(1).catch(() => []);
  return o ?? null;
}

export async function notifLogRows(world: World, phone: string): Promise<any[]> {
  const schema = await import("../drizzle/schema");
  return world.db
    .select()
    .from(schema.whatsappNotificationLog)
    .where(eq(schema.whatsappNotificationLog.phone, phone))
    .orderBy(desc(schema.whatsappNotificationLog.createdAt))
    .catch(() => []);
}
