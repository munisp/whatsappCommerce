/**
 * Platform admin home and shop directory (ui/platform-admin).
 *
 *   overview  — the numbers a platform owner checks first, what needs them,
 *               and what just happened
 *   shops     — every shop with what matters about it: setup state, how it
 *               reaches customers on WhatsApp, verification, products, orders
 *
 * Admin only. Read-only.
 */
import { sql } from "drizzle-orm";
import { z } from "zod";
import { router, adminProcedure } from "../_core/trpc";
import { getDb } from "../db";

type Row = Record<string, any>;

// The platform's in-cluster services and the port each listens on.
const SERVICES: Record<string, number> = {
  "ai-agent": 8090, "commerce-engine": 8083, "conversation-orchestrator": 8082, "event-gateway": 8002, "event-processor": 8091,
  "fluvio-consumer": 8098, gateway: 8080, "hermes-bridge": 8095, "hermes-router": 8096, "ledger-bridge": 8095, "ml-stack": 8099,
  "payment-orchestrator": 8084, "recon-worker": 8096, "webhook-ingestor": 8081,
};

/** GET /health on each service, in parallel, 2.5 s each. */
async function probeServices() {
  const checkedAt = new Date().toISOString();
  return Promise.all(Object.entries(SERVICES).map(async ([name, port]) => {
    const started = Date.now();
    try {
      const res = await fetch(`http://${name}:${port}/health`, { signal: AbortSignal.timeout(2500) });
      return { name, status: res.ok ? "healthy" : "degraded", latencyMs: Date.now() - started, detail: res.ok ? null : `HTTP ${res.status}`, checkedAt };
    } catch (e: any) {
      const timedOut = e?.name === "TimeoutError" || /abort/i.test(String(e?.message));
      return { name, status: "down", latencyMs: null, detail: timedOut ? "no answer within 2.5 s" : String(e?.cause?.code ?? e?.message ?? "unreachable"), checkedAt };
    }
  }));
}
const num = (v: unknown) => Number(v ?? 0) || 0;

/** A shop's setup state as people say it. */
function setupState(status: string, onboarding: string | null): "live" | "setting_up" | "failed" | "suspended" | "trial" {
  if (status === "suspended" || status === "churned") return "suspended";
  if (onboarding === "live" && status === "active") return "live";
  if (onboarding === "failed") return "failed";
  if (onboarding && onboarding !== "live") return "setting_up";
  return status === "active" ? "setting_up" : "trial";
}

async function shopRows(db: any): Promise<Row[]> {
  return (await db.execute(sql`
    SELECT t.id, t.name, t.slug, t.status::text AS status, t.plan::text AS plan, t."createdAt" AS created_at,
           t.settings->'onboarding'->>'status' AS onboarding,
           t.settings->'onboarding'->'reasons' AS onboarding_reasons,
           t."whatsappPhoneNumberId" IS NOT NULL AS own_number,
           (SELECT k.status::text FROM kyc_applications k WHERE k."tenantId" = t.id AND k.type = 'kyb' ORDER BY k."createdAt" DESC LIMIT 1) AS kyb,
           EXISTS (SELECT 1 FROM merchant_locations ml WHERE ml.tenant_id = t.id) AS has_location,
           (SELECT count(*) FROM products p WHERE p."tenantId" = t.id AND p.status = 'active') AS products,
           (SELECT count(*) FROM products p WHERE p."tenantId" = t.id AND p.status = 'active' AND coalesce(p."imageUrl", '') = '') AS products_without_photo,
           (SELECT count(*) FROM orders o WHERE o."tenantId" = t.id) AS orders,
           (SELECT max(o."createdAt") FROM orders o WHERE o."tenantId" = t.id) AS last_order_at
    FROM tenants t
    ORDER BY t."createdAt" DESC
  `)) as Row[];
}

function toShop(r: Row) {
  return {
    id: String(r.id), name: String(r.name ?? ""), slug: String(r.slug ?? ""), status: String(r.status ?? ""), plan: r.plan ?? null,
    createdAt: r.created_at, state: setupState(String(r.status ?? ""), r.onboarding ?? null),
    setupProblems: Array.isArray(r.onboarding_reasons) ? (r.onboarding_reasons as string[]) : [],
    whatsapp: r.own_number ? ("own" as const) : ("shared" as const),
    verification: (r.kyb ?? "not_started") as string,
    hasLocation: !!r.has_location,
    products: num(r.products), productsWithoutPhoto: num(r.products_without_photo),
    orders: num(r.orders), lastOrderAt: r.last_order_at ?? null,
  };
}

export const platformOverviewRouter = router({
  /**
   * Everyone who signs in through Keycloak (owners, staff, admins), with their
   * shop. The old tenant_sso_profiles table is only written by a retired
   * shop-portal sign-in screen, so it stayed empty.
   */
  signInAccounts: adminProcedure
    .input(z.object({ search: z.string().max(100).optional() }).optional())
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return { profiles: [] };
      const q = input?.search?.trim().toLowerCase() ?? "";
      const rows = (await db.execute(sql`
        SELECT u.id, u.email, u.name, u.role::text AS role, u."tenantId" AS tenant_id, t.name AS tenant_name,
               u."createdAt" AS created_at, u."lastSignedIn" AS last_signed_in
        FROM users u LEFT JOIN tenants t ON t.id::text = u."tenantId"::text
        WHERE u."loginMethod" = 'keycloak'
          AND (${q} = '' OR lower(coalesce(u.email,'')) LIKE ${"%" + q + "%"} OR lower(coalesce(u.name,'')) LIKE ${"%" + q + "%"} OR lower(coalesce(t.name,'')) LIKE ${"%" + q + "%"})
        ORDER BY u."lastSignedIn" DESC NULLS LAST LIMIT 200
      `)) as Row[];
      return {
        profiles: rows.map((r) => ({
          id: String(r.id), tenantId: r.tenant_id ?? null, tenantName: r.tenant_name ?? null,
          ssoEmail: r.email ?? null, ssoName: r.name ?? null, ssoProvider: "keycloak", role: String(r.role ?? "user"),
          firstSsoLoginAt: r.created_at ?? null, lastSsoLoginAt: r.last_signed_in ?? null,
        })),
      };
    }),

  /**
   * AI assistant activity across every shop, and the backing services'
   * health probed live (the old service_health table was a seed nobody
   * updated). Intent names come straight from agent_events.
   */
  agent: adminProcedure
    .input(z.object({ days: z.number().int().min(1).max(365).default(30) }).optional())
    .query(async ({ input }) => {
      const db = await getDb();
      const days = input?.days ?? 30;
      const empty = { totals: { interactions: 0, escalated: 0, avgLatencyMs: 0, shops: 0 }, intents: [] as { intent: string; count: number; share: number }[], services: [] as any[] };
      if (!db) return empty;
      const [t] = (await db.execute(sql`
        SELECT count(*) AS n, count(*) FILTER (WHERE escalated) AS esc, coalesce(avg("latencyMs"), 0) AS lat, count(DISTINCT "tenantId") AS shops
        FROM agent_events WHERE "createdAt" >= now() - make_interval(days => ${days})
      `)) as Row[];
      const intents = (await db.execute(sql`
        SELECT coalesce(nullif("intentType", ''), 'unknown') AS intent, count(*) AS n
        FROM agent_events WHERE "createdAt" >= now() - make_interval(days => ${days})
        GROUP BY 1 ORDER BY 2 DESC LIMIT 12
      `)) as Row[];
      const total = num(t?.n);
      const services = await probeServices();
      return {
        totals: { interactions: total, escalated: num(t?.esc), avgLatencyMs: Math.round(num(t?.lat)), shops: num(t?.shops) },
        intents: intents.map((r) => ({ intent: String(r.intent), count: num(r.n), share: total ? num(r.n) / total : 0 })),
        services,
      };
    }),

  shops: adminProcedure.query(async () => {
    const db = await getDb();
    if (!db) return [];
    return (await shopRows(db)).map(toShop);
  }),

  overview: adminProcedure.query(async () => {
    const db = await getDb();
    if (!db) return null;
    const shops = (await shopRows(db)).map(toShop);
    const count = (s: string) => shops.filter((x) => x.state === s).length;

    const [orders] = (await db.execute(sql`
      SELECT count(*) FILTER (WHERE "createdAt" >= now() - interval '7 days') AS orders_7d,
             count(*) FILTER (WHERE "createdAt" >= date_trunc('day', now())) AS orders_today,
             coalesce(sum("totalAmount"::numeric) FILTER (WHERE "createdAt" >= now() - interval '7 days' AND "paymentStatus" = 'completed' AND currency = 'NGN'), 0) AS paid_ngn_7d,
             count(*) FILTER (WHERE "createdAt" >= now() - interval '7 days' AND "paymentStatus" = 'completed') AS paid_7d
      FROM orders
    `)) as Row[];
    const [msgs] = (await db.execute(sql`
      SELECT count(*) FILTER (WHERE status IN ('sent', 'delivered', 'read')) AS sent,
             count(*) FILTER (WHERE status = 'failed') AS failed
      FROM whatsapp_notification_log WHERE "createdAt" >= now() - interval '24 hours'
    `)) as Row[];
    const [inbound] = (await db.execute(sql`
      SELECT count(*) AS received FROM channel_messages
      WHERE direction = 'inbound' AND "createdAt" >= now() - interval '24 hours'
    `).catch(() => [{ received: 0 }])) as Row[];
    const kybQueue = (await db.execute(sql`
      SELECT k."tenantId" AS tenant_id, t.name, k.status::text AS status, k."createdAt" AS at
      FROM kyc_applications k JOIN tenants t ON t.id = k."tenantId"
      WHERE k.type = 'kyb' AND k.status IN ('pending', 'under_review', 'appealed')
      ORDER BY k."createdAt" ASC LIMIT 20
    `)) as Row[];
    const recentOrders = (await db.execute(sql`
      SELECT o.id, o."orderNumber" AS number, o."totalAmount" AS total, o.currency, o.status::text AS status,
             o."paymentStatus"::text AS payment, o."createdAt" AS at, t.name AS shop, t.id AS tenant_id
      FROM orders o JOIN tenants t ON t.id = o."tenantId"
      ORDER BY o."createdAt" DESC LIMIT 8
    `)) as Row[];

    // What a platform owner should act on, most important first.
    const attention: Array<{ kind: string; severity: "high" | "medium" | "low"; tenantId?: string; shop?: string; title: string; detail: string; action?: string }> = [];
    for (const k of kybQueue) {
      attention.push({ kind: "verification", severity: "high", tenantId: String(k.tenant_id), shop: String(k.name),
        title: `${k.name} is waiting for verification`, detail: `Submitted ${new Date(k.at).toDateString()}. The shop can't take orders until it's approved.`, action: "/kyb-review" });
    }
    for (const s of shops.filter((x) => x.state === "failed")) {
      attention.push({ kind: "setup_failed", severity: "high", tenantId: s.id, shop: s.name, title: `${s.name} failed setup`,
        detail: s.setupProblems.length ? s.setupProblems.join("; ") : "Its setup checks didn't pass.", action: `/tenants/${s.id}` });
    }
    for (const s of shops.filter((x) => x.state === "live")) {
      if (s.products === 0) attention.push({ kind: "no_products", severity: "medium", tenantId: s.id, shop: s.name, title: `${s.name} is live with no products`, detail: "Customers who reach it have nothing to buy.", action: `/tenants/${s.id}` });
      if (s.whatsapp === "shared" && !s.hasLocation) attention.push({ kind: "no_location", severity: "medium", tenantId: s.id, shop: s.name, title: `${s.name} has no map location`, detail: "It never shows up when customers search for shops near them on WhatsApp.", action: `/tenants/${s.id}` });
      if (s.whatsapp === "shared" && s.hasLocation && s.verification !== "approved") attention.push({ kind: "not_discoverable", severity: "low", tenantId: s.id, shop: s.name, title: `${s.name} isn't verified`, detail: "Unverified shops are left out of nearby search on the shared number.", action: "/kyb-review" });
      if (s.products > 0 && s.productsWithoutPhoto === s.products) attention.push({ kind: "no_photos", severity: "low", tenantId: s.id, shop: s.name, title: `${s.name} has no product photos`, detail: `${s.products} product${s.products === 1 ? "" : "s"}, none with a photo — WhatsApp product cards show text only.`, action: `/tenants/${s.id}` });
    }
    const order = { high: 0, medium: 1, low: 2 } as const;
    attention.sort((a, b) => order[a.severity] - order[b.severity]);

    return {
      shops: { total: shops.length, live: count("live"), settingUp: count("setting_up") + count("trial"), failed: count("failed"), suspended: count("suspended") },
      orders: { today: num(orders?.orders_today), last7d: num(orders?.orders_7d), paid7d: num(orders?.paid_7d), paidNgn7d: num(orders?.paid_ngn_7d) },
      messages: { sent24h: num(msgs?.sent), failed24h: num(msgs?.failed), received24h: num(inbound?.received) },
      verificationQueue: kybQueue.length,
      attention: attention.slice(0, 30),
      recentOrders: recentOrders.map((o) => ({ id: String(o.id), number: o.number, total: num(o.total), currency: o.currency, status: o.status, payment: o.payment, at: o.at, shop: o.shop, tenantId: String(o.tenant_id) })),
      newestShops: shops.slice(0, 6),
    };
  }),
});
