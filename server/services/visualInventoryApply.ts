/**
 * CV-1: shared visual-inventory apply core.
 *
 * Used by BOTH the dashboard path (routers/visualInventory.ts applyToInventory)
 * and the WhatsApp stock-take path (services/visualStocktake.ts APPLY reply):
 *
 *   1. Calibrated auto-apply policy (tenant settings):
 *        visualInventoryAutoApplyConfidence  (default 0.95)
 *        visualInventoryReviewConfidence     (default 0.60)
 *      confidence >= autoApply AND a verified label→product mapping
 *        → auto_apply
 *      review <= confidence < autoApply  → review queue (session review_needed)
 *      confidence < review               → excluded + flagged
 *   2. Shrinkage/variance anomaly alerts: after applying a count, the new
 *      count is compared to the PREVIOUS inventorySnapshots.stockQty. When
 *      |variancePct| >= visualInventoryVarianceAlertPct (default 20) an
 *      operator notification row (type "system") is inserted and a structured
 *      warn is logged with product / old / new / variance / sessionId.
 *
 * All functions take `db` as an explicit parameter so unit tests and the
 * simulation can inject fakes; no hidden network or module state.
 */

import { and, eq } from "drizzle-orm";
import {
  inventorySnapshots,
  merchantNotifications,
  products,
  visualInventoryMappings,
} from "../../drizzle/schema";

type Db = any;

// ── Policy ────────────────────────────────────────────────────────────────────

export interface ViPolicy {
  autoApplyConfidence: number;
  reviewConfidence: number;
  varianceAlertPct: number;
}

export const VI_POLICY_DEFAULTS: ViPolicy = {
  autoApplyConfidence: 0.95,
  reviewConfidence: 0.6,
  varianceAlertPct: 20,
};

function numSetting(settings: Record<string, unknown> | null | undefined, key: string, fallback: number): number {
  const v = settings?.[key];
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : fallback;
}

/** Read the calibrated visual-inventory policy from tenants.settings (jsonb). */
export function getViPolicy(settings: Record<string, unknown> | null | undefined): ViPolicy {
  return {
    autoApplyConfidence: numSetting(settings, "visualInventoryAutoApplyConfidence", VI_POLICY_DEFAULTS.autoApplyConfidence),
    reviewConfidence: numSetting(settings, "visualInventoryReviewConfidence", VI_POLICY_DEFAULTS.reviewConfidence),
    varianceAlertPct: numSetting(settings, "visualInventoryVarianceAlertPct", VI_POLICY_DEFAULTS.varianceAlertPct),
  };
}

// ── Calibration ───────────────────────────────────────────────────────────────

export type ViDecision = "auto_apply" | "review" | "excluded";

export interface ViClassification {
  decision: ViDecision;
  productId: string | null;
  reason: string;
}

export interface ViMappingLike {
  productId: string;
  isVerified: boolean;
}

/**
 * Classify one detected item under the tenant policy. `mapping` is the
 * label→product mapping for the detected label (undefined when unseen).
 */
export function classifyDetectedItem(
  item: { label: string; confidence: number },
  mapping: ViMappingLike | undefined,
  policy: ViPolicy,
): ViClassification {
  if (item.confidence < policy.reviewConfidence) {
    return { decision: "excluded", productId: null, reason: "below_review_confidence" };
  }
  if (item.confidence >= policy.autoApplyConfidence && mapping?.isVerified) {
    return { decision: "auto_apply", productId: mapping.productId, reason: "calibrated_auto_apply" };
  }
  return {
    decision: "review",
    productId: mapping?.productId ?? null,
    reason: mapping?.isVerified
      ? "below_auto_apply_confidence"
      : "no_verified_mapping",
  };
}

/** Classify a whole detection set. */
export function classifyDetectedItems<
  T extends { label: string; count: number; confidence: number },
>(
  items: T[],
  mappings: ReadonlyMap<string, ViMappingLike>,
  policy: ViPolicy,
): Array<T & ViClassification> {
  return items.map((item) => ({
    ...item,
    ...classifyDetectedItem(item, mappings.get(item.label), policy),
  }));
}

// ── Variance ──────────────────────────────────────────────────────────────────

/**
 * Variance % between the previous snapshot qty and the new count.
 *  - old > 0 → (new - old) / old * 100 (signed)
 *  - old = 0, new > 0 → 100 (pure shrinkage/growth from zero)
 *  - old = 0, new = 0 → 0
 */
export function computeVariancePct(oldQty: number, newQty: number): number {
  if (oldQty === 0) return newQty === 0 ? 0 : 100;
  return ((newQty - oldQty) / oldQty) * 100;
}

export interface VarianceAlert {
  productId: string;
  label: string;
  oldQty: number;
  newQty: number;
  variancePct: number;
  sessionId: string;
}

/** Emit a variance alert: notification row + structured warn log. */
export async function emitVarianceAlert(
  db: Db,
  tenantId: string,
  alert: VarianceAlert,
): Promise<void> {
  const pct = Math.abs(alert.variancePct).toFixed(1);
  console.warn(
    `[visual-inventory] variance alert ${JSON.stringify({
      tenantId,
      productId: alert.productId,
      label: alert.label,
      oldQty: alert.oldQty,
      newQty: alert.newQty,
      variancePct: Number(alert.variancePct.toFixed(2)),
      sessionId: alert.sessionId,
    })}`,
  );
  await db.insert(merchantNotifications).values({
    id: crypto.randomUUID(),
    tenantId,
    type: "system",
    title: `Stock variance alert: ${alert.label}`,
    body:
      `Visual stock-take counted ${alert.newQty}× ${alert.label} (was ${alert.oldQty}) — ` +
      `a ${pct}% variance. Verify for shrinkage or miscount.`,
    metadata: {
      kind: "visual_inventory_variance",
      productId: alert.productId,
      label: alert.label,
      oldQty: alert.oldQty,
      newQty: alert.newQty,
      variancePct: Number(alert.variancePct.toFixed(4)),
      sessionId: alert.sessionId,
    },
  });
}

// ── Apply core ────────────────────────────────────────────────────────────────

export interface ApplyItem {
  detectedLabel: string;
  confirmedCount: number;
  productId?: string;
  confidence?: number;
}

export interface ApplyResult {
  applied: number;
  errors: string[];
  alerts: VarianceAlert[];
  inventoryUpdates: Array<{ productId: string; label: string; oldQty: number | null; newQty: number }>;
}

/**
 * Apply confirmed counts to products + inventorySnapshots, emitting variance
 * alerts against the PREVIOUS snapshot qty. Shared by the dashboard router and
 * the WhatsApp APPLY flow — money/stock logic is never duplicated.
 */
export async function applyVisualCounts(
  db: Db,
  opts: {
    tenantId: string;
    sessionId: string;
    items: ApplyItem[];
    policy: ViPolicy;
  },
): Promise<ApplyResult> {
  const { tenantId, sessionId, items, policy } = opts;
  let applied = 0;
  const errors: string[] = [];
  const alerts: VarianceAlert[] = [];
  const inventoryUpdates: ApplyResult["inventoryUpdates"] = [];

  for (const item of items) {
    if (!item.productId) continue;
    try {
      // Previous snapshot qty (baseline for the variance comparison).
      const [prevSnap] = await db
        .select({ stockQty: inventorySnapshots.stockQty })
        .from(inventorySnapshots)
        .where(
          and(
            eq(inventorySnapshots.tenantId, tenantId),
            eq(inventorySnapshots.productId, item.productId),
          ),
        )
        .limit(1);
      const oldQty = prevSnap != null ? Number(prevSnap.stockQty) : null;

      await db
        .update(products)
        .set({ stockQuantity: item.confirmedCount, updatedAt: new Date() })
        .where(and(eq(products.id, item.productId), eq(products.tenantId, tenantId)));

      await db
        .insert(inventorySnapshots)
        .values({
          id: crypto.randomUUID(),
          tenantId,
          productId: item.productId,
          stockQty: String(item.confirmedCount),
          reservedQty: "0",
          availableQty: String(item.confirmedCount),
          syncSource: "visual_inventory",
        })
        .onConflictDoUpdate({
          target: [inventorySnapshots.tenantId, inventorySnapshots.productId],
          set: {
            stockQty: String(item.confirmedCount),
            availableQty: String(item.confirmedCount),
            syncSource: "visual_inventory",
            lastSyncedAt: new Date(),
          },
        });

      // Shrinkage/variance anomaly check against the previous snapshot.
      if (oldQty != null) {
        const variancePct = computeVariancePct(oldQty, item.confirmedCount);
        if (Math.abs(variancePct) >= policy.varianceAlertPct) {
          const alert: VarianceAlert = {
            productId: item.productId,
            label: item.detectedLabel,
            oldQty,
            newQty: item.confirmedCount,
            variancePct,
            sessionId,
          };
          await emitVarianceAlert(db, tenantId, alert);
          alerts.push(alert);
        }
      }

      // Upsert label→product mapping for future sessions.
      await db
        .insert(visualInventoryMappings)
        .values({
          id: crypto.randomUUID(),
          tenantId,
          detectedLabel: item.detectedLabel,
          productId: item.productId,
          isVerified: true,
        })
        .onConflictDoUpdate({
          target: [visualInventoryMappings.tenantId, visualInventoryMappings.detectedLabel],
          set: { productId: item.productId, isVerified: true },
        });

      inventoryUpdates.push({
        productId: item.productId,
        label: item.detectedLabel,
        oldQty,
        newQty: item.confirmedCount,
      });
      applied++;
    } catch (err) {
      errors.push(`${item.detectedLabel}: ${String(err)}`);
    }
  }

  return { applied, errors, alerts, inventoryUpdates };
}
