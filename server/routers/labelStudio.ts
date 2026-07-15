import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import { labelStudioConfigs, visualInventorySessions, visualInventoryCorrections } from "../../drizzle/schema";
import { eq, and, isNull } from "drizzle-orm";

// ── Label Studio Router ────────────────────────────────────────────────────────
export const labelStudioRouter = router({

  // Get or create the Label Studio config for the current tenant
  getConfig: protectedProcedure.query(async ({ ctx }) => {
    const db = (await getDb())!;
    const tenantId = (ctx.user as { tenantId?: string }).tenantId ?? ctx.user.openId;
    const existing = await db.select().from(labelStudioConfigs).where(eq(labelStudioConfigs.tenantId, tenantId)).limit(1);
    return { config: existing[0] ?? null };
  }),

  // Save Label Studio connection config
  saveConfig: protectedProcedure
    .input(z.object({
      labelStudioUrl: z.string().url("Must be a valid URL").optional(),
      apiToken: z.string().min(1).optional(),
      projectId: z.number().int().positive().optional(),
      projectName: z.string().optional(),
      autoExport: z.boolean().default(false),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = (await getDb())!;
      const tenantId = (ctx.user as { tenantId?: string }).tenantId ?? ctx.user.openId;
      const existing = await db.select({ id: labelStudioConfigs.id }).from(labelStudioConfigs).where(eq(labelStudioConfigs.tenantId, tenantId)).limit(1);
      if (existing.length > 0) {
        await db.update(labelStudioConfigs).set({ ...input, updatedAt: new Date() }).where(eq(labelStudioConfigs.tenantId, tenantId));
      } else {
        await db.insert(labelStudioConfigs).values({ tenantId, ...input });
      }
      return { ok: true };
    }),

  // Test connection to Label Studio
  testConnection: protectedProcedure.mutation(async ({ ctx }) => {
    const db = (await getDb())!;
    const tenantId = (ctx.user as { tenantId?: string }).tenantId ?? ctx.user.openId;
    const [cfg] = await db.select().from(labelStudioConfigs).where(eq(labelStudioConfigs.tenantId, tenantId)).limit(1);
    if (!cfg?.labelStudioUrl || !cfg?.apiToken) {
      return { connected: false, error: "Label Studio URL and API token are required" };
    }
    try {
      const resp = await fetch(`${cfg.labelStudioUrl}/api/projects`, {
        headers: { Authorization: `Token ${cfg.apiToken}` },
        signal: AbortSignal.timeout(5000),
      });
      if (!resp.ok) return { connected: false, error: `HTTP ${resp.status}: ${resp.statusText}` };
      const data = await resp.json() as { count?: number; results?: { id: number; title: string }[] };
      await db.update(labelStudioConfigs).set({ isConnected: true, updatedAt: new Date() }).where(eq(labelStudioConfigs.tenantId, tenantId));
      return { connected: true, projectCount: data.count ?? 0, projects: data.results?.slice(0, 10) ?? [] };
    } catch (err: unknown) {
      await db.update(labelStudioConfigs).set({ isConnected: false, updatedAt: new Date() }).where(eq(labelStudioConfigs.tenantId, tenantId));
      return { connected: false, error: err instanceof Error ? err.message : "Connection failed" };
    }
  }),

  // Export scan sessions to Label Studio as annotation tasks
  exportSessions: protectedProcedure
    .input(z.object({
      sessionIds: z.array(z.string()).optional(), // if empty, exports all un-exported sessions
      limit: z.number().min(1).max(100).default(50),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = (await getDb())!;
      const tenantId = (ctx.user as { tenantId?: string }).tenantId ?? ctx.user.openId;
      const [cfg] = await db.select().from(labelStudioConfigs).where(eq(labelStudioConfigs.tenantId, tenantId)).limit(1);
      if (!cfg?.labelStudioUrl || !cfg?.apiToken || !cfg?.projectId) {
        return { exported: 0, error: "Label Studio not configured. Set URL, API token, and project ID first." };
      }

      // Fetch sessions to export
      const sessions = await db.select().from(visualInventorySessions)
        .where(eq(visualInventorySessions.tenantId, tenantId))
        .limit(input.limit);

      const toExport = input.sessionIds?.length
        ? sessions.filter(s => input.sessionIds!.includes(s.id))
        : sessions.filter(s => s.imageUrl && s.status === "completed");

      if (toExport.length === 0) return { exported: 0, message: "No sessions to export" };

      // Build Label Studio tasks (COCO-compatible format)
      const tasks = toExport.map(session => ({
        data: {
          image: session.imageUrl,
          session_id: session.id,
          tenant_id: tenantId,
          scan_location: session.notes ?? null,
          scanned_at: session.createdAt,
          detected_items: session.detectedItems,
          ai_model: session.modelUsed,
        },
        meta: {
          session_id: session.id,
          platform: "whatsapp-commerce-visual-inventory",
        },
        annotations: [],
        predictions: [
          {
            model_version: session.modelUsed ?? "yolo11",
            score: 0.85,
            result: ((session.detectedItems ?? []) as Array<{label: string; count: number; confidence: number; boundingBoxes?: Array<{x: number; y: number; width: number; height: number}>}>).flatMap((item) =>
              (item.boundingBoxes ?? []).map((bbox, idx) => ({
                id: `${session.id}-${item.label}-${idx}`,
                type: "rectanglelabels",
                from_name: "label",
                to_name: "image",
                value: {
                  x: bbox.x,
                  y: bbox.y,
                  width: bbox.width,
                  height: bbox.height,
                  rotation: 0,
                  rectanglelabels: [item.label],
                },
                score: item.confidence,
              }))
            ),
          },
        ],
      }));

      // Push tasks to Label Studio API
      try {
        const resp = await fetch(`${cfg.labelStudioUrl}/api/projects/${cfg.projectId}/import`, {
          method: "POST",
          headers: {
            Authorization: `Token ${cfg.apiToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(tasks),
          signal: AbortSignal.timeout(30000),
        });
        if (!resp.ok) {
          const errText = await resp.text();
          return { exported: 0, error: `Label Studio API error: ${resp.status} ${errText.slice(0, 200)}` };
        }
        const result = await resp.json() as { task_count?: number };
        const exportedCount = result.task_count ?? tasks.length;
        // Update config stats
        await db.update(labelStudioConfigs).set({
          lastExportedAt: new Date(),
          exportedCount: (cfg.exportedCount ?? 0) + exportedCount,
          updatedAt: new Date(),
        }).where(eq(labelStudioConfigs.tenantId, tenantId));
        return { exported: exportedCount, message: `Exported ${exportedCount} tasks to Label Studio project #${cfg.projectId}` };
      } catch (err: unknown) {
        return { exported: 0, error: err instanceof Error ? err.message : "Export failed" };
      }
    }),

  // Get export stats
  stats: protectedProcedure.query(async ({ ctx }) => {
    const db = (await getDb())!;
    const tenantId = (ctx.user as { tenantId?: string }).tenantId ?? ctx.user.openId;
    const [cfg] = await db.select().from(labelStudioConfigs).where(eq(labelStudioConfigs.tenantId, tenantId)).limit(1);
    const sessions = await db.select({ id: visualInventorySessions.id, status: visualInventorySessions.status })
      .from(visualInventorySessions)
      .where(and(eq(visualInventorySessions.tenantId, tenantId)));
    const corrections = await db.select({ id: visualInventoryCorrections.id, exported: visualInventoryCorrections.exportedToLabelStudio })
      .from(visualInventoryCorrections)
      .where(eq(visualInventoryCorrections.tenantId, tenantId));
    return {
      config: cfg ?? null,
      totalSessions: sessions.length,
      completedSessions: sessions.filter(s => s.status === "completed").length,
      totalCorrections: corrections.length,
      exportedCorrections: corrections.filter(c => c.exported).length,
      pendingExport: corrections.filter(c => !c.exported).length,
    };
  }),
});
