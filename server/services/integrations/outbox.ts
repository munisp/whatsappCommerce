/**
 * server/services/integrations/outbox.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Transactional outbox for external-system sync. Local mutations NEVER call
 * Medusa/Twenty/Odoo directly — they enqueue an `integration_events` row
 * (direction='out', status='pending') and the dispatcher delivers it
 * asynchronously with retry:
 *
 *   processOutbox(batch=50): pending & attempts<5 → deliver via client;
 *   on failure attempts++ + lastError; status='dead' after 5 attempts;
 *   non-retriable errors (4xx, not-configured, disabled) → status='failed'.
 *
 * Loop guard: events whose payload.origin is 'external' (applied from an
 * inbound webhook) are never enqueued as outbound events, so an inbound
 * Medusa/Twenty/Odoo change can never bounce back out to the same system.
 */

import { and, asc, eq, lt, sql } from "drizzle-orm";
import { integrationEvents, tenants, type IntegrationEvent } from "../../../drizzle/schema";
import {
  createIntegrationClient,
  IntegrationError,
  resolveIntegrationConfig,
  type IntegrationConfig,
  type IntegrationSystem,
  INTEGRATION_SYSTEMS,
  MedusaClient,
  OdooClient,
  TwentyClient,
} from "./clients";

export const MAX_OUTBOX_ATTEMPTS = 5;

/** Payload envelope stored in integration_events.payload. */
export interface OutboxPayload {
  action: string; // 'created' | 'updated' | 'confirmed' | 'resync'
  origin: "platform" | "external";
  data: Record<string, unknown>;
}

export interface EnqueueInput {
  tenantId: string;
  system: IntegrationSystem;
  entity: string; // 'order' | 'customer' | 'product'
  entityId: string;
  action: string;
  data: Record<string, unknown>;
  origin?: "platform" | "external";
}

/**
 * Insert one outbox row. Returns the event id, or null when the loop guard
 * suppresses the event (origin='external') — callers do not need to check.
 */
export async function enqueueIntegrationEvent(db: any, input: EnqueueInput): Promise<string | null> {
  const origin = input.origin ?? "platform";
  if (origin === "external") {
    // Loop guard: inbound-applied writes must not re-enqueue outbound events.
    return null;
  }
  const payload: OutboxPayload = { action: input.action, origin, data: input.data };
  const [row] = await db
    .insert(integrationEvents)
    .values({
      tenantId: input.tenantId,
      system: input.system,
      direction: "out",
      entity: input.entity,
      entityId: input.entityId,
      payload,
      status: "pending",
      attempts: 0,
    })
    .returning({ id: integrationEvents.id });
  return row?.id ?? null;
}

/** Which systems care about which local entity. */
const ENTITY_SYSTEMS: Record<string, IntegrationSystem[]> = {
  order: ["medusa", "odoo"],
  customer: ["twenty", "odoo"],
  product: ["medusa", "odoo"],
};

/**
 * Called from local mutations (order created/confirmed, customer upsert,
 * product create/update). Reads the tenant's integration settings once and
 * enqueues one outbox row per ENABLED system that supports this entity.
 * Returns the ids of the enqueued events (never throws on a per-system
 * insert failure — logs and continues so one bad row cannot block the rest).
 */
export async function syncLocalChange(
  db: any,
  change: {
    tenantId: string;
    entity: "order" | "customer" | "product";
    entityId: string;
    action: string;
    data: Record<string, unknown>;
  },
): Promise<string[]> {
  const [tenant] = await db
    .select({ settings: tenants.settings })
    .from(tenants)
    .where(eq(tenants.id, change.tenantId))
    .limit(1);
  const integrations = ((tenant?.settings as any)?.integrations ?? {}) as Record<string, IntegrationConfig>;

  const ids: string[] = [];
  for (const system of ENTITY_SYSTEMS[change.entity] ?? []) {
    const cfg = integrations[system];
    if (!cfg || cfg.enabled !== true || !cfg.url) continue; // only enabled systems sync
    try {
      const id = await enqueueIntegrationEvent(db, {
        tenantId: change.tenantId,
        system,
        entity: change.entity,
        entityId: change.entityId,
        action: change.action,
        data: change.data,
        origin: "platform",
      });
      if (id) ids.push(id);
    } catch (err: any) {
      console.error(`[outbox] enqueue failed (${system}/${change.entity}/${change.entityId}):`, err?.message);
    }
  }
  return ids;
}

// ── Delivery ─────────────────────────────────────────────────────────────────

/** Deliver one outbox event to its target system. Throws IntegrationError. */
export async function deliverOutboxEvent(db: any, event: IntegrationEvent): Promise<void> {
  const system = event.system as IntegrationSystem;
  const payload = (event.payload ?? {}) as Partial<OutboxPayload>;
  const action = payload.action ?? "updated";
  const data = (payload.data ?? {}) as Record<string, unknown>;
  const config = await resolveIntegrationConfig(db, event.tenantId, system);
  const client = createIntegrationClient(system, config);

  switch (`${system}:${event.entity}`) {
    case "medusa:product": {
      const c = client as MedusaClient;
      await c.upsertProduct({
        externalId: (data.externalId as string) ?? null,
        title: String(data.name ?? data.title ?? "Untitled"),
        sku: String(data.sku ?? event.entityId),
        price: Number(data.price ?? 0),
        currency: String(data.currency ?? "USD"),
        description: (data.description as string) ?? null,
        stockQuantity: data.stockQuantity !== undefined ? Number(data.stockQuantity) : undefined,
      });
      return;
    }
    case "medusa:order": {
      const c = client as MedusaClient;
      const items = Array.isArray(data.items) ? (data.items as any[]) : [];
      await c.createDraftOrder({
        email: (data.customerEmail as string) ?? null,
        currency: String(data.currency ?? "USD"),
        items: items.map((i) => ({
          title: String(i.productName ?? i.title ?? "Item"),
          quantity: Number(i.quantity ?? 1),
          unitPrice: Number(i.unitPrice ?? 0),
        })),
        metadata: { platformOrderId: event.entityId, action, origin: "platform" },
      });
      return;
    }
    case "twenty:customer": {
      const c = client as TwentyClient;
      const name = String(data.name ?? "");
      const [firstName, ...rest] = name.split(" ").filter(Boolean);
      await c.upsertPerson({
        email: (data.email as string) ?? null,
        phone: (data.whatsappPhone as string) ?? (data.phone as string) ?? null,
        firstName: firstName ?? null,
        lastName: rest.length ? rest.join(" ") : null,
      });
      return;
    }
    case "odoo:customer": {
      const c = client as OdooClient;
      await c.upsertPartner({
        name: String(data.name ?? data.whatsappPhone ?? "WhatsApp Customer"),
        email: (data.email as string) ?? null,
        phone: (data.whatsappPhone as string) ?? (data.phone as string) ?? null,
        externalRef: String(event.entityId),
      });
      return;
    }
    case "odoo:order": {
      const c = client as OdooClient;
      const partner = await c.upsertPartner({
        name: String(data.customerName ?? data.customerPhone ?? "WhatsApp Customer"),
        email: (data.customerEmail as string) ?? null,
        phone: (data.customerPhone as string) ?? null,
        externalRef: String(data.customerId ?? event.entityId),
      });
      const items = Array.isArray(data.items) ? (data.items as any[]) : [];
      await c.createSaleOrder({
        partnerId: partner.id,
        origin: `WA-${event.entityId}`,
        lines: items.map((i) => ({
          productId: null,
          name: String(i.productName ?? i.title ?? "Item"),
          quantity: Number(i.quantity ?? 1),
          unitPrice: Number(i.unitPrice ?? 0),
        })),
      });
      return;
    }
    case "odoo:product": {
      // Odoo product push is stock-oriented: keep product.stock authoritative.
      const c = client as OdooClient;
      if (data.stockQuantity === undefined) return; // nothing stock-related to push
      await c.updateProductStock({
        sku: String(data.sku ?? event.entityId),
        quantity: Number(data.stockQuantity),
      });
      return;
    }
    default:
      // Unsupported combination: mark as delivered (nothing to do) rather than
      // retrying forever.
      console.warn(`[outbox] no delivery handler for ${system}:${event.entity} — marking delivered`);
      return;
  }
}

// ── Dispatcher ───────────────────────────────────────────────────────────────

export interface ProcessOutboxResult {
  picked: number;
  delivered: number;
  retried: number;
  failed: number;
  dead: number;
}

/** Injectable store so the dispatcher core is unit-testable without a DB. */
export interface OutboxDispatcherStore {
  fetchPending(batch: number): Promise<IntegrationEvent[]>;
  markDelivered(id: string, processedAt: Date): Promise<void>;
  markFailure(id: string, attempts: number, lastError: string, status: "pending" | "failed" | "dead"): Promise<void>;
}

export function createDrizzleOutboxStore(db: any): OutboxDispatcherStore {
  return {
    fetchPending: (batch) =>
      db
        .select()
        .from(integrationEvents)
        .where(
          and(
            eq(integrationEvents.direction, "out"),
            eq(integrationEvents.status, "pending"),
            lt(integrationEvents.attempts, MAX_OUTBOX_ATTEMPTS),
          ),
        )
        .orderBy(asc(integrationEvents.createdAt))
        .limit(batch),
    markDelivered: (id, processedAt) =>
      db
        .update(integrationEvents)
        .set({ status: "delivered", processedAt, lastError: null })
        .where(eq(integrationEvents.id, id)),
    markFailure: (id, attempts, lastError, status) =>
      db
        .update(integrationEvents)
        .set({ attempts, lastError, status, processedAt: status === "pending" ? undefined : new Date() })
        .where(eq(integrationEvents.id, id)),
  };
}

/**
 * Dispatcher core: pick pending outbound events, deliver each, and persist the
 * outcome. Fully injectable (store + deliver) for unit tests.
 */
export async function dispatchOutbox(
  store: OutboxDispatcherStore,
  deliver: (event: IntegrationEvent) => Promise<void>,
  batch = 50,
): Promise<ProcessOutboxResult> {
  const rows = await store.fetchPending(batch);
  const result: ProcessOutboxResult = { picked: rows.length, delivered: 0, retried: 0, failed: 0, dead: 0 };
  for (const event of rows) {
    try {
      await deliver(event);
      await store.markDelivered(event.id, new Date());
      result.delivered++;
    } catch (err: any) {
      const attempts = (event.attempts ?? 0) + 1;
      const message = String(err?.message ?? err).slice(0, 1000);
      const retriable = err instanceof IntegrationError ? err.retriable : true; // unknown errors retry
      const status: "pending" | "failed" | "dead" = !retriable
        ? "failed"
        : attempts >= MAX_OUTBOX_ATTEMPTS
          ? "dead"
          : "pending";
      await store.markFailure(event.id, attempts, message, status);
      if (status === "pending") result.retried++;
      else if (status === "dead") result.dead++;
      else result.failed++;
    }
  }
  return result;
}

/**
 * Production dispatcher entry point (cron/interval job). `db` is the drizzle
 * handle from getDb().
 */
export async function processOutbox(
  db: any,
  opts: { batch?: number; deliver?: (event: IntegrationEvent) => Promise<void> } = {},
): Promise<ProcessOutboxResult> {
  const store = createDrizzleOutboxStore(db);
  const deliver = opts.deliver ?? ((event: IntegrationEvent) => deliverOutboxEvent(db, event));
  return dispatchOutbox(store, deliver, opts.batch ?? 50);
}

/** Count events per status for a tenant (syncStatus router procedure). */
export async function countEventsByStatus(
  db: any,
  tenantId: string,
  system?: IntegrationSystem,
): Promise<Record<string, number>> {
  const conds = [eq(integrationEvents.tenantId, tenantId)];
  if (system) conds.push(eq(integrationEvents.system, system));
  const rows = await db
    .select({ status: integrationEvents.status, count: sql<number>`count(*)::int` })
    .from(integrationEvents)
    .where(and(...conds))
    .groupBy(integrationEvents.status);
  const out: Record<string, number> = { pending: 0, delivered: 0, failed: 0, dead: 0 };
  for (const r of rows) out[r.status] = Number(r.count);
  return out;
}

export { INTEGRATION_SYSTEMS };
