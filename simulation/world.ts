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
import { fileURLToPath } from "url";
import { SignJWT } from "jose";
import { and, eq, desc } from "drizzle-orm";

import { installFetchMock, meta, llm as llmMock, openai as openaiMock, outbound } from "./metaMock";
import * as payloads from "./payloads";

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
  jollof: { id: "p-jollof", sku: "SIM-JOLLOF", name: "Jollof Rice", price: "2500.00", stock: 10 },
  chicken: { id: "p-chicken", sku: "SIM-CHICKEN", name: "Grilled Chicken", price: "3000.00", stock: 5 },
  lastUnit: { id: "p-lastunit", sku: "SIM-LAST", name: "Last Unit Special", price: "1000.00", stock: 1 },
  soldOut: { id: "p-soldout", sku: "SIM-OOS", name: "Sold Out Sneakers", price: "15000.00", stock: 0 },
  ankara: {
    id: "p-ankara", sku: "SIM-ANKARA", name: "Ankara Fabric", price: "5000.00", stock: 8,
    imageUrl: "https://cdn.sim.local/ankara.jpg",
  },
  restock: { id: "p-restock", sku: "SIM-RESTOCK", name: "Restock Widget", price: "750.00", stock: 0 },
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

/** Mock Keycloak/auth server: answers GetUserInfoWithJwt for cron auth. */
async function startAuthMock(port: number): Promise<http.Server> {
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.method === "POST" && (req.url ?? "").includes("GetUserInfoWithJwt")) {
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

    // 2. Fetch interceptor BEFORE any server module can fire a request.
    installFetchMock();

    // 3. Embedded Postgres (PGlite) + socket server + migrations.
    const { PGlite } = await import("@electric-sql/pglite");
    const { PGLiteSocketServer } = await import("@electric-sql/pglite-socket");
    const pg = new PGlite();
    await pg.waitReady;
    const migDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../drizzle");
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
        return res.text();
      },
      settle,
      waitFor,

      async resetJourneyState() {
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

  // Baseline Meta mock state.
  const { setQuality, setTemplates } = await import("./metaMock");
  setQuality(PHONE_NUMBER_ID, "GREEN", "TIER_10K");
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
