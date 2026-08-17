/**
 * shopifyIntegration/webhook.ts — express handlers for Shopify webhooks and
 * the OAuth redirect callback. Mounted ADDITIVELY in server/_core/index.ts:
 *
 *   GET  /api/shopify/callback      — OAuth redirect (code/shop/state)
 *   POST /api/webhooks/shopify      — HMAC-verified Shopify webhooks
 *                                     (orders/create, app/uninstalled)
 *
 * Security: X-Shopify-Hmac-Sha256 is verified against the RAW body with the
 * app secret, timing-safe, BEFORE any payload processing. Fail-closed in
 * production-like envs when SHOPIFY_API_SECRET is unset.
 */
import type { Request, Response } from "express";
import { ENV, isProd } from "../../_core/env";
import { verifyShopifyWebhookHmac } from "./security";
import { bridgeShopifyOrder, type ShopifyOrderPayload } from "./orderBridge";
import { uninstallShopify } from "./oauth";

function toRawBody(body: unknown): Buffer {
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === "string") return Buffer.from(body, "utf8");
  return Buffer.from(JSON.stringify(body ?? {}), "utf8");
}

function resolveTenantId(req: Request): string | null {
  const q = req.query.t;
  if (typeof q === "string" && q) return q;
  const h = req.headers["x-tenant-id"];
  if (typeof h === "string" && h) return h;
  return null;
}

/** GET /api/shopify/callback — OAuth redirect from Shopify. */
export async function handleShopifyOAuthCallbackExpress(req: Request, res: Response): Promise<void> {
  const { handleOAuthCallback } = await import("./oauth");
  const shop = typeof req.query.shop === "string" ? req.query.shop : "";
  const code = typeof req.query.code === "string" ? req.query.code : "";
  const state = typeof req.query.state === "string" ? req.query.state : "";
  if (!shop || !code || !state) {
    res.status(400).json({ error: "missing shop/code/state" });
    return;
  }
  const result = await handleOAuthCallback({ shop, code, state });
  if (!result.ok) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json({ ok: true, tenantId: result.tenantId, shop: result.shop });
}

/**
 * POST /api/webhooks/shopify?t=<tenantId>
 * Topics: orders/create (bridged), app/uninstalled (connection cleared).
 */
export async function handleShopifyWebhookExpress(req: Request, res: Response): Promise<void> {
  try {
    const rawBody = toRawBody(req.body);
    // Fail CLOSED when the app secret is unset in production-like envs.
    if (!ENV.shopifyApiSecret) {
      if (isProd) {
        res.status(503).json({ error: "webhook-secret-not-configured", secret: "SHOPIFY_API_SECRET" });
        return;
      }
      console.warn("[shopify-webhook] SHOPIFY_API_SECRET unset — skipping HMAC verification (non-production)");
    } else {
      const hmac = req.headers["x-shopify-hmac-sha256"];
      const header = Array.isArray(hmac) ? hmac[0] : hmac;
      if (!verifyShopifyWebhookHmac(rawBody, ENV.shopifyApiSecret, header)) {
        console.warn("[shopify-webhook] invalid HMAC — rejected before processing");
        res.status(401).json({ error: "invalid-signature" });
        return;
      }
    }
    const tenantId = resolveTenantId(req);
    if (!tenantId) {
      res.status(400).json({ error: "missing tenant (t query param or X-Tenant-Id header)" });
      return;
    }
    const topicHeader = req.headers["x-shopify-topic"];
    const topic = Array.isArray(topicHeader) ? topicHeader[0] : topicHeader ?? "";
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody.toString());
    } catch {
      res.status(400).json({ error: "malformed-json" });
      return;
    }

    if (topic === "orders/create") {
      const result = await bridgeShopifyOrder(tenantId, payload as ShopifyOrderPayload);
      if (result.action === "failed") {
        // 500 → Shopify retries; dedupe by order id makes retries safe.
        res.status(500).json({ error: result.error });
        return;
      }
      res.status(200).json({ received: true, ...result });
      return;
    }
    if (topic === "app/uninstalled") {
      const result = await uninstallShopify(tenantId);
      res.status(200).json({ received: true, ...result });
      return;
    }
    // Unknown/unsupported topics are acknowledged (200) so Shopify does not
    // retry them forever.
    res.status(200).json({ received: true, topic, handled: false });
  } catch (err: any) {
    console.error("[shopify-webhook]", err?.message ?? err);
    res.status(500).json({ error: err?.message ?? "internal error" });
  }
}
