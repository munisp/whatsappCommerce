/**
 * WhatsApp message-template management against the Meta Graph API.
 *
 * Templates live on the tenant's WhatsApp Business Account (WABA):
 *   GET  /{wabaId}/message_templates   — list + status sync
 *   POST /{wabaId}/message_templates   — create (submitted for approval)
 *
 * The WABA id resolves from tenants.whatsappBusinessAccountId, falling back
 * to settings.whatsapp.wabaId; the access token uses the same storage as
 * waSender (settings.whatsapp.accessToken, env fallback).
 *
 * Remote state is cached in settings.waTemplates =
 *   { templates: CachedWaTemplate[], syncedAt } so the broadcast picker can
 * render APPROVED templates without a live Graph call.
 */

import { eq, sql } from "drizzle-orm";
import type { getDb } from "../db";
import { tenants } from "../../drizzle/schema";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type FetchFn = typeof fetch;

export const WA_TEMPLATE_STATUSES = ["APPROVED", "PENDING", "REJECTED", "PAUSED", "DISABLED"] as const;
export type WaTemplateStatus = (typeof WA_TEMPLATE_STATUSES)[number];

export interface CachedWaTemplate {
  id: string;
  name: string;
  category: string;
  language: string;
  status: WaTemplateStatus | string;
  body: string;
  rejectedReason?: string | null;
}

export interface WaTemplateCache {
  templates: CachedWaTemplate[];
  syncedAt: string | null;
}

const GRAPH_BASE = "https://graph.facebook.com/v21.0";

export interface WabaCredentials {
  wabaId: string;
  accessToken: string;
}

/** Resolve WABA id + access token for a tenant (null when not configured). */
export async function resolveWabaCredentials(db: Db, tenantId: string): Promise<WabaCredentials | null> {
  const [t] = await db
    .select({ wabaId: tenants.whatsappBusinessAccountId, settings: tenants.settings })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1)
    .catch(() => []);
  const wa = (((t?.settings as any)?.whatsapp ?? {}) as Record<string, unknown>);
  const wabaId =
    (t?.wabaId && String(t.wabaId)) ||
    (typeof wa.wabaId === "string" && wa.wabaId ? wa.wabaId : "");
  const accessToken =
    (typeof wa.accessToken === "string" && wa.accessToken) ||
    process.env.WAC_WHATSAPP_TOKEN ||
    process.env.WHATSAPP_TOKEN ||
    "";
  if (!wabaId || !accessToken) return null;
  return { wabaId, accessToken };
}

/** Parse the cached template list out of tenant settings. */
export function parseWaTemplateCache(settings: unknown): WaTemplateCache {
  const raw = (settings as any)?.waTemplates;
  const templates: CachedWaTemplate[] = Array.isArray(raw?.templates)
    ? raw.templates
        .filter((t: any) => t && typeof t.name === "string")
        .map((t: any) => ({
          id: String(t.id ?? ""),
          name: String(t.name),
          category: String(t.category ?? ""),
          language: String(t.language ?? ""),
          status: String(t.status ?? "PENDING"),
          body: String(t.body ?? ""),
          ...(t.rejectedReason ? { rejectedReason: String(t.rejectedReason) } : {}),
        }))
    : [];
  return { templates, syncedAt: typeof raw?.syncedAt === "string" ? raw.syncedAt : null };
}

/** APPROVED-only view for the broadcast template picker. */
export function approvedTemplates(cache: WaTemplateCache): CachedWaTemplate[] {
  return cache.templates.filter((t) => t.status === "APPROVED");
}

function bodyFromComponents(components: any): string {
  if (!Array.isArray(components)) return "";
  const body = components.find((c: any) => c?.type === "BODY" || c?.type === "body");
  return typeof body?.text === "string" ? body.text : "";
}

/** Fetch the live template list from Meta. Throws on non-OK responses. */
export async function fetchMetaTemplates(
  creds: WabaCredentials,
  fetchFn: FetchFn = fetch,
): Promise<CachedWaTemplate[]> {
  const url =
    `${GRAPH_BASE}/${encodeURIComponent(creds.wabaId)}/message_templates` +
    `?fields=name,category,language,status,components,rejected_reason&limit=250`;
  const res = await fetchFn(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${creds.accessToken}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Meta template list failed (${res.status}): ${body.slice(0, 300)}`);
  }
  const data = (await res.json().catch(() => ({}))) as any;
  const rows: any[] = Array.isArray(data?.data) ? data.data : [];
  return rows.map((r) => ({
    id: String(r?.id ?? ""),
    name: String(r?.name ?? ""),
    category: String(r?.category ?? ""),
    language: String(r?.language ?? ""),
    status: String(r?.status ?? "PENDING"),
    body: bodyFromComponents(r?.components),
    ...(r?.rejected_reason ? { rejectedReason: String(r.rejected_reason) } : {}),
  }));
}

/**
 * Sync remote templates into the settings cache (settings.waTemplates).
 * Returns the fresh cache. Throws when the tenant is not configured or Meta
 * rejects the call — callers decide whether to surface or keep the cache.
 */
export async function syncWaTemplates(
  db: Db,
  tenantId: string,
  fetchFn: FetchFn = fetch,
): Promise<WaTemplateCache> {
  const creds = await resolveWabaCredentials(db, tenantId);
  if (!creds) {
    throw new Error("WhatsApp Business Account (wabaId) or access token not configured for tenant");
  }
  const templates = await fetchMetaTemplates(creds, fetchFn);
  const cache: WaTemplateCache = { templates, syncedAt: new Date().toISOString() };
  await db
    .update(tenants)
    .set({
      settings: sql`COALESCE(${tenants.settings}, '{}'::jsonb) || ${JSON.stringify({ waTemplates: cache })}::jsonb`,
      updatedAt: new Date(),
    } as any)
    .where(eq(tenants.id, tenantId));
  return cache;
}

export interface CreateMetaTemplateInput {
  name: string;
  category: "UTILITY" | "MARKETING";
  language: string;
  /** Body text; may contain positional parameters {{1}}, {{2}}, … */
  body: string;
}

/** Positional {{n}} placeholders found in a body (ordered, deduped). */
export function positionalParams(body: string): number[] {
  const seen = new Set<number>();
  for (const m of Array.from(body.matchAll(/\{\{(\d+)\}\}/g))) {
    seen.add(Number(m[1]));
  }
  return Array.from(seen).sort((a, b) => a - b);
}

/**
 * Create a template on the WABA (Meta then reviews it: initial status is
 * typically PENDING). Positional parameters require a sample example payload.
 * Returns the Meta template id + initial status.
 */
export async function createMetaTemplate(
  db: Db,
  tenantId: string,
  input: CreateMetaTemplateInput,
  fetchFn: FetchFn = fetch,
): Promise<{ id: string; status: string }> {
  const creds = await resolveWabaCredentials(db, tenantId);
  if (!creds) {
    throw new Error("WhatsApp Business Account (wabaId) or access token not configured for tenant");
  }
  const params = positionalParams(input.body);
  const bodyComponent: Record<string, unknown> = { type: "BODY", text: input.body };
  if (params.length > 0) {
    bodyComponent.example = { body_text: [params.map((n) => `sample${n}`)] };
  }
  const res = await fetchFn(`${GRAPH_BASE}/${encodeURIComponent(creds.wabaId)}/message_templates`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${creds.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: input.name,
      category: input.category,
      language: input.language,
      components: [bodyComponent],
    }),
  });
  const data = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) {
    throw new Error(`Meta template create failed (${res.status}): ${JSON.stringify(data).slice(0, 300)}`);
  }
  return { id: String(data?.id ?? ""), status: String(data?.status ?? "PENDING") };
}
