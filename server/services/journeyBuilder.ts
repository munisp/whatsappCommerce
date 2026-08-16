/**
 * journeyBuilder.ts — broadcast journey definitions + execution (W17 F8).
 *
 * A journey is an ordered list of steps over the existing broadcast/template
 * infrastructure:
 *   send_template   — send a WhatsApp template (frequency-cap + quiet-hours
 *                     gated via nextAllowedSendAt, consent-gated)
 *   wait            — pause for a fixed duration (≤ 30 days)
 *   wait_for_reply  — pause until the customer replies (branch on_reply) or a
 *                     timeout elapses (branch on_timeout)
 *   condition       — branch on customer data (tag / last-order recency)
 *   exit            — terminate the run
 *
 * Definitions live in `broadcast_journeys`; per-customer progress in
 * `broadcast_journey_runs`, advanced by runDueJourneySteps() which is driven
 * from the cron wiring in server/_core/index.ts (same pattern as
 * runInventorySyncHeartbeat).
 */
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../db";
import {
  broadcastJourneyRuns,
  broadcastJourneys,
  customers,
} from "../../drizzle/schema";
import { normalizeWaPhone, sendWhatsAppTemplate } from "./waSender";
import { nextAllowedSendAtForTenant } from "./frequencyCap";

export const MAX_JOURNEY_STEPS = 20;
export const MAX_WAIT_MINUTES = 30 * 24 * 60; // 30 days
/** Poll cadence while parked on a wait_for_reply step. */
export const REPLY_POLL_MINUTES = 5;

// ── Step model ───────────────────────────────────────────────────────────────
export type JourneyCondition =
  | { kind: "has_tag"; tag: string }
  | { kind: "last_order_within_days"; days: number };

export type JourneyStep =
  | { id: string; type: "send_template"; templateName: string; languageCode?: string }
  | { id: string; type: "wait"; durationMinutes: number }
  | { id: string; type: "wait_for_reply"; timeoutMinutes: number; onReplyStepId: string; onTimeoutStepId: string }
  | { id: string; type: "condition"; condition: JourneyCondition; onTrueStepId: string; onFalseStepId: string }
  | { id: string; type: "exit" };

export type JourneyStatus = "draft" | "active" | "paused" | "archived";
export type JourneyRunState = "waiting" | "done" | "exited" | "failed";

export interface JourneyRunContext {
  /** ISO instant the current wait_for_reply step was entered. */
  stepStartedAt?: string;
  /** Why the run exited (e.g. "consent_withdrawn"). */
  exitReason?: string;
  /** Last step error when state = failed. */
  error?: string;
  /** Free-form per-run bag. */
  [k: string]: unknown;
}

// ── Validation ───────────────────────────────────────────────────────────────
/**
 * Validate a journey step graph. Returns a list of human-readable errors;
 * an empty list means the graph is saveable. Rules:
 *  - 1..MAX_JOURNEY_STEPS steps, unique ids, first step is the entry point
 *  - every branch reference (onReply/onTimeout/onTrue/onFalse) must resolve
 *  - no orphan steps: every step must be reachable from the entry step
 *  - wait / wait_for_reply durations within (0, 30 days]
 */
export function validateJourneySteps(steps: unknown): string[] {
  const errors: string[] = [];
  if (!Array.isArray(steps) || steps.length === 0) {
    return ["journey must have at least one step"];
  }
  if (steps.length > MAX_JOURNEY_STEPS) {
    errors.push(`journey may have at most ${MAX_JOURNEY_STEPS} steps (got ${steps.length})`);
  }
  const byId = new Map<string, JourneyStep>();
  for (const raw of steps) {
    const s = raw as JourneyStep;
    if (!s || typeof s !== "object" || typeof (s as any).id !== "string" || !(s as any).id) {
      errors.push("every step needs a non-empty string id");
      continue;
    }
    if (byId.has(s.id)) errors.push(`duplicate step id "${s.id}"`);
    byId.set(s.id, s);
    switch (s.type) {
      case "send_template":
        if (typeof (s as any).templateName !== "string" || !(s as any).templateName) {
          errors.push(`step "${s.id}": send_template needs a templateName`);
        }
        break;
      case "wait": {
        const d = (s as any).durationMinutes;
        if (typeof d !== "number" || !Number.isFinite(d) || d <= 0) {
          errors.push(`step "${s.id}": wait needs a positive durationMinutes`);
        } else if (d > MAX_WAIT_MINUTES) {
          errors.push(`step "${s.id}": wait may not exceed 30 days`);
        }
        break;
      }
      case "wait_for_reply": {
        const t = (s as any).timeoutMinutes;
        if (typeof t !== "number" || !Number.isFinite(t) || t <= 0) {
          errors.push(`step "${s.id}": wait_for_reply needs a positive timeoutMinutes`);
        } else if (t > MAX_WAIT_MINUTES) {
          errors.push(`step "${s.id}": wait_for_reply timeout may not exceed 30 days`);
        }
        for (const key of ["onReplyStepId", "onTimeoutStepId"] as const) {
          const ref = (s as any)[key];
          if (typeof ref !== "string" || !byId.has(ref) && !(steps as JourneyStep[]).some((x: any) => x?.id === ref)) {
            errors.push(`step "${s.id}": ${key} references unknown step "${ref}"`);
          }
        }
        break;
      }
      case "condition": {
        const c = (s as any).condition as JourneyCondition | undefined;
        if (!c || (c.kind !== "has_tag" && c.kind !== "last_order_within_days")) {
          errors.push(`step "${s.id}": condition kind must be has_tag or last_order_within_days`);
        } else if (c.kind === "has_tag" && (typeof c.tag !== "string" || !c.tag)) {
          errors.push(`step "${s.id}": has_tag condition needs a tag`);
        } else if (c.kind === "last_order_within_days" && (typeof c.days !== "number" || c.days <= 0)) {
          errors.push(`step "${s.id}": last_order_within_days needs positive days`);
        }
        for (const key of ["onTrueStepId", "onFalseStepId"] as const) {
          const ref = (s as any)[key];
          if (!(steps as JourneyStep[]).some((x: any) => x?.id === ref)) {
            errors.push(`step "${s.id}": ${key} references unknown step "${ref}"`);
          }
        }
        break;
      }
      case "exit":
        break;
      default:
        errors.push(`step "${(s as any).id}": unknown step type "${(s as any).type}"`);
    }
  }
  // Reachability from the entry step (no orphan branches).
  if (errors.length === 0 || byId.size > 0) {
    const entry = (steps[0] as JourneyStep)?.id;
    const reachable = new Set<string>();
    const stack = entry ? [entry] : [];
    while (stack.length) {
      const id = stack.pop()!;
      if (reachable.has(id)) continue;
      const s = byId.get(id);
      if (!s) continue;
      reachable.add(id);
      const next = byId.get(id);
      // sequential fall-through for non-branching steps
      const idx = (steps as JourneyStep[]).findIndex((x) => x.id === id);
      const fallThrough = (steps as JourneyStep[])[idx + 1];
      if (s.type === "wait_for_reply") {
        stack.push(s.onReplyStepId, s.onTimeoutStepId);
      } else if (s.type === "condition") {
        stack.push(s.onTrueStepId, s.onFalseStepId);
      } else if (s.type !== "exit" && fallThrough) {
        stack.push(fallThrough.id);
      }
      void next;
    }
    for (const s of steps as JourneyStep[]) {
      if (s?.id && !reachable.has(s.id)) {
        errors.push(`step "${s.id}" is unreachable (orphan branch)`);
      }
    }
  }
  return Array.from(new Set(errors));
}

// ── Execution ────────────────────────────────────────────────────────────────
type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

interface SendDeps {
  sendTemplate?: (tenantId: string, phone: string, templateName: string, languageCode: string) => Promise<unknown>;
}

interface ConsentRow {
  granted: boolean;
  withdrawnAt: Date | string | null;
}

/** Consent gate for journey sends: withdrawal (or missing/denied grant) blocks. */
export async function fetchConsentState(db: Db, tenantId: string, phone: string): Promise<ConsentRow | null> {
  try {
    const res: any = await db.execute(sql`
      SELECT granted, withdrawn_at AS "withdrawnAt" FROM consents
      WHERE tenant_id = ${tenantId} AND phone = ${phone} AND channel = 'whatsapp'
      LIMIT 1
    `);
    const rows: any[] = Array.isArray(res) ? res : (res?.rows ?? []);
    return rows[0] ?? null;
  } catch {
    return null; // fail closed: treated as not consented
  }
}

export function consentBlocksSend(c: ConsentRow | null): boolean {
  if (!c) return true;
  if (c.withdrawnAt) return true;
  return c.granted !== true;
}

/** Latest inbound reply at/after `since` for (tenant, phone)? */
export async function hasReplySince(db: Db, tenantId: string, phone: string, since: Date): Promise<boolean> {
  try {
    const res: any = await db.execute(sql`
      SELECT 1 AS one FROM whatsapp_customer_replies
      WHERE tenant_id = ${tenantId} AND from_phone = ${phone} AND created_at > ${since.toISOString()}
      LIMIT 1
    `);
    const rows: any[] = Array.isArray(res) ? res : (res?.rows ?? []);
    return rows.length > 0;
  } catch {
    return false;
  }
}

/** Evaluate a condition step against the customer row. */
export function evaluateCondition(cond: JourneyCondition, customer: { tags?: unknown; lastOrderAt?: Date | string | null } | null, now: Date): boolean {
  if (!customer) return false;
  if (cond.kind === "has_tag") {
    const tags = Array.isArray(customer.tags) ? (customer.tags as unknown[]).map(String) : [];
    return tags.includes(cond.tag);
  }
  const days = cond.days;
  const at = customer.lastOrderAt ? new Date(customer.lastOrderAt) : null;
  if (!at || Number.isNaN(at.getTime())) return false;
  return now.getTime() - at.getTime() <= days * 24 * 60 * 60_000;
}

interface RunRow {
  id: string;
  journeyId: string;
  tenantId: string;
  customerId: string;
  currentStep: number;
  state: JourneyRunState;
  context: JourneyRunContext | null;
  nextRunAt: Date | string | null;
}

async function updateRun(db: Db, id: string, patch: Partial<{ currentStep: number; state: JourneyRunState; context: JourneyRunContext; nextRunAt: Date | null }>, now: Date) {
  await db.update(broadcastJourneyRuns)
    .set({ ...patch, updatedAt: now } as any)
    .where(eq(broadcastJourneyRuns.id, id));
}

/**
 * Execute one run until it parks (waiting on a future nextRunAt), terminates
 * (done/exited), or fails. Bounded to avoid infinite loops on degenerate
 * graphs (validation should already prevent them).
 */
export async function processJourneyRun(
  db: Db,
  journey: { id: string; tenantId: string; steps: JourneyStep[] },
  run: RunRow,
  now: Date,
  deps: SendDeps = {},
): Promise<RunRow> {
  const steps = journey.steps;
  let { currentStep, state } = run;
  let context: JourneyRunContext = { ...(run.context ?? {}) };
  const sendTemplate = deps.sendTemplate
    ?? ((tenantId: string, phone: string, name: string, lang: string) =>
      sendWhatsAppTemplate(tenantId, phone, name, lang, undefined, { notifType: "journey_template" }));

  const [customer] = await db.select().from(customers)
    .where(and(eq(customers.id, run.customerId), eq(customers.tenantId, run.tenantId)))
    .limit(1)
    .catch(() => [] as any[]);
  const phone = customer?.whatsappPhone ? normalizeWaPhone(customer.whatsappPhone) : null;
  if (!phone) {
    state = "failed";
    context.error = "customer has no whatsapp phone";
    await updateRun(db, run.id, { state, context, nextRunAt: null }, now);
    return { ...run, currentStep, state, context, nextRunAt: null };
  }

  // Consent gate: withdrawal (or revoked grant) exits the run immediately.
  const consent = await fetchConsentState(db, run.tenantId, phone);
  if (consentBlocksSend(consent)) {
    state = "exited";
    context.exitReason = consent?.withdrawnAt ? "consent_withdrawn" : "not_consented";
    await updateRun(db, run.id, { state, context, nextRunAt: null }, now);
    return { ...run, currentStep, state, context, nextRunAt: null };
  }

  for (let guard = 0; guard < steps.length + 5; guard++) {
    const step = steps[currentStep];
    if (!step) { // ran off the end → done
      state = "done";
      await updateRun(db, run.id, { currentStep, state, context, nextRunAt: null }, now);
      return { ...run, currentStep, state, context, nextRunAt: null };
    }

    if (step.type === "exit") {
      state = "done";
      context.exitStep = step.id;
      await updateRun(db, run.id, { currentStep, state, context, nextRunAt: null }, now);
      return { ...run, currentStep, state, context, nextRunAt: null };
    }

    if (step.type === "send_template") {
      // Frequency cap + quiet hours: defer instead of sending when not allowed yet.
      const allowedAt = await nextAllowedSendAtForTenant(db, run.tenantId, phone, now);
      if (allowedAt.getTime() > now.getTime()) {
        await updateRun(db, run.id, { currentStep, context, nextRunAt: allowedAt }, now);
        return { ...run, currentStep, state, context, nextRunAt: allowedAt };
      }
      try {
        await sendTemplate(run.tenantId, phone, step.templateName, step.languageCode ?? "en_US");
      } catch (e: any) {
        state = "failed";
        context.error = `send_template "${step.templateName}" failed: ${e?.message ?? e}`;
        await updateRun(db, run.id, { currentStep, state, context, nextRunAt: null }, now);
        return { ...run, currentStep, state, context, nextRunAt: null };
      }
      delete context.stepStartedAt;
      currentStep += 1;
      continue;
    }

    if (step.type === "wait") {
      const nextRunAt = new Date(now.getTime() + step.durationMinutes * 60_000);
      delete context.stepStartedAt;
      currentStep += 1;
      await updateRun(db, run.id, { currentStep, context, nextRunAt }, now);
      return { ...run, currentStep, state, context, nextRunAt };
    }

    if (step.type === "wait_for_reply") {
      if (!context.stepStartedAt) context.stepStartedAt = now.toISOString();
      const startedAt = new Date(context.stepStartedAt);
      const deadline = new Date(startedAt.getTime() + step.timeoutMinutes * 60_000);
      const replied = await hasReplySince(db, run.tenantId, phone, startedAt);
      let target: string | null = null;
      if (replied) target = step.onReplyStepId;
      else if (now.getTime() >= deadline.getTime()) target = step.onTimeoutStepId;
      if (target) {
        const idx = steps.findIndex((s) => s.id === target);
        if (idx < 0) {
          state = "failed";
          context.error = `branch target "${target}" not found`;
          await updateRun(db, run.id, { currentStep, state, context, nextRunAt: null }, now);
          return { ...run, currentStep, state, context, nextRunAt: null };
        }
        delete context.stepStartedAt;
        currentStep = idx;
        continue;
      }
      // Still waiting: poll again shortly (never past the deadline).
      const nextRunAt = new Date(Math.min(now.getTime() + REPLY_POLL_MINUTES * 60_000, deadline.getTime()));
      await updateRun(db, run.id, { currentStep, context, nextRunAt }, now);
      return { ...run, currentStep, state, context, nextRunAt };
    }

    if (step.type === "condition") {
      const ok = evaluateCondition(step.condition, customer as any, now);
      const target = ok ? step.onTrueStepId : step.onFalseStepId;
      const idx = steps.findIndex((s) => s.id === target);
      if (idx < 0) {
        state = "failed";
        context.error = `branch target "${target}" not found`;
        await updateRun(db, run.id, { currentStep, state, context, nextRunAt: null }, now);
        return { ...run, currentStep, state, context, nextRunAt: null };
      }
      delete context.stepStartedAt;
      currentStep = idx;
      continue;
    }
  }
  state = "failed";
  context.error = "step execution guard exceeded (possible cycle)";
  await updateRun(db, run.id, { currentStep, state, context, nextRunAt: null }, now);
  return { ...run, currentStep, state, context, nextRunAt: null };
}

export interface JourneyTickSummary {
  processed: number;
  sent: number;
  deferred: number;
  done: number;
  exited: number;
  failed: number;
  skipped: number;
}

/**
 * Heartbeat entry point: process all due runs (state='waiting',
 * nextRunAt <= now) whose journey is still active. Never throws.
 */
export async function runDueJourneySteps(now: Date = new Date(), dbOverride?: Db, deps: SendDeps = {}): Promise<JourneyTickSummary> {
  const summary: JourneyTickSummary = { processed: 0, sent: 0, deferred: 0, done: 0, exited: 0, failed: 0, skipped: 0 };
  const db = dbOverride ?? (await getDb());
  if (!db) {
    console.warn("[journeys] DB unavailable — skipping tick");
    return summary;
  }
  let due: RunRow[] = [];
  try {
    due = await db.select().from(broadcastJourneyRuns)
      .where(and(
        eq(broadcastJourneyRuns.state, "waiting"),
        sql`"nextRunAt" IS NOT NULL AND "nextRunAt" <= ${now.toISOString()}`,
      ))
      .limit(100) as unknown as RunRow[];
  } catch (e: any) {
    console.error("[journeys] due-run query failed:", e?.message);
    return summary;
  }

  for (const run of due) {
    summary.processed++;
    try {
      const [journey] = await db.select().from(broadcastJourneys)
        .where(and(eq(broadcastJourneys.id, run.journeyId), eq(broadcastJourneys.tenantId, run.tenantId)))
        .limit(1);
      if (!journey || journey.status !== "active") {
        summary.skipped++; // draft/paused/archived journeys don't advance
        continue;
      }
      const steps = (journey.steps ?? []) as JourneyStep[];
      const errs = validateJourneySteps(steps);
      if (errs.length > 0) {
        await updateRun(db, run.id, { state: "failed", context: { ...(run.context ?? {}), error: `invalid journey: ${errs[0]}` }, nextRunAt: null }, now);
        summary.failed++;
        continue;
      }
      const after = await processJourneyRun(db, { id: journey.id, tenantId: journey.tenantId, steps }, run, now, deps);
      if (after.state === "done") summary.done++;
      else if (after.state === "exited") summary.exited++;
      else if (after.state === "failed") summary.failed++;
      else if (after.nextRunAt && new Date(after.nextRunAt).getTime() > now.getTime()) summary.deferred++;
      else summary.sent++;
    } catch (e: any) {
      summary.failed++;
      console.error(`[journeys] run ${run.id} failed:`, e?.message);
      await updateRun(db, run.id, { state: "failed", context: { ...(run.context ?? {}), error: e?.message ?? String(e) }, nextRunAt: null }, now).catch(() => {});
    }
  }
  return summary;
}
