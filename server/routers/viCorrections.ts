import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import { visualInventoryCorrections, visualInventorySessions, labelStudioConfigs } from "../../drizzle/schema";
import { eq, and, desc } from "drizzle-orm";

// ── Visual Inventory Corrections Router ───────────────────────────────────────
export const viCorrectionsRouter = router({

  // List corrections for a session
  listBySession: protectedProcedure
    .input(z.object({ sessionId: z.string() }))
    .query(async ({ ctx, input }) => {
      const db = (await getDb())!;
      const tenantId = (ctx.user as { tenantId?: string }).tenantId ?? ctx.user.openId;
      const items = await db.select().from(visualInventoryCorrections)
        .where(and(
          eq(visualInventoryCorrections.sessionId, input.sessionId),
          eq(visualInventoryCorrections.tenantId, tenantId),
        ))
        .orderBy(desc(visualInventoryCorrections.createdAt));
      return { items };
    }),

  // List recent corrections across all sessions
  listRecent: protectedProcedure
    .input(z.object({ limit: z.number().min(1).max(100).default(50) }))
    .query(async ({ ctx, input }) => {
      const db = (await getDb())!;
      const tenantId = (ctx.user as { tenantId?: string }).tenantId ?? ctx.user.openId;
      const items = await db.select().from(visualInventoryCorrections)
        .where(eq(visualInventoryCorrections.tenantId, tenantId))
        .orderBy(desc(visualInventoryCorrections.createdAt))
        .limit(input.limit);
      return { items };
    }),

  // Save a correction (inline count edit from scan history)
  saveCorrection: protectedProcedure
    .input(z.object({
      sessionId: z.string(),
      detectedLabel: z.string().min(1),
      originalCount: z.number().int().min(0),
      correctedCount: z.number().int().min(0),
      boundingBoxes: z.array(z.object({
        x: z.number(),
        y: z.number(),
        width: z.number(),
        height: z.number(),
        label: z.string().optional(),
        confidence: z.number().optional(),
      })).default([]),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = (await getDb())!;
      const tenantId = (ctx.user as { tenantId?: string }).tenantId ?? ctx.user.openId;
      const userId = String(ctx.user.id);

      // Upsert: if a correction for this session+label already exists, update it
      const existing = await db.select({ id: visualInventoryCorrections.id })
        .from(visualInventoryCorrections)
        .where(and(
          eq(visualInventoryCorrections.sessionId, input.sessionId),
          eq(visualInventoryCorrections.tenantId, tenantId),
          eq(visualInventoryCorrections.detectedLabel, input.detectedLabel),
        ))
        .limit(1);

      if (existing.length > 0) {
        await db.update(visualInventoryCorrections).set({
          correctedCount: input.correctedCount,
          boundingBoxes: input.boundingBoxes,
          correctedBy: userId,
          exportedToLabelStudio: false, // reset so it gets re-exported with new value
        }).where(eq(visualInventoryCorrections.id, existing[0].id));
        return { id: existing[0].id, updated: true };
      }

      const [inserted] = await db.insert(visualInventoryCorrections).values({
        sessionId: input.sessionId,
        tenantId,
        detectedLabel: input.detectedLabel,
        originalCount: input.originalCount,
        correctedCount: input.correctedCount,
        boundingBoxes: input.boundingBoxes,
        correctedBy: userId,
      }).returning({ id: visualInventoryCorrections.id });

      return { id: inserted.id, updated: false };
    }),

  // Bulk save corrections for a session (called when user confirms all edits)
  bulkSaveCorrections: protectedProcedure
    .input(z.object({
      sessionId: z.string(),
      corrections: z.array(z.object({
        detectedLabel: z.string(),
        originalCount: z.number().int().min(0),
        correctedCount: z.number().int().min(0),
        boundingBoxes: z.array(z.any()).default([]),
      })),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = (await getDb())!;
      const tenantId = (ctx.user as { tenantId?: string }).tenantId ?? ctx.user.openId;
      const userId = String(ctx.user.id);
      let saved = 0;
      for (const c of input.corrections) {
        if (c.correctedCount === c.originalCount) continue; // skip unchanged
        const existing = await db.select({ id: visualInventoryCorrections.id })
          .from(visualInventoryCorrections)
          .where(and(
            eq(visualInventoryCorrections.sessionId, input.sessionId),
            eq(visualInventoryCorrections.tenantId, tenantId),
            eq(visualInventoryCorrections.detectedLabel, c.detectedLabel),
          ))
          .limit(1);
        if (existing.length > 0) {
          await db.update(visualInventoryCorrections).set({
            correctedCount: c.correctedCount,
            correctedBy: userId,
            exportedToLabelStudio: false,
          }).where(eq(visualInventoryCorrections.id, existing[0].id));
        } else {
          await db.insert(visualInventoryCorrections).values({
            sessionId: input.sessionId,
            tenantId,
            detectedLabel: c.detectedLabel,
            originalCount: c.originalCount,
            correctedCount: c.correctedCount,
            boundingBoxes: c.boundingBoxes,
            correctedBy: userId,
          });
        }
        saved++;
      }
      return { saved, message: `${saved} correction(s) saved as ground-truth labels` };
    }),

  // Export pending corrections to Label Studio
  exportToLabelStudio: protectedProcedure.mutation(async ({ ctx }) => {
    const db = (await getDb())!;
    const tenantId = (ctx.user as { tenantId?: string }).tenantId ?? ctx.user.openId;
    const [cfg] = await db.select().from(labelStudioConfigs).where(eq(labelStudioConfigs.tenantId, tenantId)).limit(1);
    if (!cfg?.labelStudioUrl || !cfg?.apiToken || !cfg?.projectId) {
      return { exported: 0, error: "Label Studio not configured" };
    }
    const pending = await db.select().from(visualInventoryCorrections)
      .where(and(
        eq(visualInventoryCorrections.tenantId, tenantId),
        eq(visualInventoryCorrections.exportedToLabelStudio, false),
      ))
      .limit(100);
    if (pending.length === 0) return { exported: 0, message: "No pending corrections to export" };

    // Build Label Studio tasks from corrections
    const tasks = pending.map(c => ({
      data: {
        session_id: c.sessionId,
        detected_label: c.detectedLabel,
        original_count: c.originalCount,
        corrected_count: c.correctedCount,
        correction_id: c.id,
      },
      annotations: [{
        result: (c.boundingBoxes as Array<{x: number; y: number; width: number; height: number}>).map((bbox, idx) => ({
          id: `${c.id}-${idx}`,
          type: "rectanglelabels",
          from_name: "label",
          to_name: "image",
          value: { x: bbox.x, y: bbox.y, width: bbox.width, height: bbox.height, rotation: 0, rectanglelabels: [c.detectedLabel] },
        })),
        ground_truth: true,
      }],
    }));

    try {
      const resp = await fetch(`${cfg.labelStudioUrl}/api/projects/${cfg.projectId}/import`, {
        method: "POST",
        headers: { Authorization: `Token ${cfg.apiToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(tasks),
        signal: AbortSignal.timeout(15000),
      });
      if (!resp.ok) return { exported: 0, error: `Label Studio API error: ${resp.status}` };
      // Mark as exported
      for (const c of pending) {
        await db.update(visualInventoryCorrections).set({ exportedToLabelStudio: true }).where(eq(visualInventoryCorrections.id, c.id));
      }
      return { exported: pending.length, message: `Exported ${pending.length} corrections to Label Studio` };
    } catch (err: unknown) {
      return { exported: 0, error: err instanceof Error ? err.message : "Export failed" };
    }
  }),

  // Stats
  stats: protectedProcedure.query(async ({ ctx }) => {
    const db = (await getDb())!;
    const tenantId = (ctx.user as { tenantId?: string }).tenantId ?? ctx.user.openId;
    const all = await db.select().from(visualInventoryCorrections).where(eq(visualInventoryCorrections.tenantId, tenantId));
    return {
      total: all.length,
      exported: all.filter(c => c.exportedToLabelStudio).length,
      pending: all.filter(c => !c.exportedToLabelStudio).length,
      uniqueSessions: new Set(all.map(c => c.sessionId)).size,
    };
  }),
});
