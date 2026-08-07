/**
 * server/dapr.ts — Dapr sidecar HTTP client with DB audit logging
 *
 * Dapr provides:
 *   - Pub/Sub (via daprPublish)
 *   - State store (via daprSaveState / daprGetState)
 *   - Service invocation (via daprInvoke)
 *   - Bindings (output)
 *
 * All published events are logged to dapr_event_log for observability.
 * Falls back gracefully when DAPR_HTTP_PORT is not reachable.
 */
import { ENV } from "./_core/env";

function daprBase() {
  return `http://localhost:${ENV.daprHttpPort}`;
}

async function logDaprEvent(
  pubsubName: string,
  topic: string,
  data: Record<string, unknown>,
  status: "published" | "failed",
  errorMsg?: string
): Promise<void> {
  try {
    const { getDb } = await import("./db");
    const { daprEventLog } = await import("../drizzle/schema");
    const db = await getDb();
    if (!db) return;
    await db.insert(daprEventLog).values({
      pubsubName,
      topic,
      tenantId: (data.tenantId as string) ?? undefined,
      entityId: (data.orderId ?? data.id ?? data.entityId) as string | undefined,
      eventType: (data.eventType ?? data.type) as string | undefined,
      payload: data,
      status,
      errorMsg,
      publishedAt: new Date(),
    });
  } catch { /* never throw from audit logger */ }
}

/** Publish an event to a Dapr pub/sub component */
export async function daprPublish(pubsubName: string, topic: string, data: Record<string, unknown>): Promise<void> {
  try {
    const res = await fetch(`${daprBase()}/v1.0/publish/${pubsubName}/${topic}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "dapr-app-id": ENV.daprAppId },
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      await logDaprEvent(pubsubName, topic, data, "failed", `HTTP ${res.status}: ${errText}`);
      console.warn(`[Dapr] publish ${pubsubName}/${topic} → HTTP ${res.status}`);
      return;
    }
    await logDaprEvent(pubsubName, topic, data, "published");
  } catch (err: any) {
    await logDaprEvent(pubsubName, topic, data, "failed", err.message);
    console.warn(`[Dapr] publish ${pubsubName}/${topic} failed:`, err.message);
  }
}

/** Save state to a Dapr state store */
export async function daprSaveState(storeName: string, key: string, value: unknown): Promise<void> {
  try {
    await fetch(`${daprBase()}/v1.0/state/${storeName}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([{ key, value }]),
      signal: AbortSignal.timeout(3000),
    });
  } catch (err: any) {
    console.warn(`[Dapr] saveState ${storeName}/${key} failed:`, err.message);
  }
}

/** Get state from a Dapr state store */
export async function daprGetState<T = unknown>(storeName: string, key: string): Promise<T | null> {
  try {
    const r = await fetch(`${daprBase()}/v1.0/state/${storeName}/${key}`, {
      signal: AbortSignal.timeout(3000),
    });
    if (r.status === 204 || !r.ok) return null;
    return r.json() as Promise<T>;
  } catch {
    return null;
  }
}

/** Delete state from a Dapr state store */
export async function daprDeleteState(storeName: string, key: string): Promise<void> {
  try {
    await fetch(`${daprBase()}/v1.0/state/${storeName}/${key}`, {
      method: "DELETE",
      signal: AbortSignal.timeout(3000),
    });
  } catch (err: any) {
    console.warn(`[Dapr] deleteState ${storeName}/${key} failed:`, err.message);
  }
}

/** Invoke a method on another Dapr-enabled service */
export async function daprInvoke(appId: string, method: string, body?: Record<string, unknown>): Promise<unknown> {
  try {
    const r = await fetch(`${daprBase()}/v1.0/invoke/${appId}/method/${method}`, {
      method: body ? "POST" : "GET",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return null;
    return r.json();
  } catch {
    return null;
  }
}

/** Trigger a Dapr output binding */
export async function daprInvokeBinding(
  bindingName: string,
  operation: string,
  data: Record<string, unknown>,
  metadata?: Record<string, string>
): Promise<void> {
  try {
    await fetch(`${daprBase()}/v1.0/bindings/${bindingName}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operation, data, metadata }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (err: any) {
    console.warn(`[Dapr] invokeBinding ${bindingName}/${operation} failed:`, err.message);
  }
}

/** Health check — pings the Dapr sidecar health endpoint */
export async function daprHealthCheck(): Promise<{ online: boolean; latencyMs?: number; error?: string }> {
  try {
    const t0 = Date.now();
    const r = await fetch(`${daprBase()}/v1.0/healthz`, { signal: AbortSignal.timeout(2000) }).catch(() => null);
    if (r?.ok) return { online: true, latencyMs: Date.now() - t0 };
    return { online: false, error: `sidecar returned ${r?.status ?? "unreachable"}` };
  } catch (err: any) {
    return { online: false, error: err.message };
  }
}

// ── Domain-specific publish helpers ───────────────────────────────────────────

export async function publishOrderEvent(eventType: string, payload: Record<string, unknown>): Promise<void> {
  return daprPublish("whatsapp-pubsub", `wacommerce.orders.${eventType}`, {
    eventType, ...payload, publishedAt: new Date().toISOString(),
  });
}

export async function publishPaymentEvent(eventType: string, payload: Record<string, unknown>): Promise<void> {
  return daprPublish("whatsapp-pubsub", `wacommerce.payments.${eventType}`, {
    eventType, ...payload, publishedAt: new Date().toISOString(),
  });
}

export async function publishInventoryEvent(eventType: string, payload: Record<string, unknown>): Promise<void> {
  return daprPublish("whatsapp-pubsub", `wacommerce.inventory.${eventType}`, {
    eventType, ...payload, publishedAt: new Date().toISOString(),
  });
}

export async function publishConversationEvent(eventType: string, payload: Record<string, unknown>): Promise<void> {
  return daprPublish("whatsapp-pubsub", `wacommerce.conversations.${eventType}`, {
    eventType, ...payload, publishedAt: new Date().toISOString(),
  });
}

export async function cacheSession(sessionId: string, data: Record<string, unknown>, ttlSeconds = 3600): Promise<void> {
  return daprSaveState("whatsapp-statestore", `session:${sessionId}`, {
    ...data, _ttl: ttlSeconds, _cachedAt: new Date().toISOString(),
  });
}

export async function getCachedSession<T = Record<string, unknown>>(sessionId: string): Promise<T | null> {
  return daprGetState<T>("whatsapp-statestore", `session:${sessionId}`);
}
