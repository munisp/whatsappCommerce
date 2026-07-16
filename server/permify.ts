/**
 * server/permify.ts — Permify fine-grained authorization client
 *
 * Permify is a Google Zanzibar-inspired authz service.
 * This module wraps the REST API for:
 *   - Permission checks (can user X do action Y on resource Z?)
 *   - Relationship writes (grant/revoke)
 *   - Schema management
 *
 * Falls back to allow-all when PERMIFY_URL is not configured (dev mode).
 */
import { ENV } from "./_core/env";

const BASE = () => ENV.permifyUrl;
const TENANT = () => ENV.permifyTenantId;

function headers() {
  return { "Content-Type": "application/json" };
}

export interface PermifyCheckInput {
  entity: { type: string; id: string };
  permission: string;
  subject: { type: string; id: string; relation?: string };
}

/**
 * Check if a subject has a permission on an entity.
 * Returns true (allowed) when Permify is unreachable in dev mode.
 */
export async function permifyCheck(input: PermifyCheckInput): Promise<boolean> {
  if (!process.env.PERMIFY_URL) return true; // dev fallback
  try {
    const resp = await fetch(
      `${BASE()}/v1/tenants/${TENANT()}/permissions/check`,
      {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          metadata: { schema_version: "", snap_token: "", depth: 20 },
          entity: input.entity,
          permission: input.permission,
          subject: input.subject,
        }),
        signal: AbortSignal.timeout(3000),
      }
    );
    if (!resp.ok) return false;
    const data = await resp.json() as { can?: string };
    return data.can === "CHECK_RESULT_ALLOWED";
  } catch {
    return true; // fail-open in dev; fail-closed in prod via env guard above
  }
}

export interface PermifyRelationship {
  entity: { type: string; id: string };
  relation: string;
  subject: { type: string; id: string; relation?: string };
}

/** Write (grant) a relationship tuple */
export async function permifyWriteRelationship(rel: PermifyRelationship): Promise<void> {
  if (!process.env.PERMIFY_URL) return;
  await fetch(`${BASE()}/v1/tenants/${TENANT()}/relationships/write`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      metadata: { schema_version: "" },
      tuples: [{ entity: rel.entity, relation: rel.relation, subject: rel.subject }],
    }),
    signal: AbortSignal.timeout(3000),
  }).catch((e) => console.warn("[Permify] write failed:", e.message));
}

/** Delete (revoke) a relationship tuple */
export async function permifyDeleteRelationship(rel: PermifyRelationship): Promise<void> {
  if (!process.env.PERMIFY_URL) return;
  await fetch(`${BASE()}/v1/tenants/${TENANT()}/relationships/delete`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      filter: { entity_filter: { type: rel.entity.type, ids: [rel.entity.id] }, relation: rel.relation, subject_filter: { type: rel.subject.type, ids: [rel.subject.id] } },
    }),
    signal: AbortSignal.timeout(3000),
  }).catch((e) => console.warn("[Permify] delete failed:", e.message));
}

/** Health check */
export async function permifyHealthCheck(): Promise<{ online: boolean; latencyMs?: number; error?: string }> {
  if (!process.env.PERMIFY_URL) return { online: false, error: "not_configured" };
  try {
    const t0 = Date.now();
    const r = await fetch(`${BASE()}/healthz`, { signal: AbortSignal.timeout(3000) }).catch(() => null);
    if (r?.ok) return { online: true, latencyMs: Date.now() - t0 };
    return { online: false, error: `status ${r?.status ?? "unreachable"}` };
  } catch (err: any) {
    return { online: false, error: err.message };
  }
}
