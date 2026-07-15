import { z } from "zod";
import { router, protectedProcedure } from "../_core/trpc";
import { getDb } from "../db";
import { alertRules, alertRuleEvents } from "../../drizzle/schema";
import { eq, desc, gte, count } from "drizzle-orm";
import { randomUUID } from "crypto";

const RULE_TYPES = [
  "reconciliation_discrepancy",
  "low_stock",
  "failed_payments",
  "model_drift",
  "escalation_count",
] as const;

// Default heartbeat task_uid for the nightly reconciliation alert
const NIGHTLY_RECON_TASK_UID = "M7FY8UY7jUgczPs5EpcrUn";

const ruleTypeLabels: Record<string, string> = {
  reconciliation_discrepancy: "Reconciliation Discrepancy",
  low_stock: "Low Stock",
  failed_payments: "Failed Payments",
  model_drift: "Model Drift (PSI)",
  escalation_count: "Open Escalated Disputes",
};

const ruleTypeUnits: Record<string, string> = {
  reconciliation_discrepancy: "%",
  low_stock: "units",
  failed_payments: "%",
  model_drift: "PSI",
  escalation_count: "disputes",
};

export const alertRulesRouter = router({
  // ── List all rules ──────────────────────────────────────────────────────────
  list: protectedProcedure.query(async () => {
    const db = await getDb();
    if (!db) return [];
    const rows = await db.select().from(alertRules).orderBy(desc(alertRules.createdAt));
    return rows.map((r) => ({
      ...r,
      label: ruleTypeLabels[r.ruleType] ?? r.ruleType,
      unit: ruleTypeUnits[r.ruleType] ?? "",
      threshold: parseFloat(r.threshold as unknown as string),
    }));
  }),

  // ── Create a new rule ───────────────────────────────────────────────────────
  create: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1).max(128),
        ruleType: z.enum(RULE_TYPES),
        threshold: z.number().positive(),
        windowHours: z.number().int().min(1).max(720).default(24),
        isEnabled: z.boolean().default(true),
        notifyOwnerOnTrigger: z.boolean().default(true),
        heartbeatTaskUid: z.string().optional(),
        cooldownMinutes: z.number().int().min(0).max(1440).default(60),
      })
    )
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      const id = randomUUID();
      // Auto-assign the registered heartbeat task_uid for reconciliation rules
      const taskUid =
        input.heartbeatTaskUid ??
        (input.ruleType === "reconciliation_discrepancy" ? NIGHTLY_RECON_TASK_UID : null);
      await db.insert(alertRules).values({
        id,
        name: input.name,
        ruleType: input.ruleType,
        threshold: String(input.threshold),
        windowHours: input.windowHours,
        isEnabled: input.isEnabled,
        notifyOwnerOnTrigger: input.notifyOwnerOnTrigger,
        heartbeatTaskUid: taskUid ?? undefined,
        cooldownMinutes: input.cooldownMinutes,
      });
      const [created] = await db.select().from(alertRules).where(eq(alertRules.id, id));
      return { ...created, threshold: parseFloat(created.threshold as unknown as string) };
    }),

  // ── Update an existing rule ─────────────────────────────────────────────────
  update: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        name: z.string().min(1).max(128).optional(),
        threshold: z.number().positive().optional(),
        windowHours: z.number().int().min(1).max(720).optional(),
        isEnabled: z.boolean().optional(),
        notifyOwnerOnTrigger: z.boolean().optional(),
        cooldownMinutes: z.number().int().min(0).max(1440).optional(),
      })
    )
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      const { id, threshold, ...rest } = input;
      await db
        .update(alertRules)
        .set({
          ...rest,
          ...(threshold !== undefined ? { threshold: String(threshold) } : {}),
          updatedAt: new Date(),
        })
        .where(eq(alertRules.id, id));
      const [updated] = await db.select().from(alertRules).where(eq(alertRules.id, id));
      return { ...updated, threshold: parseFloat(updated.threshold as unknown as string) };
    }),

  // ── Toggle enabled/disabled ─────────────────────────────────────────────────
  toggle: protectedProcedure
    .input(z.object({ id: z.string().uuid(), isEnabled: z.boolean() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      await db
        .update(alertRules)
        .set({ isEnabled: input.isEnabled, updatedAt: new Date() })
        .where(eq(alertRules.id, input.id));
      return { ok: true };
    }),

  // ── Delete a rule ───────────────────────────────────────────────────────────
  delete: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      await db.delete(alertRules).where(eq(alertRules.id, input.id));
      return { ok: true };
    }),

  // ── Get threshold metadata for each rule type ───────────────────────────────
  getRuleTypeMeta: protectedProcedure.query(() => {
    return RULE_TYPES.map((t) => ({
      value: t,
      label: ruleTypeLabels[t],
      unit: ruleTypeUnits[t],
      defaultThreshold:
        t === "model_drift" ? 0.2 : t === "low_stock" ? 10 : 5,
      description:
        t === "reconciliation_discrepancy"
          ? "Alert when unreconciled transactions exceed this % of total in the window"
          : t === "low_stock"
          ? "Alert when a product's stock quantity falls below this count"
          : t === "failed_payments"
          ? "Alert when failed payment attempts exceed this % of total in the window"
          : t === "escalation_count"
          ? "Alert when the number of open escalated disputes exceeds this threshold"
          : "Alert when the Population Stability Index (PSI) exceeds this value",
    }));
  }),

  // ── Seed default rules on first admin login ─────────────────────────────────
  // Idempotent: only inserts if no rules exist yet.
  seedDefaults: protectedProcedure.mutation(async () => {
    const db = await getDb();
    if (!db) throw new Error("DB unavailable");
    const existing = await db.select({ id: alertRules.id }).from(alertRules).limit(1);
    if (existing.length > 0) return { seeded: false, reason: "Rules already exist" };

    const defaults = [
      {
        id: randomUUID(),
        name: "Nightly Reconciliation Discrepancy",
        ruleType: "reconciliation_discrepancy" as const,
        threshold: "5",
        windowHours: 24,
        isEnabled: true,
        notifyOwnerOnTrigger: true,
        heartbeatTaskUid: NIGHTLY_RECON_TASK_UID,
        cooldownMinutes: 120,
      },
      {
        id: randomUUID(),
        name: "High Failed Payment Rate",
        ruleType: "failed_payments" as const,
        threshold: "10",
        windowHours: 6,
        isEnabled: true,
        notifyOwnerOnTrigger: true,
        heartbeatTaskUid: undefined,
        cooldownMinutes: 60,
      },
      {
        id: randomUUID(),
        name: "Low Stock Warning",
        ruleType: "low_stock" as const,
        threshold: "10",
        windowHours: 24,
        isEnabled: true,
        notifyOwnerOnTrigger: true,
        heartbeatTaskUid: undefined,
        cooldownMinutes: 240,
      },
      {
        id: randomUUID(),
        name: "ML Model Drift Alert",
        ruleType: "model_drift" as const,
        threshold: "0.2",
        windowHours: 168,
        isEnabled: true,
        notifyOwnerOnTrigger: true,
        heartbeatTaskUid: undefined,
        cooldownMinutes: 720,
      },
      {
        id: randomUUID(),
        name: "High Escalated Dispute Count",
        ruleType: "escalation_count" as const,
        threshold: "5",
        windowHours: 24,
        isEnabled: true,
        notifyOwnerOnTrigger: true,
        heartbeatTaskUid: undefined,
        cooldownMinutes: 120,
      },
    ];

    await db.insert(alertRules).values(defaults);
    return { seeded: true, count: defaults.length };
  }),

  // ── List trigger events (last 30 days by default) ───────────────────────────
  listEvents: protectedProcedure
    .input(
      z.object({
        ruleId: z.string().uuid().optional(),
        days: z.number().int().min(1).max(90).default(30),
        limit: z.number().int().min(1).max(200).default(50),
      })
    )
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return { events: [], total: 0 };
      const since = new Date(Date.now() - input.days * 24 * 3600 * 1000);
      const events = await db
        .select()
        .from(alertRuleEvents)
        .where(
          input.ruleId
            ? eq(alertRuleEvents.ruleId, input.ruleId)
            : gte(alertRuleEvents.triggeredAt, since)
        )
        .orderBy(desc(alertRuleEvents.triggeredAt))
        .limit(input.limit);
      const [{ value: total }] = await db
        .select({ value: count() })
        .from(alertRuleEvents)
        .where(gte(alertRuleEvents.triggeredAt, since));
      return {
        events: events.map((e) => ({
          ...e,
          actualValue: parseFloat(e.actualValue as unknown as string),
          threshold: parseFloat(e.threshold as unknown as string),
        })),
        total: Number(total),
      };
    }),
});
