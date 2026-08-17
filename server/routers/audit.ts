import { z } from "zod";
import { and, desc, eq, gte, lte, SQL } from "drizzle-orm";
import { adminProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import { auditLogs, NewAuditLog } from "../../drizzle/schema";
import { appendAuditEventTx } from "../services/auditChain";

/**
 * Append a forensic audit row. Fire-and-forget safe: failures are logged but
 * never thrown, so auditing can never break a money-movement path.
 *
 * W19 SOC2: every row is ALSO appended to the tamper-evident audit_chain
 * (hash-chained; verifiable via compliance.verifyAuditChain). The chain
 * append shares the same fire-and-forget guard.
 */
export async function writeAuditLog(entry: Omit<NewAuditLog, "id" | "createdAt">): Promise<void> {
  try {
    const db = await getDb();
    if (!db) return;
    await db.insert(auditLogs).values(entry);
    await appendAuditEventTx(db, {
      tenantId: entry.tenantId ?? null,
      eventType: `audit:${entry.action}`,
      actorId: entry.actorId ?? null,
      payload: {
        entityType: entry.entityType,
        entityId: entry.entityId ?? null,
        summary: entry.summary ?? null,
      },
    });
  } catch (err: any) {
    console.error("[audit] failed to write audit log:", err?.message);
  }
}

export const auditRouter = router({
  /**
   * Admin forensic export of the audit trail. Filters: actor, action,
   * entity, and an optional created-at date range (ISO strings).
   */
  export: adminProcedure
    .input(z.object({
      actorId: z.string().optional(),
      action: z.string().optional(),
      entityType: z.string().optional(),
      entityId: z.string().optional(),
      from: z.string().datetime().optional(),
      to: z.string().datetime().optional(),
      limit: z.number().int().min(1).max(5000).default(500),
    }))
    .query(async ({ input }) => {
      const db = (await getDb())!;
      const conds: SQL[] = [];
      if (input.actorId) conds.push(eq(auditLogs.actorId, input.actorId));
      if (input.action) conds.push(eq(auditLogs.action, input.action));
      if (input.entityType) conds.push(eq(auditLogs.entityType, input.entityType));
      if (input.entityId) conds.push(eq(auditLogs.entityId, input.entityId));
      if (input.from) conds.push(gte(auditLogs.createdAt, new Date(input.from)));
      if (input.to) conds.push(lte(auditLogs.createdAt, new Date(input.to)));
      const rows = await db
        .select()
        .from(auditLogs)
        .where(conds.length ? and(...conds) : undefined)
        .orderBy(desc(auditLogs.createdAt))
        .limit(input.limit);
      return { exportedAt: new Date().toISOString(), count: rows.length, rows };
    }),
});
