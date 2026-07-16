/**
 * server/dapr.ts — Dapr sidecar HTTP client
 *
 * Dapr provides:
 *   - Pub/Sub (via dapr.publishEvent)
 *   - State store (via dapr.saveState / dapr.getState)
 *   - Service invocation (via dapr.invokeService)
 *   - Bindings (output)
 *
 * This module wraps the Dapr HTTP API (port 3500 by default).
 * Falls back gracefully when DAPR_HTTP_PORT is not reachable.
 */
import { ENV } from "./_core/env";

function daprBase() {
  return `http://localhost:${ENV.daprHttpPort}`;
}

/** Publish an event to a Dapr pub/sub component */
export async function daprPublish(pubsubName: string, topic: string, data: Record<string, unknown>): Promise<void> {
  try {
    await fetch(`${daprBase()}/v1.0/publish/${pubsubName}/${topic}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "dapr-app-id": ENV.daprAppId },
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(3000),
    });
  } catch (err: any) {
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

/** Health check — pings the Dapr sidecar health endpoint */
export async function daprHealthCheck(): Promise<{ online: boolean; latencyMs?: number; error?: string }> {
  try {
    const t0 = Date.now();
    const r = await fetch(`${daprBase()}/v1.0/healthz`, { signal: AbortSignal.timeout(2000) }).catch(() => null);
    if (r?.ok) return { online: true, latencyMs: Date.now() - t0 };
    // Dapr not running is normal in non-Dapr deployments
    return { online: false, error: `sidecar returned ${r?.status ?? "unreachable"}` };
  } catch (err: any) {
    return { online: false, error: err.message };
  }
}
