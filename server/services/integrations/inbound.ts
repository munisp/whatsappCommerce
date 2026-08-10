/**
 * server/services/integrations/inbound.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Inbound webhooks from Medusa / Twenty CRM / Odoo:
 *
 *   POST /integrations/:system/webhook?t=<tenantId>   (or X-Tenant-Id header)
 *
 * Security: HMAC-SHA256 over the raw body against the per-tenant
 * `settings.integrations.<system>.webhookSecret`, compared with
 * crypto.timingSafeEqual. Verification is FAIL-CLOSED: when the tenant has a
 * secret configured, a missing/invalid signature is rejected (401); when no
 * secret is configured the request is rejected outright in production (503)
 * and only allowed through (with a loud warning) in dev/test.
 *
 * Every accepted payload is recorded in integration_events (direction='in')
 * for audit, then applied to local tables. Inbound-applied writes NEVER
 * enqueue outbound events (loop guard — see outbox.enqueueIntegrationEvent),
 * and recorded inbound payloads carry origin='external'.
 */

import crypto from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { customers, integrationEvents, products, tenants } from "../../../drizzle/schema";
import type { IntegrationConfig, IntegrationSystem } from "./clients";
import { INTEGRATION_SYSTEMS } from "./clients";
import { decryptSecret } from "../crypto/secrets";
import { triggerRestockNotification } from "../waitlist";
import { captureException } from "../observability";

export const SIGNATURE_HEADER = "x-integration-signature";
export const TENANT_HEADER = "x-tenant-id";

/** Length-guarded constant-time string comparison. */
function timingSafeEqualStr(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/** Constant-time HMAC-SHA256 verification of a raw request body. */
export function verifyIntegrationSignature(
  rawBody: Buffer,
  secret: string,
  signature: string | null | undefined,
): boolean {
  if (!signature) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const provided = signature.startsWith("sha256=") ? signature.slice("sha256=".length) : signature;
  return timingSafeEqualStr(provided, expected);
}

export function signForTest(rawBody: Buffer | string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
}

export interface WebhookResult {
  status: number;
  body: Record<string, unknown>;
}

export interface WebhookDeps {
  db: any;
  /** fail-closed flag (production); injected so tests can force it. */
  isProduction: boolean;
}

/** Load per-tenant config for the given system. */
export async function loadTenantIntegrationConfig(
  db: any,
  tenantId: string,
  system: IntegrationSystem,
): Promise<IntegrationConfig | null> {
  const [tenant] = await db
    .select({ settings: tenants.settings })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  if (!tenant) return null;
  const cfg = ((tenant.settings as any)?.integrations?.[system] ?? null) as IntegrationConfig | null;
  if (!cfg) return null;
  // webhookSecret is stored encrypted (v1:) since w10 — decrypt for HMAC
  // verification; decryptSecret passes legacy plaintext through unchanged.
  return {
    ...cfg,
    ...(typeof cfg.webhookSecret === "string" && cfg.webhookSecret
      ? { webhookSecret: decryptSecret(cfg.webhookSecret) }
      : {}),
  };
}

/**
 * Framework-agnostic webhook handler: verifies the signature, records the
 * inbound event and applies the payload. Returns {status, body} — the express
 * adapter in server/_core/index.ts translates it to res.
 */
export async function handleIntegrationWebhook(
  system: string,
  tenantId: string | null | undefined,
  rawBody: Buffer,
  signature: string | null | undefined,
  deps: WebhookDeps,
): Promise<WebhookResult> {
  if (!INTEGRATION_SYSTEMS.includes(system as IntegrationSystem)) {
    return { status: 400, body: { error: "unknown-system", system } };
  }
  if (!tenantId) {
    return { status: 400, body: { error: "tenant-required" } };
  }
  const { db } = deps;

  const config = await loadTenantIntegrationConfig(db, tenantId, system as IntegrationSystem);
  if (!config) {
    return { status: 404, body: { error: "integration-not-configured", system } };
  }

  // ── Signature verification (fail closed) ──────────────────────────────────
  if (config.webhookSecret) {
    if (!verifyIntegrationSignature(rawBody, config.webhookSecret, signature)) {
      console.warn(`[integrations-webhook] ${system} tenant=${tenantId}: invalid signature — rejected`);
      captureException(new Error("invalid inbound webhook signature"), {
        service: "integrations/inbound",
        operation: "verifySignature",
        tenantId,
        severity: "warn",
        extra: { system },
      });
      return { status: 401, body: { error: "invalid-signature" } };
    }
  } else if (deps.isProduction) {
    console.error(
      `[integrations-webhook] ${system} tenant=${tenantId}: webhookSecret not configured — refusing request (fail closed)`,
    );
    return { status: 503, body: { error: "webhook-secret-not-configured", system } };
  } else {
    console.warn(`[integrations-webhook] ${system} tenant=${tenantId}: no webhookSecret — skipping verification (non-production)`);
  }

  let payload: any;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return { status: 400, body: { error: "invalid-json" } };
  }

  const entity = String(payload.entity ?? payload.object ?? "unknown");
  const action = String(payload.action ?? payload.event ?? "updated");

  // ── Record the inbound event (audit trail; origin='external') ────────────
  const entityId = String(payload.data?.id ?? payload.id ?? payload.data?.product_id ?? "");
  await db.insert(integrationEvents).values({
    tenantId,
    system,
    direction: "in",
    entity,
    entityId: entityId || null,
    payload: { action, origin: "external", data: payload.data ?? payload },
    status: "delivered",
    attempts: 0,
    processedAt: new Date(),
  });

  // ── Apply the change locally — direct writes, NO outbound re-enqueue ─────
  try {
    const applied = await applyInboundEvent(db, {
      tenantId,
      system: system as IntegrationSystem,
      entity,
      action,
      data: (payload.data ?? payload) as Record<string, unknown>,
    });
    return { status: 200, body: { ok: true, applied } };
  } catch (err: any) {
    console.error(`[integrations-webhook] ${system} tenant=${tenantId} apply failed:`, err?.message);
    captureException(err, {
      service: "integrations/inbound",
      operation: "apply",
      tenantId,
      severity: "error",
      extra: { system, entity, action },
    });
    return { status: 500, body: { error: "apply-failed", detail: String(err?.message ?? err).slice(0, 300) } };
  }
}

// ── Inbound appliers (loop-guarded by construction: they never enqueue) ─────

export interface InboundApplyInput {
  tenantId: string;
  system: IntegrationSystem;
  entity: string;
  action: string;
  data: Record<string, unknown>;
}

export async function applyInboundEvent(db: any, input: InboundApplyInput): Promise<string> {
  switch (`${input.system}:${input.entity}`) {
    case "medusa:product":
    case "medusa:inventory":
      return applyMedusaProduct(db, input.tenantId, input.data);
    case "twenty:person":
      return applyTwentyPerson(db, input.tenantId, input.data);
    case "odoo:stock":
    case "odoo:product":
      return applyOdooStock(db, input.tenantId, input.data);
    case "odoo:picking": {
      // B2B (w8): stock.picking done → flip the PO to 'fulfilled' exactly-once.
      const { applyOdooPickingDone } = await import("./odooB2B");
      return applyOdooPickingDone(db, input.tenantId, input.action, input.data);
    }
    default:
      return "ignored";
  }
}

/** Medusa product/inventory update → upsert products (+stockQuantity). */
async function applyMedusaProduct(db: any, tenantId: string, data: Record<string, unknown>): Promise<string> {
  const medusaId = String(data.id ?? data.product_id ?? "");
  if (!medusaId) return "ignored";
  const variant = Array.isArray(data.variants) ? (data.variants[0] as any) : undefined;
  const title = String(data.title ?? data.name ?? "Medusa Product");
  const priceMajor = Number(variant?.prices?.[0]?.amount ?? data.price ?? 0);
  const stock = Number(variant?.inventory_quantity ?? data.stockQuantity ?? data.inventory_quantity ?? 0);
  const sku = String(variant?.sku ?? data.sku ?? `medusa-${medusaId}`);

  const [existing] = await db
    .select({ id: products.id, stockQuantity: products.stockQuantity })
    .from(products)
    .where(and(eq(products.tenantId, tenantId), sql`${products.metadata}->>'medusaId' = ${medusaId}`))
    .limit(1);
  if (existing) {
    await db
      .update(products)
      .set({ name: title, price: priceMajor.toFixed(2), stockQuantity: stock, updatedAt: new Date() })
      .where(and(eq(products.id, existing.id), eq(products.tenantId, tenantId)));
    // Back-in-stock waitlist fan-out on a 0→>0 restock (never throws).
    await triggerRestockNotification(db, tenantId, existing.id, existing.stockQuantity, stock);
    return "updated";
  }
  await db.insert(products).values({
    id: crypto.randomUUID(),
    tenantId,
    sku,
    name: title,
    price: priceMajor.toFixed(2),
    currency: String(variant?.prices?.[0]?.currency_code ?? data.currency ?? "USD").toUpperCase(),
    stockQuantity: stock,
    status: "active",
    metadata: { medusaId, syncSource: "medusa" },
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return "created";
}

/** Twenty person update → upsert customers (matched by email, then phone). */
async function applyTwentyPerson(db: any, tenantId: string, data: Record<string, unknown>): Promise<string> {
  const emails = (data.emails ?? {}) as Record<string, unknown>;
  const phones = (data.phones ?? {}) as Record<string, unknown>;
  const nameObj = (data.name ?? {}) as Record<string, unknown>;
  const email = (emails.primaryEmail ?? data.email ?? null) as string | null;
  const phone = (phones.primaryPhoneNumber ?? data.phone ?? null) as string | null;
  const first = (nameObj.firstName ?? "") as string;
  const last = (nameObj.lastName ?? "") as string;
  const name = [first, last].filter(Boolean).join(" ") || null;
  const twentyId = String(data.id ?? "");

  let existing: { id: string } | undefined;
  if (email) {
    [existing] = await db
      .select({ id: customers.id })
      .from(customers)
      .where(and(eq(customers.tenantId, tenantId), eq(customers.email, email)))
      .limit(1);
  }
  if (!existing && phone) {
    [existing] = await db
      .select({ id: customers.id })
      .from(customers)
      .where(and(eq(customers.tenantId, tenantId), eq(customers.whatsappPhone, phone)))
      .limit(1);
  }
  if (existing) {
    await db
      .update(customers)
      .set({ name: name ?? undefined, email: email ?? undefined, crmContactId: twentyId || undefined, updatedAt: new Date() })
      .where(and(eq(customers.id, existing.id), eq(customers.tenantId, tenantId)));
    return "updated";
  }
  if (!phone && !email) return "ignored"; // customers.whatsappPhone is NOT NULL — need at least a phone
  await db.insert(customers).values({
    id: crypto.randomUUID(),
    tenantId,
    whatsappPhone: phone ?? `twenty:${twentyId || crypto.randomUUID()}`,
    name,
    email,
    crmContactId: twentyId || null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return "created";
}

/** Odoo stock change → update products.stockQuantity (match by metadata.odooId or sku). */
async function applyOdooStock(db: any, tenantId: string, data: Record<string, unknown>): Promise<string> {
  const qty = Number(data.qty_available ?? data.quantity ?? data.stockQuantity ?? NaN);
  if (Number.isNaN(qty)) return "ignored";
  const odooId = data.product_id ?? data.id;
  const sku = (data.default_code ?? data.sku ?? null) as string | null;

  let target: { id: string; stockQuantity: number } | undefined;
  if (odooId !== undefined && odooId !== null) {
    [target] = await db
      .select({ id: products.id, stockQuantity: products.stockQuantity })
      .from(products)
      .where(and(eq(products.tenantId, tenantId), sql`${products.metadata}->>'odooId' = ${String(odooId)}`))
      .limit(1);
  }
  if (!target && sku) {
    [target] = await db
      .select({ id: products.id, stockQuantity: products.stockQuantity })
      .from(products)
      .where(and(eq(products.tenantId, tenantId), eq(products.sku, sku)))
      .limit(1);
  }
  if (!target) return "ignored";
  await db
    .update(products)
    .set({ stockQuantity: qty, updatedAt: new Date() })
    .where(and(eq(products.id, target.id), eq(products.tenantId, tenantId)));
  // Back-in-stock waitlist fan-out on a 0→>0 restock (never throws).
  await triggerRestockNotification(db, tenantId, target.id, target.stockQuantity, qty);
  return "updated";
}
