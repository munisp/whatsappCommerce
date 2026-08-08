/**
 * Pure helpers for the WhatsApp ops frontend (template library, CTWA links,
 * quality card, message-delivery status). Kept dependency-free so they can be
 * unit-tested from the server-side vitest suite.
 */

/** Extract the sorted, de-duplicated {{n}} positional params from a template body. */
export function extractTemplateParams(body: string): number[] {
  const nums = new Set<number>();
  const re = /\{\{\s*(\d+)\s*\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const n = Number(m[1]);
    if (Number.isInteger(n) && n > 0) nums.add(n);
  }
  return Array.from(nums).sort((a, b) => a - b);
}

/** Substitute {{n}} params with sample values for the create-dialog preview. */
export function previewTemplateBody(body: string, samples?: Record<number, string>): string {
  return body.replace(/\{\{\s*(\d+)\s*\}\}/g, (_, n) => {
    const idx = Number(n);
    return samples?.[idx] ?? `[param ${idx}]`;
  });
}

export type WaTemplateStatus = "APPROVED" | "PENDING" | "REJECTED" | string;

/** Badge label + tailwind classes for a Meta template status. */
export function waTemplateStatusBadge(status: WaTemplateStatus): { label: string; className: string } {
  switch (status) {
    case "APPROVED":
      return { label: "Approved", className: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30" };
    case "PENDING":
      return { label: "Pending", className: "bg-amber-500/15 text-amber-400 border-amber-500/30" };
    case "REJECTED":
      return { label: "Rejected", className: "bg-red-500/15 text-red-400 border-red-500/30" };
    default:
      return { label: status || "Unknown", className: "bg-zinc-500/15 text-zinc-400 border-zinc-500/30" };
  }
}

export type WaQualityRating = "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN" | string;

/** Badge label + classes for the WhatsApp messaging-quality rating. */
export function waQualityBadge(rating: WaQualityRating): { label: string; className: string } {
  switch (rating) {
    case "HIGH":
      return { label: "High", className: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30" };
    case "MEDIUM":
      return { label: "Medium", className: "bg-amber-500/15 text-amber-400 border-amber-500/30" };
    case "LOW":
      return { label: "Low", className: "bg-red-500/15 text-red-400 border-red-500/30" };
    default:
      return { label: "Unknown", className: "bg-zinc-500/15 text-zinc-400 border-zinc-500/30" };
  }
}

export type NotifDeliveryStatus =
  | "pending"
  | "sent"
  | "delivered"
  | "read"
  | "failed"
  | "simulated"
  | "dead"
  | string;

/**
 * WhatsApp-style delivery glyph for a notification-log status:
 * ✓ sent, ✓✓ delivered, ✓✓(blue) read, ⚠ failed, ✖ dead.
 */
export function notifStatusGlyph(status: NotifDeliveryStatus): { glyph: string; label: string; className: string } {
  switch (status) {
    case "sent":
      return { glyph: "✓", label: "Sent", className: "text-blue-500" };
    case "delivered":
      return { glyph: "✓✓", label: "Delivered", className: "text-muted-foreground" };
    case "read":
      return { glyph: "✓✓", label: "Read", className: "text-sky-500" };
    case "failed":
      return { glyph: "⚠", label: "Failed", className: "text-red-500" };
    case "dead":
      return { glyph: "✖", label: "Dead (retries exhausted)", className: "text-red-700" };
    case "simulated":
      return { glyph: "◌", label: "Simulated", className: "text-muted-foreground" };
    default:
      return { glyph: "…", label: "Pending", className: "text-amber-500" };
  }
}

/** Pull a single receipt timestamp out of the statusTimestamps JSON blob. */
export function receiptTimestamp(
  statusTimestamps: unknown,
  key: "sent" | "delivered" | "read" | "failed",
): string | null {
  if (!statusTimestamps || typeof statusTimestamps !== "object") return null;
  const v = (statusTimestamps as Record<string, unknown>)[key];
  return typeof v === "string" && v ? v : null;
}
