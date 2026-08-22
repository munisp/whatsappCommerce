/**
 * W28 odoo-sync — WhatsApp tenant-admin Odoo commands.
 *
 * Merchant (tenant admin phone) chats with the platform number:
 *   "ODOO STATUS"   → connection + outbox stats (pending/sent/failed)
 *   "ODOO SYNC NOW" → sweep + drain the outbox, report the result
 *
 * Security: same admin-phone resolution as creditWhatsApp/chatDispute —
 * only settings.adminPhone / settings.whatsapp.adminPhone /
 * settings.notifications.adminPhone may run Odoo commands; anything else
 * returns handled=false and falls through to the normal menu/NLP pipeline.
 */
import { eq } from "drizzle-orm";
import { odooConfigs, tenants } from "../../../drizzle/schema";
import { outboxStats, syncNow } from "./sync";

type Db = any;

export interface OdooCommandOutcome {
  handled: boolean;
  reply?: string;
}

/** Same admin-phone resolution chain as services/chatDispute.ts. */
export function resolveAdminPhone(settings: Record<string, unknown> | null): string | null {
  const s = settings ?? {};
  const cand =
    (s as any)?.adminPhone ??
    (s as any)?.whatsapp?.adminPhone ??
    (s as any)?.notifications?.adminPhone;
  return typeof cand === "string" && cand.trim() ? cand.trim() : null;
}

function normPhone(p: string): string {
  return p.replace(/[^\d]/g, "").replace(/^0+/, "");
}

export function parseOdooCommand(text: string): { cmd: "status" | "sync" } | null {
  const m = text.trim().match(/^ODOO(?:\s+(STATUS|SYNC(?:\s+NOW)?|SYNC\s+NOW))?\s*$/i);
  if (!m) return null;
  const sub = (m[1] ?? "STATUS").toUpperCase().replace(/\s+/g, " ");
  if (sub === "SYNC" || sub === "SYNC NOW") return { cmd: "sync" };
  if (sub === "STATUS") return { cmd: "status" };
  return null;
}

export async function handleOdooCommand(opts: {
  db: Db;
  tenantId: string;
  waPhoneNumber: string;
  text: string;
}): Promise<OdooCommandOutcome> {
  const parsed = parseOdooCommand(opts.text);
  if (!parsed) return { handled: false };

  const [tenant] = await opts.db
    .select({ settings: tenants.settings })
    .from(tenants)
    .where(eq(tenants.id, opts.tenantId))
    .limit(1);
  const adminPhone = resolveAdminPhone((tenant?.settings ?? null) as Record<string, unknown> | null);
  if (!adminPhone || normPhone(adminPhone) !== normPhone(opts.waPhoneNumber)) {
    return { handled: false };
  }

  const [cfg] = await opts.db
    .select()
    .from(odooConfigs)
    .where(eq(odooConfigs.tenantId, opts.tenantId))
    .limit(1);

  if (!cfg || !cfg.enabled) {
    return {
      handled: true,
      reply: "📊 *Odoo sync*\n\nOdoo is not connected for this store. Connect it in the portal under Settings → Odoo.",
    };
  }

  if (parsed.cmd === "status") {
    const s = await outboxStats(opts.db, opts.tenantId);
    const lines = [
      `📊 *Odoo sync status*`,
      ``,
      `• Connection: ${cfg.enabled ? "enabled" : "disabled"} (${cfg.syncMode} mode)`,
      `• Pending: ${s.pending + s.sending}`,
      `• Synced: ${s.sent}`,
      `• Failed (needs attention): ${s.failed}`,
      cfg.lastTestedAt
        ? `• Last connection test: ${cfg.lastTestOk ? "OK" : `failed (${cfg.lastTestError ?? "unknown"})`}`
        : `• Connection test: not run yet`,
      s.failed > 0 ? `` : null,
      s.failed > 0 ? `Open the portal reconciliation queue (Settings → Odoo) to retry failed items.` : null,
    ].filter(Boolean);
    return { handled: true, reply: lines.join("\n") };
  }

  // sync now
  const r = await syncNow(opts.db, opts.tenantId);
  const enq = r.sweep.salesEnqueued + r.sweep.expensesEnqueued + r.sweep.payoutsEnqueued + r.sweep.loansEnqueued;
  return {
    handled: true,
    reply: [
      `✅ *Odoo sync run complete*`,
      ``,
      `• New items queued: ${enq}`,
      `• Sent to Odoo: ${r.worker.sent}`,
      `• Failed: ${r.stats.failed}`,
      `• Still pending: ${r.stats.pending + r.stats.sending}`,
      r.stats.failed > 0 ? `Check Settings → Odoo in the portal to retry failed items.` : null,
    ].filter(Boolean).join("\n"),
  };
}
