/**
 * === W40 MSG-2: message_template_status_update webhooks ===
 * Meta pushes template lifecycle events (APPROVED / REJECTED / PAUSED /
 * DISABLED ...) to the SAME WhatsApp webhook endpoint as messages, with
 * `changes[].field === "message_template_status_update"` and
 * `changes[].value = { event, message_template_id, message_template_name,
 * message_template_language, reason? }` (`entry[].id` is the WABA id).
 *
 * Before W40 these events fell through the webhook's bare 200 — a template
 * REJECTED/PAUSED mid-campaign was never detected and broadcasts blasted
 * into per-recipient failures (W36 MSG-2).
 *
 * What this module does:
 *   1. Persists the new status onto the local whatsapp_templates rows
 *      (matched by tenant + name) and onto the settings.waTemplates cache
 *      entry consumed by the broadcast template picker.
 *   2. Alerts the tenant admin over WhatsApp when a template dies
 *      (REJECTED / PAUSED / DISABLED) — a dead template must never be silent.
 *   3. assertTemplateSendable() is the send-side gate consumed by the
 *      broadcast send loop: campaigns referencing a dead template are
 *      blocked with an honest PRECONDITION_FAILED error instead of
 *      failing per recipient.
 */

import { and, eq, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import type { getDb } from "../db";
import { tenants, whatsappTemplates } from "../../drizzle/schema";
import { notifyTenantAdminWhatsApp } from "./adminAlerts";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

/** Meta template events that make a template unusable for sends. */
export const DEAD_TEMPLATE_EVENTS = ["REJECTED", "PAUSED", "DISABLED"] as const;

/** Local approvalStatus values that block sends (mirror of the above). */
export const DEAD_TEMPLATE_STATUSES = ["rejected", "paused", "disabled"] as const;

/** Map a Meta template-status event onto the local approvalStatus enum. */
export function mapMetaTemplateEvent(event: string):
  | "approved"
  | "rejected"
  | "paused"
  | "disabled"
  | "submitted"
  | null {
  switch ((event ?? "").toUpperCase()) {
    case "APPROVED":
      return "approved";
    case "REJECTED":
      return "rejected";
    case "PAUSED":
      return "paused";
    case "DISABLED":
      return "disabled";
    case "PENDING":
    case "IN_APPEAL":
      return "submitted";
    default:
      return null; // unknown event — recorded as unhandled, never guessed
  }
}

export function isDeadTemplateStatus(status: string | null | undefined): boolean {
  return !!status && (DEAD_TEMPLATE_STATUSES as readonly string[]).includes(status);
}

interface TemplateStatusValue {
  event?: string;
  message_template_id?: string | number;
  message_template_name?: string;
  message_template_language?: string;
  reason?: string;
}

/** Resolve the tenant for one webhook entry (WABA id → tenants row). */
async function resolveTenantForEntry(
  db: Db,
  entry: any,
): Promise<{ id: string; settings: unknown } | null> {
  const wabaId: string = String(entry?.id ?? "");
  const phoneNumberId: string =
    entry?.changes?.[0]?.value?.metadata?.phone_number_id != null
      ? String(entry.changes[0].value.metadata.phone_number_id)
      : "";
  if (wabaId) {
    const [t] = await db
      .select({ id: tenants.id, settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.whatsappBusinessAccountId, wabaId))
      .limit(1)
      .catch(() => [] as any[]);
    if (t) return t;
  }
  if (phoneNumberId) {
    const [t] = await db
      .select({ id: tenants.id, settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.whatsappPhoneNumberId, phoneNumberId))
      .limit(1)
      .catch(() => [] as any[]);
    if (t) return t;
  }
  return null;
}

/** Patch the cached template status inside settings.waTemplates (name-keyed). */
async function updateTemplateCache(
  db: Db,
  tenant: { id: string; settings: unknown },
  templateName: string,
  metaStatus: string,
  reason: string | null,
): Promise<void> {
  const cache = ((tenant.settings as any)?.waTemplates ?? null) as
    | { templates?: any[]; syncedAt?: string | null }
    | null;
  if (!cache || !Array.isArray(cache.templates)) return; // nothing cached — nothing to patch
  let touched = false;
  const templates = cache.templates.map((t: any) => {
    if (t && t.name === templateName) {
      touched = true;
      return {
        ...t,
        status: metaStatus,
        ...(reason ? { rejectedReason: reason } : {}),
      };
    }
    return t;
  });
  if (!touched) return;
  await db
    .update(tenants)
    .set({
      settings: sql`COALESCE(${tenants.settings}, '{}'::jsonb) || ${JSON.stringify({
        waTemplates: { ...cache, templates },
      })}::jsonb`,
      updatedAt: new Date(),
    } as any)
    .where(eq(tenants.id, tenant.id));
}

export interface TemplateStatusWebhookResult {
  handled: number;
  updated: number;
  unknownTenant: number;
  unknownEvent: number;
}

/**
 * Process every message_template_status_update change in a webhook body.
 * Idempotent (status writes are convergent) and never throws — the webhook
 * has already been acked. Events for unknown tenants/templates are logged,
 * not silently dropped.
 */
export async function handleTemplateStatusWebhook(
  db: Db,
  body: any,
): Promise<TemplateStatusWebhookResult> {
  const result: TemplateStatusWebhookResult = { handled: 0, updated: 0, unknownTenant: 0, unknownEvent: 0 };
  const entries: any[] = Array.isArray(body?.entry) ? body.entry : [];
  for (const entry of entries) {
    const changes: any[] = Array.isArray(entry?.changes) ? entry.changes : [];
    for (const change of changes) {
      if (change?.field !== "message_template_status_update") continue;
      const value = (change?.value ?? {}) as TemplateStatusValue;
      const templateName = String(value.message_template_name ?? "");
      const metaEvent = String(value.event ?? "").toUpperCase();
      result.handled++;
      if (!templateName || !metaEvent) {
        console.warn("[template-status] malformed event payload:", JSON.stringify(value).slice(0, 300));
        continue;
      }
      const tenant = await resolveTenantForEntry(db, entry);
      if (!tenant) {
        result.unknownTenant++;
        console.warn(
          `[template-status] no tenant for WABA ${String(entry?.id ?? "")} (template=${templateName}, event=${metaEvent}) — event logged, not applied`,
        );
        continue;
      }
      const local = mapMetaTemplateEvent(metaEvent);
      if (!local) {
        result.unknownEvent++;
        console.warn(`[template-status] unhandled event '${metaEvent}' for template ${templateName} (tenant=${tenant.id})`);
        continue;
      }
      const reason = typeof value.reason === "string" && value.reason ? value.reason : null;
      // 1. Local template store (whatsapp_templates), matched by tenant+name.
      const updated = await db
        .update(whatsappTemplates)
        .set({
          approvalStatus: local as any,
          approvalUpdatedAt: new Date(),
          ...(reason ? { rejectionReason: reason.slice(0, 1000) } : {}),
          updatedAt: new Date(),
        })
        .where(and(eq(whatsappTemplates.tenantId, tenant.id), eq(whatsappTemplates.name, templateName)))
        .catch((e: any) => {
          console.warn("[template-status] template row update failed:", e?.message);
          return null;
        });
      if (updated !== null) result.updated++;
      // 2. Meta-template cache in settings (broadcast picker source).
      await updateTemplateCache(db, tenant, templateName, metaEvent, reason)
        .catch((e: any) => console.warn("[template-status] cache patch failed:", e?.message));
      // 3. Dead templates alert the tenant admin — never silent.
      if ((DEAD_TEMPLATE_EVENTS as readonly string[]).includes(metaEvent)) {
        await notifyTenantAdminWhatsApp(
          db,
          tenant.id,
          `⚠️ WhatsApp template "${templateName}" was ${metaEvent} by Meta` +
            (reason ? ` (${reason})` : "") +
            ". Campaigns using it are blocked until it is re-approved. " +
            "Review the template in the dashboard and pick an approved replacement.",
        );
      }
    }
  }
  return result;
}

/**
 * Send-side gate (MSG-2): throws PRECONDITION_FAILED when the campaign's
 * template is dead. Checks BOTH the local whatsapp_templates row (by id)
 * and the Meta-template cache (by name) — a campaign may reference either.
 * Returns normally when the template is alive or unknown (unknown = the
 * pre-W40 behavior; Meta remains the final arbiter on the send itself).
 */
export async function assertTemplateSendable(
  db: Db,
  tenantId: string,
  opts: { templateId?: string | null; templateName?: string | null },
): Promise<void> {
  if (opts.templateId) {
    const [tpl] = await db
      .select({ name: whatsappTemplates.name, approvalStatus: whatsappTemplates.approvalStatus, isActive: whatsappTemplates.isActive })
      .from(whatsappTemplates)
      .where(eq(whatsappTemplates.id, opts.templateId))
      .limit(1)
      .catch(() => [] as any[]);
    if (tpl && (isDeadTemplateStatus(tpl.approvalStatus) || tpl.isActive === false)) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message:
          `Template "${tpl.name}" is ${tpl.isActive === false ? "inactive" : tpl.approvalStatus} — ` +
          "Meta has disabled it. Pick an APPROVED template before sending this campaign.",
      });
    }
  }
  if (opts.templateName) {
    const [t] = await db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1)
      .catch(() => [] as any[]);
    const cached: any[] = Array.isArray((t?.settings as any)?.waTemplates?.templates)
      ? (t!.settings as any).waTemplates.templates
      : [];
    const hit = cached.find((c: any) => c && c.name === opts.templateName);
    if (hit && (DEAD_TEMPLATE_EVENTS as readonly string[]).includes(String(hit.status ?? "").toUpperCase())) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message:
          `Template "${opts.templateName}" is ${hit.status} on Meta — ` +
          "campaign sends are blocked until it is re-approved. Sync templates or pick an approved replacement.",
      });
    }
  }
}
