/**
 * CV-1: active-learning prioritization for Label Studio exports.
 *
 * Each visual-inventory session exported for annotation is scored so the
 * most training-valuable samples land at the top of the annotation queue:
 *
 *   base = 1.0
 *   +2.0  the session was corrected by a human (visual_inventory_corrections)
 *   +1.0  any detected item sits below the tenant review-confidence threshold
 *   × recency decay — exp(-ageDays / 30): newer scans are worth more
 *
 * Pure functions only — the router (routers/labelStudio.ts) supplies the data,
 * unit tests exercise every term directly.
 */

export const PRIORITY_CORRECTED_BONUS = 2.0;
export const PRIORITY_LOW_CONFIDENCE_BONUS = 1.0;
/** Half-life-ish decay: score halves roughly every ~21 days. */
export const PRIORITY_RECENCY_DECAY_DAYS = 30;

export interface PriorityInput {
  /** Session has at least one human correction. */
  hasCorrections: boolean;
  /** Lowest detected-item confidence in the session (null when no items). */
  minConfidence: number | null;
  /** Tenant review threshold (settings.visualInventoryReviewConfidence, default 0.6). */
  reviewThreshold: number;
  /** Session creation time. */
  createdAt: Date | number;
  /** Injectable clock (ms epoch) for deterministic tests. */
  now?: number;
}

export function computeExportPriority(input: PriorityInput): number {
  const now = input.now ?? Date.now();
  const createdMs = input.createdAt instanceof Date ? input.createdAt.getTime() : input.createdAt;
  const ageDays = Math.max(0, (now - createdMs) / (24 * 60 * 60 * 1000));

  let score = 1.0;
  if (input.hasCorrections) score += PRIORITY_CORRECTED_BONUS;
  if (input.minConfidence != null && input.minConfidence < input.reviewThreshold) {
    score += PRIORITY_LOW_CONFIDENCE_BONUS;
  }
  const decay = Math.exp(-ageDays / PRIORITY_RECENCY_DECAY_DAYS);
  return Number((score * decay).toFixed(6));
}
