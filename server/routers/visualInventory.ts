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
  visualInventoryCorrections,
  merchantNotifications,
  products,
  tenants,
} from "../../drizzle/schema";
import { eq, desc, and, gte, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { assertCapabilityAccess } from "../services/capabilities";
import { storagePut } from "../storage";
import {
  applyVisualCounts,
  classifyDetectedItem,
  getViPolicy,
} from "../services/visualInventoryApply";

// ── Config ────────────────────────────────────────────────────────────────────
const GO_ORCHESTRATOR_URL =
  process.env.VISUAL_INVENTORY_ORCHESTRATOR_URL ?? "http://localhost:8080";
const PYTHON_VLM_URL =
  process.env.VISUAL_INVENTORY_VLM_URL ?? "http://localhost:8081";

// LLM_BASE_URL is the OpenAI-style address (ending /v1) used elsewhere; Ollama's own API sits at the root.
const OLLAMA_URL = (process.env.LLM_BASE_URL ?? "http://ollama.ollama.svc.cluster.local:11434").replace(/\/+$/, "").replace(/\/v1$/, "");
const OLLAMA_VISION_MODEL = process.env.VISUAL_INVENTORY_OLLAMA_MODEL ?? "qwen2.5vl:7b";
/** The separate vision stack is optional. Without it, the cluster's Ollama vision model does the counting. */
const useOrchestrator = () => !!process.env.VISUAL_INVENTORY_ORCHESTRATOR_URL;

/** A shelf photo analysed by an Ollama vision model, in the same shape the orchestrator returns. */
async function analyseWithOllama(imageBuffer: Buffer, productHints: string[], model?: string): Promise<Record<string, unknown>> {
  const started = Date.now();
  const hintLine = productHints.length ? ` Products this shop stocks include: ${productHints.slice(0, 50).join(", ")}. Use those names where they match.` : "";
  const resp = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(300_000),
    body: JSON.stringify({
      model: model || OLLAMA_VISION_MODEL, stream: false, format: "json", options: { temperature: 0 },
      messages: [{
        role: "user",
        content: `Count the products visible in this shop shelf photo.${hintLine} Reply only with JSON: {"scene": one short sentence, "items": [{"label": product name, "count": integer number of units you can see, "confidence": number from 0 to 1}]}`,
        images: [imageBuffer.toString("base64")],
      }],
    }),
  });
  if (!resp.ok) throw new Error(`The image model returned ${resp.status}`);
  const body = (await resp.json()) as { message?: { content?: string } };
  let parsed: { scene?: unknown; items?: unknown } = {};
  try { parsed = JSON.parse(body.message?.content ?? "{}"); } catch { throw new Error("The image model's answer couldn't be read"); }
  const items = (Array.isArray(parsed.items) ? parsed.items : []).flatMap((raw) => {
    const i = raw as { label?: unknown; count?: unknown; confidence?: unknown };
    const label = typeof i.label === "string" ? i.label.trim().slice(0, 120) : "";
    const count = Math.max(0, Math.round(Number(i.count)));
    if (!label || !Number.isFinite(count) || count === 0) return [];
    const confidence = Math.min(1, Math.max(0, Number(i.confidence) || 0.5));
    return [{ label, count, confidence }];
  });
  return { items, scene_description: typeof parsed.scene === "string" ? parsed.scene : "", vlm_model_used: model || OLLAMA_VISION_MODEL, processing_ms: Date.now() - started };
}

// ── Helpers ───────────────────────────────────────────────────────────────────
/** The shop the scan belongs to. Older scans were filed under the user's id, so that remains the fallback. */
function getTenantId(user: { id: number | string; tenantId?: string | null }): string {
  return user.tenantId || String(user.id);
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
      const tenantId = getTenantId(ctx.user);
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

      // Analysis takes over a minute on CPU, longer than a web request may stay open behind Cloudflare, so it
      // runs in the background and the page checks the session until it's done.
      const hints = input.productHints ?? [];
      void (async () => {
        try {
          const analysisResult = useOrchestrator()
            ? await callGoOrchestrator(imageBuffer, sessionId, hints, tenantId, input.vlmModel)
            : await analyseWithOllama(imageBuffer, hints, input.vlmModel);
          const items = (analysisResult.items as Array<{ label: string; count: number; confidence: number; location?: string; notes?: string }>) ?? [];
          await db.update(visualInventorySessions).set({
            status: "completed",
            detectedItems: items,
            totalItemsDetected: items.reduce((s, i) => s + i.count, 0),
            vlmAnalysis: String(analysisResult.scene_description ?? ""),
            modelUsed: String(analysisResult.vlm_model_used ?? ""),
            processingMs: Number(analysisResult.processing_ms ?? 0),
          }).where(eq(visualInventorySessions.id, sessionId));
        } catch (err) {
          console.error(`[visual-inventory] analysis ${sessionId} failed:`, (err as Error)?.message);
          await db.update(visualInventorySessions).set({ status: "failed", errorMessage: (err as Error)?.message ?? String(err) })
            .where(eq(visualInventorySessions.id, sessionId)).catch(() => undefined);
        }
      })();

      return { sessionId, status: "processing" as const, imageUrl };
    }),

  /**
   * Get a session with all its detected items.
   */
  getSession: protectedProcedure
    .input(z.object({ sessionId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const db = (await getDb())!;
      const tenantId = getTenantId(ctx.user);
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
      // A restart mid-analysis leaves a session "processing" forever; after 10 minutes, say so.
      if (session.status === "processing" && Date.now() - new Date(session.createdAt).getTime() > 10 * 60_000) {
        return { ...session, status: "failed" as const, errorMessage: "The analysis didn't finish. Please try again." };
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
      const tenantId = getTenantId(ctx.user);
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
            // CV-1: when supplied, the calibrated auto-apply policy decides
            // whether this item may apply automatically (verified mapping +
            // confidence >= autoApply threshold) or must queue for review.
            confidence: z.number().min(0).max(1).optional(),
            /** Not in the catalogue yet: create it, then set its stock to the counted number. */
            create: z.object({
              name: z.string().trim().min(1).max(255),
              price: z.string().regex(/^\d+(\.\d{1,2})?$/, "Enter a price, like 1500"),
              category: z.string().trim().max(100).optional(),
            }).optional(),
          }),
        ),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = (await getDb())!;
      const tenantId = getTenantId(ctx.user);

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

      // CV-1: tenant policy (calibration thresholds + variance alert %).
      const [tenantRow] = await db
        .select({ settings: tenants.settings })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1)
        .catch(() => [null as any]);
      const policy = getViPolicy((tenantRow?.settings ?? null) as Record<string, unknown> | null);

      // CV-1: calibrated auto-apply — items carrying a VLM confidence are
      // gated by the policy; items without confidence are operator-confirmed
      // in the dashboard and apply directly (operator review IS the check).
      const mappingsRows = await db
        .select()
        .from(visualInventoryMappings)
        .where(eq(visualInventoryMappings.tenantId, tenantId))
        .catch(() => [] as any[]);
      const mappings = new Map<string, { productId: string; isVerified: boolean }>(
        (mappingsRows as any[]).map((r) => [
          r.detectedLabel,
          { productId: r.productId, isVerified: r.isVerified === true },
        ]),
      );

      // New products first, so they get the counted stock like everything else.
      const created: Array<{ label: string; productId: string; name: string }> = [];
      if (input.adjustments.some((a) => a.create && !a.productId)) {
        await assertCapabilityAccess(ctx.user, tenantId, "catalog");
        const [shop] = await db.select({ currency: tenants.defaultCurrency }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
        const currency = shop?.currency && shop.currency !== "USD" ? shop.currency : "NGN";
        for (const adj of input.adjustments) {
          if (!adj.create || adj.productId) continue;
          const id = nanoid();
          await db.insert(products).values({
            id, tenantId, sku: `SCAN-${id.slice(0, 8).toUpperCase()}`, name: adj.create.name, price: adj.create.price, currency,
            category: adj.create.category || null, status: "active", stockQuantity: 0,
            metadata: { source: "shelf_scan", scanSessionId: input.sessionId },
          });
          adj.productId = id;
          adj.confidence = undefined; // the merchant reviewed it, so it applies now
          created.push({ label: adj.detectedLabel, productId: id, name: adj.create.name });
        }
      }

      const toApply: typeof input.adjustments = [];
      const reviewQueue: Array<{ detectedLabel: string; confirmedCount: number; confidence: number; reason: string }> = [];
      const excluded: Array<{ detectedLabel: string; confirmedCount: number; confidence: number; reason: string }> = [];

      for (const adj of input.adjustments) {
        if (adj.confidence == null) {
          toApply.push(adj);
          continue;
        }
        const cls = classifyDetectedItem(
          { label: adj.detectedLabel, confidence: adj.confidence },
          mappings.get(adj.detectedLabel),
          policy,
        );
        if (cls.decision === "auto_apply") {
          toApply.push({ ...adj, productId: adj.productId ?? cls.productId ?? undefined });
        } else if (cls.decision === "review") {
          reviewQueue.push({
            detectedLabel: adj.detectedLabel,
            confirmedCount: adj.confirmedCount,
            confidence: adj.confidence,
            reason: cls.reason,
          });
        } else {
          excluded.push({
            detectedLabel: adj.detectedLabel,
            confirmedCount: adj.confirmedCount,
            confidence: adj.confidence,
            reason: cls.reason,
          });
        }
      }

      // Shared apply core: product + snapshot updates AND shrinkage/variance
      // anomaly alerts against the previous snapshot (never duplicated).
      const result = await applyVisualCounts(db, {
        tenantId,
        sessionId: input.sessionId,
        items: toApply,
        policy,
      });

      // CV-1: any item held back → session requires review + operator note.
      const needsReview = reviewQueue.length + excluded.length;
      if (needsReview > 0) {
        await db
          .update(visualInventorySessions)
          .set({ status: "review_needed" })
          .where(eq(visualInventorySessions.id, input.sessionId));
        console.warn(
          `[visual-inventory] session ${input.sessionId} requires review: ${needsReview} item(s) held back`,
        );
        await db.insert(merchantNotifications).values({
          id: crypto.randomUUID(),
          tenantId,
          type: "system",
          title: "Visual stock-take needs review",
          body: `${needsReview} item(s) from session ${input.sessionId} are below the auto-apply confidence threshold. Review them in the visual inventory dashboard.`,
          metadata: {
            kind: "visual_inventory_review_required",
            sessionId: input.sessionId,
            reviewCount: needsReview,
            reviewQueue,
            excluded,
          },
        }).catch((e: any) => console.warn("[visual-inventory] review notification failed:", e?.message));
      }

      // Mark session as applied
      await db
        .update(visualInventorySessions)
        .set({
          appliedToInventory: true,
          appliedAt: new Date(),
          appliedBy: String(ctx.user.id),
          inventoryUpdates: result.inventoryUpdates,
        })
        .where(eq(visualInventorySessions.id, input.sessionId));

      return {
        applied: result.applied,
        created,
        errors: result.errors,
        total: input.adjustments.length,
        alerts: result.alerts,
        reviewQueue,
        excluded,
        status: needsReview > 0 ? "review_needed" : "completed",
      };
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

  /** The shop's products, for matching what a scan found. */
  catalog: protectedProcedure.query(async ({ ctx }) => {
    const db = (await getDb())!;
    return db.select({ id: products.id, name: products.name, stockQuantity: products.stockQuantity, category: products.category })
      .from(products)
      .where(and(eq(products.tenantId, getTenantId(ctx.user)), sql`${products.status} <> 'archived'`))
      .orderBy(products.name).limit(1000);
  }),

  getMappings: protectedProcedure.query(async ({ ctx }) => {
      const db = (await getDb())!;
    const tenantId = getTenantId(ctx.user);
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
      if (!useOrchestrator()) {
        // Only models that can see images are worth offering here.
        const tags = await fetch(`${OLLAMA_URL}/api/tags`, { signal: controller.signal }).finally(() => clearTimeout(t));
        if (!tags.ok) return { models: [], available: false };
        const data = (await tags.json()) as { models?: Array<{ name: string; details?: { families?: string[] } }> };
        const vision = (data.models ?? []).filter((m) => /vl|vision|llava|moondream|minicpm-v|gemma3/i.test(`${m.name} ${(m.details?.families ?? []).join(" ")}`));
        return { models: vision.map((m) => m.name), available: vision.length > 0 };
      }
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
