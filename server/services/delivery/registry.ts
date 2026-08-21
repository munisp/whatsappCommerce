/**
 * server/services/delivery/registry.ts — W27 courier adapter registry.
 *
 * Mirrors server/services/payments/providers/registry.ts: adapters register
 * once at module load (local dispatch is built in); per-tenant resolution
 * reads courier_configs ordered by priority DESC then createdAt ASC.
 *
 * FROZEN CONTRACT export: getCourierAdapter(name).
 */
import { asc, desc, eq, and } from "drizzle-orm";
import { getDb } from "../../db";
import { courierConfigs } from "../../../drizzle/schema";
import type { CourierAdapter } from "./types";
import { localDispatchAdapter } from "./localDispatch";
import { motoDispatchStubAdapter } from "./motoDispatchStub";

const adapters = new Map<string, CourierAdapter>();

export function registerCourierAdapter(a: CourierAdapter): void {
  adapters.set(a.id, a);
}

export function listCourierAdapters(): { id: string; displayName: string }[] {
  return Array.from(adapters.values()).map((a) => ({ id: a.id, displayName: a.displayName }));
}

/** FROZEN CONTRACT — resolve a registered courier adapter by name. */
export function getCourierAdapter(name: string): CourierAdapter | undefined {
  return adapters.get(name);
}

export interface TenantCourierEntry {
  courier: CourierAdapter;
  config: { priority: number; credentials: unknown };
}

/**
 * Resolve the tenant's enabled courier configs into an ordered list —
 * highest priority first. Rows whose courier has no registered adapter are
 * skipped. A tenant with NO courier_configs rows gets the built-in local
 * dispatch adapter as the default (self-serve merchants dispatch their own
 * riders); set DELIVERY_DEFAULT_COURIER="" to disable that fallback.
 */
export async function getCouriersForTenant(tenantId: string): Promise<TenantCourierEntry[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db
    .select()
    .from(courierConfigs)
    .where(and(eq(courierConfigs.tenantId, tenantId), eq(courierConfigs.enabled, true)))
    .orderBy(desc(courierConfigs.priority), asc(courierConfigs.createdAt))
    .catch(() => []);
  const out: TenantCourierEntry[] = [];
  for (const r of rows) {
    const adapter = adapters.get(r.courier);
    if (!adapter) continue;
    out.push({ courier: adapter, config: { priority: r.priority ?? 0, credentials: r.credentials } });
  }
  if (out.length === 0 && (process.env.DELIVERY_DEFAULT_COURIER ?? "local_dispatch") !== "") {
    const fallback = adapters.get(process.env.DELIVERY_DEFAULT_COURIER ?? "local_dispatch") ?? localDispatchAdapter;
    out.push({ courier: fallback, config: { priority: 0, credentials: null } });
  }
  return out;
}

// Built-ins.
registerCourierAdapter(localDispatchAdapter);
registerCourierAdapter(motoDispatchStubAdapter);
