/**
 * CV-1 / J85: WhatsApp shelf-photo stock-take.
 *
 * When a tenant user sends an IMAGE to the business WhatsApp number and the
 * tenant has opted in (settings.visualInventoryWhatsAppEnabled === true,
 * default off), this pipeline — triggered async from the webhook media
 * handler, never blocking the 200 ack:
 *
 *   1. Downloads the media from the WhatsApp Graph API (tenant credentials).
 *   2. Stores the photo via storagePut and opens a visual_inventory_sessions
 *      row (status processing, source 'whatsapp').
 *   3. Calls the VLM orchestrator (VISUAL_INVENTORY_ORCHESTRATOR_URL) for
 *      counts. All network goes through the global fetch, so the simulation
 *      metaMock / unit tests stub it without any code changes.
 *   4. Replies in chat with the detected counts
 *      ("I counted: 12× Indomie Pack … Reply APPLY to update stock or REVIEW
 *      to check first").
 *   5. "APPLY" reply → the calibrated auto-apply policy
 *      (services/visualInventoryApply.ts): high-confidence + verified-mapping
 *      items apply automatically; anything else flips the session to
 *      review_needed, queues an operator notification, and the reply points
 *      at the dashboard.
 */

import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "../db";
import {
  merchantNotifications,
  tenants,
  visualInventoryMappings,
  visualInventorySessions,
} from "../../drizzle/schema";
import { storagePut } from "../storage";
import { resolveTenantWaCredentials, sendWhatsAppText } from "./waSender";
import {
  applyVisualCounts,
  classifyDetectedItems,
  getViPolicy,
  type ViPolicy,
} from "./visualInventoryApply";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export interface DetectedItem {
  label: string;
  count: number;
  confidence: number;
  decision?: "auto_apply" | "review" | "excluded";
  productId?: string | null;
  reason?: string;
}

// ── Tenant settings ───────────────────────────────────────────────────────────

/** Opt-in gate (default OFF). */
export function isWhatsAppStocktakeEnabled(settings: Record<string, unknown> | null | undefined): boolean {
  return settings?.visualInventoryWhatsAppEnabled === true;
}

async function loadTenantSettings(db: Db, tenantId: string): Promise<Record<string, unknown>> {
  const [t] = await db
    .select({ settings: tenants.settings })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1)
    .catch(() => [null as any]);
  return ((t?.settings ?? {}) as Record<string, unknown>) ?? {};
}

// ── Media download (same pattern as receiptVerification) ─────────────────────

async function downloadWaMedia(
  tenantId: string,
  mediaId: string,
): Promise<{ buffer: Buffer; mimeType: string } | null> {
  const creds = await resolveTenantWaCredentials(tenantId);
  if (!creds) return null;
  const meta = await fetch(`https://graph.facebook.com/v21.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${creds.accessToken}` },
    signal: AbortSignal.timeout(12000),
  }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const url = meta?.url;
  if (!url) return null;
  const bin = await fetch(url, {
    headers: { Authorization: `Bearer ${creds.accessToken}` },
    signal: AbortSignal.timeout(20000),
  }).then((r) => (r.ok ? r.arrayBuffer() : null)).catch(() => null);
  if (!bin) return null;
  return {
    buffer: Buffer.from(bin),
    mimeType: typeof meta?.mime_type === "string" ? meta.mime_type : "image/jpeg",
  };
}

// ── Orchestrator call ─────────────────────────────────────────────────────────

async function callOrchestrator(
  imageBuffer: Buffer,
  sessionId: string,
  tenantId: string,
): Promise<Record<string, unknown>> {
  const baseUrl = process.env.VISUAL_INVENTORY_ORCHESTRATOR_URL ?? "http://localhost:8080";
  const form = new FormData();
  const imageBlob = new Blob([new Uint8Array(imageBuffer)], { type: "image/jpeg" });
  form.append("image", imageBlob, "stocktake.jpg");
  form.append("session_id", sessionId);
  const resp = await fetch(`${baseUrl}/analyse`, {
    method: "POST",
    headers: { "X-Tenant-ID": tenantId },
    body: form,
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`orchestrator error ${resp.status}: ${text.slice(0, 200)}`);
  }
  return resp.json() as Promise<Record<string, unknown>>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function loadVerifiedMappings(db: Db, tenantId: string) {
  const rows = await db
    .select()
    .from(visualInventoryMappings)
    .where(eq(visualInventoryMappings.tenantId, tenantId))
    .catch(() => [] as any[]);
  return new Map<string, { productId: string; isVerified: boolean }>(
    (rows as any[]).map((r) => [r.detectedLabel, { productId: r.productId, isVerified: r.isVerified === true }]),
  );
}

/** "I counted: 12× Indomie Pack, 30× Pure Water Sachet." */
export function formatCountsSummary(items: Array<{ label: string; count: number }>): string {
  if (items.length === 0) return "I couldn't detect any products in that photo.";
  const list = items.map((i) => `${i.count}× ${i.label}`).join(", ");
  return `I counted: ${list}.`;
}

async function notifyReviewRequired(
  db: Db,
  tenantId: string,
  sessionId: string,
  reviewCount: number,
): Promise<void> {
  console.warn(
    `[visual-stocktake] session ${sessionId} requires review (${reviewCount} items) tenant=${tenantId}`,
  );
  await db.insert(merchantNotifications).values({
    id: crypto.randomUUID(),
    tenantId,
    type: "system",
    title: "Visual stock-take needs review",
    body: `${reviewCount} item(s) from a WhatsApp stock-take are below the auto-apply confidence threshold. Review them in the visual inventory dashboard.`,
    metadata: { kind: "visual_inventory_review_required", sessionId, reviewCount },
  }).catch((e: any) => console.warn("[visual-stocktake] review notification failed:", e?.message));
}

// ── Photo → session ───────────────────────────────────────────────────────────

export interface StocktakeOutcome {
  handled: boolean;
  outcome?:
    | "disabled"
    | "download_failed"
    | "orchestrator_failed"
    | "counts_replied"
    | "no_items";
  sessionId?: string;
}

export async function handleInboundStocktakeImage(opts: {
  tenantId: string;
  waPhoneNumber: string;
  mediaId: string;
}): Promise<StocktakeOutcome> {
  const db = await getDb();
  if (!db) return { handled: false };

  const settings = await loadTenantSettings(db, opts.tenantId);
  if (!isWhatsAppStocktakeEnabled(settings)) {
    return { handled: true, outcome: "disabled" };
  }
  const policy = getViPolicy(settings);

  const reply = (body: string) =>
    sendWhatsAppText(opts.tenantId, opts.waPhoneNumber, body, {
      notifType: "visual_stocktake",
    }).catch((e: any) => console.error("[visual-stocktake] reply send error:", e?.message));

  // 1. Download the photo.
  const media = await downloadWaMedia(opts.tenantId, opts.mediaId);
  if (!media) {
    await reply("📷 Sorry, I couldn't download that photo. Please try sending it again.");
    return { handled: true, outcome: "download_failed" };
  }

  // 2. Store + open the session.
  const sessionId = crypto.randomUUID();
  const s3Key = `visual-inventory/${opts.tenantId}/${sessionId}.jpg`;
  let imageUrl = `https://graph.facebook.com/v21.0/${opts.mediaId}`;
  try {
    const { url } = await storagePut(s3Key, media.buffer, media.mimeType);
    imageUrl = url;
  } catch {
    /* S3 upload failure is non-fatal — keep the graph URL reference */
  }
  await db.insert(visualInventorySessions).values({
    id: sessionId,
    tenantId: opts.tenantId,
    userId: opts.waPhoneNumber,
    imageUrl,
    imageKey: s3Key,
    status: "processing",
    source: "whatsapp",
  });

  // 3. VLM orchestrator.
  let analysis: Record<string, unknown>;
  try {
    analysis = await callOrchestrator(media.buffer, sessionId, opts.tenantId);
  } catch (err) {
    await db
      .update(visualInventorySessions)
      .set({ status: "failed", errorMessage: String(err) })
      .where(eq(visualInventorySessions.id, sessionId));
    await reply("📷 I couldn't analyse that shelf photo right now. Please try again shortly.");
    return { handled: true, outcome: "orchestrator_failed", sessionId };
  }

  const items = ((analysis.items as Array<{ label: string; count: number; confidence: number }>) ?? [])
    .filter((i) => typeof i?.label === "string" && typeof i?.count === "number");

  if (items.length === 0) {
    await db
      .update(visualInventorySessions)
      .set({
        status: "completed",
        detectedItems: [],
        totalItemsDetected: 0,
        modelUsed: String(analysis.vlm_model_used ?? ""),
        processingMs: Number(analysis.processing_ms ?? 0),
      })
      .where(eq(visualInventorySessions.id, sessionId));
    await reply("📷 I couldn't detect any products in that photo. Try a clearer, closer shot of the shelf.");
    return { handled: true, outcome: "no_items", sessionId };
  }

  // 4. Classify under the calibrated policy (verified mappings required for auto-apply).
  const mappings = await loadVerifiedMappings(db, opts.tenantId);
  const classified = classifyDetectedItems(items, mappings, policy);
  const needsReview = classified.filter((i) => i.decision !== "auto_apply").length;
  const status = needsReview > 0 ? "review_needed" : "completed";
  const totalItems = classified.reduce((s, i) => s + i.count, 0);

  await db
    .update(visualInventorySessions)
    .set({
      status,
      detectedItems: classified,
      totalItemsDetected: totalItems,
      vlmAnalysis: String(analysis.scene_description ?? ""),
      modelUsed: String(analysis.vlm_model_used ?? ""),
      processingMs: Number(analysis.processing_ms ?? 0),
    })
    .where(eq(visualInventorySessions.id, sessionId));

  if (status === "review_needed") {
    await notifyReviewRequired(db, opts.tenantId, sessionId, needsReview);
  }

  // 5. Chat reply with the counts summary.
  await reply(
    `📷 ${formatCountsSummary(classified)} Reply APPLY to update stock or REVIEW to check first.`,
  );
  return { handled: true, outcome: "counts_replied", sessionId };
}

// ── APPLY / REVIEW replies ────────────────────────────────────────────────────

export interface ApplyReplyOutcome {
  handled: boolean;
  outcome?: "no_pending_session" | "applied" | "applied_partial" | "review_requested";
  sessionId?: string;
  applied?: number;
  needsReview?: number;
}

/** Latest unapplied WhatsApp stock-take session from this sender. */
async function findPendingSession(db: Db, tenantId: string, waPhoneNumber: string) {
  const rows = await db
    .select()
    .from(visualInventorySessions)
    .where(
      and(
        eq(visualInventorySessions.tenantId, tenantId),
        eq(visualInventorySessions.userId, waPhoneNumber),
        eq(visualInventorySessions.source, "whatsapp"),
        eq(visualInventorySessions.appliedToInventory, false),
        inArray(visualInventorySessions.status, ["completed", "review_needed"]),
      ),
    )
    .orderBy(desc(visualInventorySessions.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

export async function handleStocktakeApplyReply(opts: {
  tenantId: string;
  waPhoneNumber: string;
  command: "APPLY" | "REVIEW";
}): Promise<ApplyReplyOutcome> {
  const db = await getDb();
  if (!db) return { handled: false };

  const settings = await loadTenantSettings(db, opts.tenantId);
  if (!isWhatsAppStocktakeEnabled(settings)) return { handled: false };
  const policy: ViPolicy = getViPolicy(settings);

  const reply = (body: string) =>
    sendWhatsAppText(opts.tenantId, opts.waPhoneNumber, body, {
      notifType: "visual_stocktake",
    }).catch((e: any) => console.error("[visual-stocktake] reply send error:", e?.message));

  const session = await findPendingSession(db, opts.tenantId, opts.waPhoneNumber);
  if (!session) {
    await reply("📷 There's no pending stock-take to apply. Send a shelf photo first.");
    return { handled: true, outcome: "no_pending_session" };
  }

  const items = ((session.detectedItems ?? []) as DetectedItem[]).filter(
    (i) => typeof i?.label === "string",
  );

  // REVIEW → park the session for the dashboard.
  if (opts.command === "REVIEW") {
    await db
      .update(visualInventorySessions)
      .set({ status: "review_needed" })
      .where(eq(visualInventorySessions.id, session.id));
    await notifyReviewRequired(db, opts.tenantId, session.id, items.length || 1);
    await reply("🔍 No stock was changed. This stock-take is queued for review in your dashboard.");
    return { handled: true, outcome: "review_requested", sessionId: session.id };
  }

  // APPLY → calibrated auto-apply only; the rest stays queued for review.
  const mappings = await loadVerifiedMappings(db, opts.tenantId);
  const classified = classifyDetectedItems(
    items.map((i) => ({ label: i.label, count: i.count, confidence: Number(i.confidence ?? 0) })),
    mappings,
    policy,
  );
  const autoApply = classified.filter((i) => i.decision === "auto_apply");
  const reviewItems = classified.filter((i) => i.decision === "review");
  const excluded = classified.filter((i) => i.decision === "excluded");

  const result = await applyVisualCounts(db, {
    tenantId: opts.tenantId,
    sessionId: session.id,
    items: autoApply.map((i) => ({
      detectedLabel: i.label,
      confirmedCount: i.count,
      productId: i.productId ?? undefined,
      confidence: i.confidence,
    })),
    policy,
  });

  const needsReview = reviewItems.length + excluded.length;
  const finalStatus = needsReview > 0 ? "review_needed" : "completed";
  await db
    .update(visualInventorySessions)
    .set({
      status: finalStatus,
      appliedToInventory: result.applied > 0,
      appliedAt: result.applied > 0 ? new Date() : null,
      appliedBy: `whatsapp:${opts.waPhoneNumber}`,
      inventoryUpdates: result.inventoryUpdates,
      detectedItems: classified,
    })
    .where(eq(visualInventorySessions.id, session.id));

  if (needsReview > 0) {
    await notifyReviewRequired(db, opts.tenantId, session.id, needsReview);
    await reply(
      `✅ Updated stock for ${result.applied} item(s). ${needsReview} item(s) had lower confidence and were NOT applied — please review them in your dashboard.` +
        (excluded.length > 0 ? ` (${excluded.length} excluded as too uncertain.)` : ""),
    );
    return {
      handled: true,
      outcome: "applied_partial",
      sessionId: session.id,
      applied: result.applied,
      needsReview,
    };
  }

  await reply(`✅ Done — stock updated for ${result.applied} item(s) from your shelf photo.`);
  return {
    handled: true,
    outcome: "applied",
    sessionId: session.id,
    applied: result.applied,
    needsReview: 0,
  };
}
