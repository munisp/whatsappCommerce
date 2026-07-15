/**
 * Visual Inventory tRPC Router
 *
 * Bridges the TypeScript backend with the polyglot visual inventory stack:
 *   Mobile Camera → Go Orchestrator → Python VLM (YOLO + Ollama) → Rust BBox → DB
 */

import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import { TRPCError } from "@trpc/server";
import { getDb } from "../db";
import {
  visualInventorySessions,
  visualInventoryMappings,
  products,
  inventorySnapshots,
  visualInventoryCorrections,
} from "../../drizzle/schema";
import { eq, desc, and, gte } from "drizzle-orm";
import { storagePut } from "../storage";

// ── Config ────────────────────────────────────────────────────────────────────
const GO_ORCHESTRATOR_URL =
  process.env.VISUAL_INVENTORY_ORCHESTRATOR_URL ?? "http://localhost:8080";
const PYTHON_VLM_URL =
  process.env.VISUAL_INVENTORY_VLM_URL ?? "http://localhost:8081";

// ── Helpers ───────────────────────────────────────────────────────────────────
function getTenantId(userId: number): string {
  return String(userId);
}

async function callGoOrchestrator(
  imageBuffer: Buffer,
  sessionId: string,
  productHints: string[],
  tenantId: string,
  vlmModel?: string,
): Promise<Record<string, unknown>> {
  const form = new FormData();
  // Native FormData accepts Blob/File; convert Buffer to Uint8Array wrapped in Blob
  const imageBlob = new Blob([new Uint8Array(imageBuffer)], { type: "image/jpeg" });
  form.append("image", imageBlob, "inventory.jpg");
  form.append("session_id", sessionId);
  form.append("product_hints", productHints.join(","));
  if (vlmModel) form.append("vlm_model", vlmModel);

  const resp = await fetch(`${GO_ORCHESTRATOR_URL}/analyse`, {
    method: "POST",
    headers: {
      "X-Tenant-ID": tenantId,
    },
    body: form,
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: `Go orchestrator error ${resp.status}: ${text}`,
    });
  }
  return resp.json() as Promise<Record<string, unknown>>;
}

// ── Router ────────────────────────────────────────────────────────────────────
export const visualInventoryRouter = router({
  /**
   * Upload a shelf photo and run AI analysis.
   * Accepts base64-encoded image data from the mobile camera.
   */
  analyseImage: protectedProcedure
    .input(
      z.object({
        imageBase64: z.string().min(100),
        mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]).default("image/jpeg"),
        locationName: z.string().min(1).max(200).default("Unnamed Location"),
        scanLocation: z.string().max(256).optional(),
        notes: z.string().max(1000).optional(),
        productHints: z.array(z.string()).max(50).optional(),
        vlmModel: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = (await getDb())!;
      const tenantId = getTenantId(ctx.user.id);
      const sessionId = crypto.randomUUID();

      // Decode base64 image
      const imageBuffer = Buffer.from(input.imageBase64, "base64");

      // Upload original to S3 for audit trail
      const s3Key = `visual-inventory/${tenantId}/${sessionId}.jpg`;
      let imageUrl = "";
      try {
        const { url } = await storagePut(s3Key, imageBuffer, input.mimeType);
        imageUrl = url;
      } catch (_e) {
        imageUrl = ""; // S3 upload failure is non-fatal
      }

      // Create session record
      await db.insert(visualInventorySessions).values({
        id: sessionId,
        tenantId,
        userId: String(ctx.user.id),
        imageUrl,
        imageKey: s3Key,
        status: "processing",
        notes: input.notes ?? null,
        scanLocation: input.scanLocation ?? input.locationName ?? null,
      });

      // Call Go orchestrator → Python VLM → Rust BBox
      let analysisResult: Record<string, unknown>;
      try {
        analysisResult = await callGoOrchestrator(
          imageBuffer,
          sessionId,
          input.productHints ?? [],
          tenantId,
          input.vlmModel,
        );
      } catch (err) {
        await db
          .update(visualInventorySessions)
          .set({ status: "failed", errorMessage: String(err) })
          .where(eq(visualInventorySessions.id, sessionId));
        throw err;
      }

      // Parse detected items from VLM result
      const items = (analysisResult.items as Array<{
        label: string;
        count: number;
        confidence: number;
        location?: string;
        notes?: string;
      }>) ?? [];

      const totalItems = items.reduce((s, i) => s + i.count, 0);
      const avgConf =
        items.length > 0
          ? items.reduce((s, i) => s + i.confidence * i.count, 0) / Math.max(totalItems, 1)
          : 0;

      // Update session with results
      await db
        .update(visualInventorySessions)
        .set({
          status: "completed",
          detectedItems: items,
          totalItemsDetected: totalItems,
          vlmAnalysis: String(analysisResult.scene_description ?? ""),
          modelUsed: String(analysisResult.vlm_model_used ?? ""),
          processingMs: Number(analysisResult.processing_ms ?? 0),
        })
        .where(eq(visualInventorySessions.id, sessionId));

      return {
        sessionId,
        itemsDetected: items.length,
        totalCount: totalItems,
        confidenceScore: Math.round(avgConf * 10000) / 10000,
        items,
        sceneDescription: String(analysisResult.scene_description ?? ""),
        vlmModelUsed: String(analysisResult.vlm_model_used ?? ""),
        processingMs: Number(analysisResult.processing_ms ?? 0),
        imageUrl,
      };
    }),

  /**
   * Get a session with all its detected items.
   */
  getSession: protectedProcedure
    .input(z.object({ sessionId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const db = (await getDb())!;
      const tenantId = getTenantId(ctx.user.id);
      const [session] = await db
        .select()
        .from(visualInventorySessions)
        .where(
          and(
            eq(visualInventorySessions.id, input.sessionId),
            eq(visualInventorySessions.tenantId, tenantId),
          ),
        )
        .limit(1);

      if (!session) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Session not found" });
      }
      return session;
    }),

  /**
   * List recent visual inventory sessions for this tenant.
   */
  listSessions: protectedProcedure
    .input(z.object({ limit: z.number().int().min(1).max(100).default(20) }))
    .query(async ({ ctx, input }) => {
      const db = (await getDb())!;
      const tenantId = getTenantId(ctx.user.id);
      return db
        .select()
        .from(visualInventorySessions)
        .where(eq(visualInventorySessions.tenantId, tenantId))
        .orderBy(desc(visualInventorySessions.createdAt))
        .limit(input.limit);
    }),

  /**
   * Apply detected counts to the products table (stockQuantity).
   * Operator reviews and confirms the AI counts before applying.
   */
  applyToInventory: protectedProcedure
    .input(
      z.object({
        sessionId: z.string().uuid(),
        adjustments: z.array(
          z.object({
            detectedLabel: z.string(),
            confirmedCount: z.number().int().min(0),
            productId: z.string().optional(),
          }),
        ),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = (await getDb())!;
      const tenantId = getTenantId(ctx.user.id);

      const [session] = await db
        .select()
        .from(visualInventorySessions)
        .where(
          and(
            eq(visualInventorySessions.id, input.sessionId),
            eq(visualInventorySessions.tenantId, tenantId),
          ),
        )
        .limit(1);

      if (!session) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Session not found" });
      }

      let applied = 0;
      const errors: string[] = [];
      const inventoryUpdates: Array<{ productId: string; label: string; newQty: number }> = [];

      for (const adj of input.adjustments) {
        try {
          if (adj.productId) {
            // Update existing product stock
            await db
              .update(products)
              .set({ stockQuantity: adj.confirmedCount, updatedAt: new Date() })
              .where(
                and(
                  eq(products.id, adj.productId),
                  eq(products.tenantId, tenantId),
                ),
              );

            // Also update inventory snapshot
            await db
              .insert(inventorySnapshots)
              .values({
                id: crypto.randomUUID(),
                tenantId,
                productId: adj.productId,
                stockQty: String(adj.confirmedCount),
                reservedQty: "0",
                availableQty: String(adj.confirmedCount),
                syncSource: "visual_inventory",
              })
              .onConflictDoUpdate({
                target: [inventorySnapshots.tenantId, inventorySnapshots.productId],
                set: {
                  stockQty: String(adj.confirmedCount),
                  availableQty: String(adj.confirmedCount),
                  syncSource: "visual_inventory",
                  lastSyncedAt: new Date(),
                },
              });

            inventoryUpdates.push({
              productId: adj.productId,
              label: adj.detectedLabel,
              newQty: adj.confirmedCount,
            });
            applied++;
          }

          // Upsert label→product mapping for future sessions
          if (adj.productId) {
            await db
              .insert(visualInventoryMappings)
              .values({
                id: crypto.randomUUID(),
                tenantId,
                detectedLabel: adj.detectedLabel,
                productId: adj.productId,
                isVerified: true,
              })
              .onConflictDoUpdate({
                target: [visualInventoryMappings.tenantId, visualInventoryMappings.detectedLabel],
                set: { productId: adj.productId, isVerified: true },
              });
          }
        } catch (err) {
          errors.push(`${adj.detectedLabel}: ${String(err)}`);
        }
      }

      // Mark session as applied
      await db
        .update(visualInventorySessions)
        .set({
          appliedToInventory: true,
          appliedAt: new Date(),
          appliedBy: String(ctx.user.id),
          inventoryUpdates,
        })
        .where(eq(visualInventorySessions.id, input.sessionId));

      return { applied, errors, total: input.adjustments.length };
    }),

  /**
   * Get label→product mappings for this tenant (used to auto-suggest matches).
   */
  scanStats: protectedProcedure
    .input(z.object({ days: z.number().min(1).max(90).default(30) }).optional())
    .query(async ({ ctx, input }) => {
      const db = (await getDb())!;
      const tenantId = (ctx.user as { tenantId?: string }).tenantId ?? ctx.user.openId;
      const since = new Date(Date.now() - (input?.days ?? 30) * 24 * 60 * 60 * 1000);
      // All sessions in window
      const sessions = await db.select().from(visualInventorySessions)
        .where(and(eq(visualInventorySessions.tenantId, tenantId), gte(visualInventorySessions.createdAt, since)));
      // All corrections in window
      const corrections = await db.select().from(visualInventoryCorrections)
        .where(and(eq(visualInventoryCorrections.tenantId, tenantId), gte(visualInventoryCorrections.createdAt, since)));
      // Per-location stats
      const locationMap: Record<string, { scans: number; totalDetected: number; totalCorrected: number; corrections: number }> = {};
      for (const s of sessions) {
        const loc = (s.scanLocation as string | null) ?? "Unknown";
        if (!locationMap[loc]) locationMap[loc] = { scans: 0, totalDetected: 0, totalCorrected: 0, corrections: 0 };
        locationMap[loc].scans++;
        locationMap[loc].totalDetected += s.totalItemsDetected ?? 0;
      }
      for (const c of corrections) {
        // Find session location
        const sess = sessions.find(s => s.id === c.sessionId);
        const loc = (sess?.scanLocation as string | null) ?? "Unknown";
        if (!locationMap[loc]) locationMap[loc] = { scans: 0, totalDetected: 0, totalCorrected: 0, corrections: 0 };
        locationMap[loc].corrections++;
        locationMap[loc].totalCorrected += c.correctedCount ?? 0;
      }
      // Per-product accuracy
      const productMap: Record<string, { aiCount: number; correctedCount: number; corrections: number }> = {};
      for (const c of corrections) {
        const label = c.detectedLabel;
        if (!productMap[label]) productMap[label] = { aiCount: 0, correctedCount: 0, corrections: 0 };
        productMap[label].aiCount += c.originalCount ?? 0;
        productMap[label].correctedCount += c.correctedCount ?? 0;
        productMap[label].corrections++;
      }
      const productAccuracy = Object.entries(productMap).map(([label, v]) => ({
        label,
        aiCount: v.aiCount,
        correctedCount: v.correctedCount,
        corrections: v.corrections,
        accuracyPct: v.aiCount > 0 ? Math.max(0, 100 - Math.abs(v.aiCount - v.correctedCount) / v.aiCount * 100) : 0,
      })).sort((a, b) => a.accuracyPct - b.accuracyPct);
      // Daily scan trend
      const dailyMap: Record<string, { scans: number; corrections: number }> = {};
      for (const s of sessions) {
        const day = new Date(s.createdAt).toISOString().slice(0, 10);
        if (!dailyMap[day]) dailyMap[day] = { scans: 0, corrections: 0 };
        dailyMap[day].scans++;
      }
      for (const c of corrections) {
        const day = new Date(c.createdAt).toISOString().slice(0, 10);
        if (!dailyMap[day]) dailyMap[day] = { scans: 0, corrections: 0 };
        dailyMap[day].corrections++;
      }
      const dailyTrend = Object.entries(dailyMap).sort().map(([date, v]) => ({ date, ...v }));
      return {
        totalScans: sessions.length,
        totalCorrections: corrections.length,
        appliedSessions: sessions.filter(s => s.appliedToInventory).length,
        locationStats: Object.entries(locationMap).map(([location, v]) => ({
          location,
          ...v,
          accuracyPct: v.totalDetected > 0
            ? Math.max(0, 100 - (v.corrections / Math.max(v.scans, 1)) * 20)
            : null,
        })),
        productAccuracy,
        dailyTrend,
      };
    }),

  getMappings: protectedProcedure.query(async ({ ctx }) => {
      const db = (await getDb())!;
    const tenantId = getTenantId(ctx.user.id);
    return db
      .select()
      .from(visualInventoryMappings)
      .where(eq(visualInventoryMappings.tenantId, tenantId))
      .orderBy(desc(visualInventoryMappings.createdAt))
      .limit(200);
  }),

  /**
   * List available Ollama VLM models from the Python service.
   */
  getOllamaModels: protectedProcedure.query(async () => {
      const db = (await getDb())!;
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 10_000);
      const resp = await fetch(`${PYTHON_VLM_URL}/models`, { signal: controller.signal }).finally(() => clearTimeout(t));
      if (!resp.ok) return { models: [], available: false };
      const data = (await resp.json()) as { models?: Array<{ name: string }> };
      return {
        models: (data.models ?? []).map((m) => m.name),
        available: true,
      };
    } catch {
      return { models: [], available: false };
    }
  }),
});
