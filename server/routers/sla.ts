import { z } from "zod";
import { protectedProcedure, adminProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import { escrowSlaConfig, escrowTransactions, escrowDisputes } from "../../drizzle/schema";
import { eq, isNull, and, inArray } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { emitNotification } from "./notifications";
import { settleEscrowAtomic } from "./escrow";

// ─── SLA status helpers ───────────────────────────────────────────────────────
export type SlaStatus = "ok" | "warning" | "overdue" | "no_deadline";

export function computeSlaStatus(
  slaDeadline: Date | null | undefined,
  warningHours: number
): SlaStatus {
  if (!slaDeadline) return "no_deadline";
  const now = Date.now();
  const deadlineMs = new Date(slaDeadline).getTime();
  const warningMs = warningHours * 60 * 60 * 1000;
  if (now >= deadlineMs) return "overdue";
  if (now >= deadlineMs - warningMs) return "warning";
  return "ok";
}

export function computeCountdown(slaDeadline: Date | null | undefined): {
  hours: number;
  minutes: number;
  seconds: number;
  totalSeconds: number;
  isExpired: boolean;
} {
  if (!slaDeadline) return { hours: 0, minutes: 0, seconds: 0, totalSeconds: 0, isExpired: false };
  const diff = Math.max(0, new Date(slaDeadline).getTime() - Date.now());
  const totalSeconds = Math.floor(diff / 1000);
  return {
    hours: Math.floor(totalSeconds / 3600),
    minutes: Math.floor((totalSeconds % 3600) / 60),
    seconds: totalSeconds % 60,
    totalSeconds,
    isExpired: diff === 0,
  };
}

// ─── Get effective SLA config for a tenant (falls back to platform default) ──
export async function getEffectiveSlaConfig(db: NonNullable<Awaited<ReturnType<typeof getDb>>>, tenantId: string) {
  // Try tenant-specific config first
  const tenantConfig = await db
    .select()
    .from(escrowSlaConfig)
    .where(eq(escrowSlaConfig.tenantId, tenantId));
  if (tenantConfig.length > 0) return tenantConfig[0];
  // Fall back to platform default (tenantId IS NULL)
  const defaultConfig = await db
    .select()
    .from(escrowSlaConfig)
    .where(isNull(escrowSlaConfig.tenantId));
  if (defaultConfig.length > 0) return defaultConfig[0];
  // Hard-coded fallback
  return { releaseDeadlineHours: 72, warningHours: 24, autoReleaseEnabled: true, tenantId: null };
}

// ─── Heartbeat: scan escrows for SLA breaches ─────────────────────────────────
// Invoked by the cron endpoint (caller auth is enforced at the HTTP layer).
// Auto-settlement goes through the SAME atomic helper as manual release:
// a guarded state transition + merchant wallet credit + wallet ledger entry in
// one DB transaction. Escrows with an open dispute are NEVER auto-settled and
// disputes are never auto-resolved.
export async function runSlaScan() {
  const db = await getDb();
  if (!db) return { scanned: 0, warned: 0, overdue: 0, settled: 0, skippedDisputed: 0 };

  // Get all active escrows (held state)
  const activeEscrows = await db
    .select()
    .from(escrowTransactions)
    .where(inArray(escrowTransactions.state, ["escrow_held", "delivery_confirmed"]));

  let warned = 0;
  let overdue = 0;
  let settled = 0;
  let skippedDisputed = 0;

  for (const escrow of activeEscrows) {
    // The escrow's SLA clock is the buyer-confirmation deadline (the column
    // previously read, `slaDeadline`, does not exist on escrow_transactions).
    const slaDeadline = escrow.buyerConfirmDeadline as Date | null;
    if (!slaDeadline) continue;

    const config = await getEffectiveSlaConfig(db, escrow.tenantId);
    const status = computeSlaStatus(slaDeadline, config.warningHours ?? 24);

    if (status === "warning") {
      warned++;
      await emitNotification({
        tenantId: escrow.tenantId,
        type: "system",
        title: "Escrow Release Deadline Approaching",
        body: `Order #${escrow.orderId ?? escrow.id.slice(0, 8)} escrow will auto-release in less than ${config.warningHours} hours.`,
        metadata: { escrowId: escrow.id, slaDeadline: slaDeadline.toISOString() },
      });
    } else if (status === "overdue" && config.autoReleaseEnabled) {
      // NEVER auto-settle an escrow with an open dispute — and never
      // auto-resolve disputes. Skip it for human review.
      const [openDispute] = await db
        .select({ id: escrowDisputes.id })
        .from(escrowDisputes)
        .where(and(
          eq(escrowDisputes.escrowTxId, escrow.id),
          inArray(escrowDisputes.status, ["open", "under_review", "escalated"]),
        ))
        .limit(1);
      if (openDispute) {
        skippedDisputed++;
        continue;
      }

      overdue++;
      // Atomic guarded release: state transition + merchant wallet credit +
      // wallet ledger entry in a single transaction (PSP mode). In PSSP mode
      // this issues the bank release instruction instead.
      const result = await settleEscrowAtomic(db, escrow.id, {
        autoConfirmed: true,
        allowedFromStates: ["escrow_held", "delivery_confirmed"],
        descriptionPrefix: "Auto-release (SLA deadline)",
      });
      if (!result.transitioned) continue; // state changed concurrently — skip

      settled++;
      await emitNotification({
        tenantId: escrow.tenantId,
        type: "escrow_settled",
        title: "Escrow Auto-Released (SLA Deadline)",
        body: `Order #${escrow.orderId ?? escrow.id.slice(0, 8)} escrow was automatically released after the ${config.releaseDeadlineHours}h SLA deadline.`,
        metadata: { escrowId: escrow.id, autoReleased: true },
      });
    }
  }

  return { scanned: activeEscrows.length, warned, overdue, settled, skippedDisputed };
}

// ─── tRPC router ─────────────────────────────────────────────────────────────
export const slaRouter = router({
  getConfig: protectedProcedure.query(async ({ ctx }) => {
    const tenantId = ctx.user.tenantId;
    if (!tenantId) throw new TRPCError({ code: "FORBIDDEN" });
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    return getEffectiveSlaConfig(db, tenantId);
  }),

  updateConfig: protectedProcedure
    .input(z.object({
      releaseDeadlineHours: z.number().int().min(1).max(720),
      warningHours: z.number().int().min(1).max(168),
      autoReleaseEnabled: z.boolean(),
    }))
    .mutation(async ({ ctx, input }) => {
      const tenantId = ctx.user.tenantId;
      if (!tenantId) throw new TRPCError({ code: "FORBIDDEN" });
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      const existing = await db
        .select()
        .from(escrowSlaConfig)
        .where(eq(escrowSlaConfig.tenantId, tenantId));

      if (existing.length > 0) {
        await db
          .update(escrowSlaConfig)
          .set({ ...input, updatedAt: new Date() })
          .where(eq(escrowSlaConfig.tenantId, tenantId));
      } else {
        await db.insert(escrowSlaConfig).values({
          id: crypto.randomUUID(),
          tenantId,
          ...input,
        });
      }
      return { success: true };
    }),

  // Admin: get platform-wide SLA overview
  getPlatformOverview: adminProcedure.query(async () => {
    const db = await getDb();
    if (!db) return { ok: [], warning: [], overdue: [] };

    const activeEscrows = await db
      .select()
      .from(escrowTransactions)
      .where(inArray(escrowTransactions.state, ["escrow_held", "delivery_confirmed"]));

    const ok: typeof activeEscrows = [];
    const warning: typeof activeEscrows = [];
    const overdue: typeof activeEscrows = [];

    for (const escrow of activeEscrows) {
      const slaDeadline = escrow.buyerConfirmDeadline as Date | null;
      const config = await getEffectiveSlaConfig(db, escrow.tenantId);
      const status = computeSlaStatus(slaDeadline, config.warningHours ?? 24);
      if (status === "overdue") overdue.push(escrow);
      else if (status === "warning") warning.push(escrow);
      else ok.push(escrow);
    }

    return {
      ok: ok.length,
      warning: warning.length,
      overdue: overdue.length,
      total: activeEscrows.length,
      warningItems: warning.slice(0, 10).map(e => ({
        id: e.id,
        orderId: e.orderId,
        tenantId: e.tenantId,
        amount: e.amount,
        slaDeadline: e.buyerConfirmDeadline,
      })),
      overdueItems: overdue.slice(0, 10).map(e => ({
        id: e.id,
        orderId: e.orderId,
        tenantId: e.tenantId,
        amount: e.amount,
        slaDeadline: e.buyerConfirmDeadline,
      })),
    };
  }),

  // Per-escrow SLA status (used by countdown component)
  getEscrowSlaStatus: protectedProcedure
    .input(z.object({ escrowId: z.string() }))
    .query(async ({ ctx, input }) => {
      const tenantId = ctx.user.tenantId;
      if (!tenantId) throw new TRPCError({ code: "FORBIDDEN" });
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      const escrows = await db
        .select()
        .from(escrowTransactions)
        .where(and(eq(escrowTransactions.id, input.escrowId), eq(escrowTransactions.tenantId, tenantId)));
      if (!escrows.length) throw new TRPCError({ code: "NOT_FOUND" });
      const escrow = escrows[0];
      const config = await getEffectiveSlaConfig(db, tenantId);
      const slaDeadline = escrow.buyerConfirmDeadline as Date | null;
      return {
        escrowId: escrow.id,
        slaDeadline,
        status: computeSlaStatus(slaDeadline, config.warningHours ?? 24),
        countdown: computeCountdown(slaDeadline),
        config,
      };
    }),
});
