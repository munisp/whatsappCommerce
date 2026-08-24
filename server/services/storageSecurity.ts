/**
 * W30 auth-gates — storage object serving security (V3#17).
 *
 * Pure helpers for /api/storage/*:
 *   - sniffMime: magic-byte content sniffing (server-side; the stored
 *     Content-Type comes from the uploader and is untrusted)
 *   - isRiskyInlineType: types that must never render inline on the app
 *     origin (stored-XSS vector) → served with Content-Disposition:
 *     attachment and a safe content type.
 */

/** Sniff the real content type from the first bytes of the object. */
export function sniffMime(head: Buffer | Uint8Array): string | null {
  const b = Buffer.from(head);
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 6 && (b.subarray(0, 6).toString("ascii") === "GIF87a" || b.subarray(0, 6).toString("ascii") === "GIF89a")) return "image/gif";
  if (b.length >= 12 && b.subarray(0, 4).toString("ascii") === "RIFF" && b.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (b.length >= 5 && b.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf";
  if (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05 || b[2] === 0x07)) return "application/zip";
  // Text-ish content: look for markup/script signatures in the first 512
  // bytes (leading whitespace/BOM tolerated).
  const text = b.subarray(0, 512).toString("utf8").replace(/^﻿/, "").trimStart().toLowerCase();
  if (/^<!doctype html|^<html[\s>]/.test(text)) return "text/html";
  if (/^<svg[\s>]/.test(text) || (text.startsWith("<?xml") && text.includes("<svg"))) return "image/svg+xml";
  if (text.startsWith("<?xml")) return "application/xml";
  return null;
}

/**
 * W30 hotfix2: tenant-scoped storage key namespaces. For these prefixes the
 * SECOND path segment is the owning tenantId (established by the storagePut
 * call sites — tenantConfig branding, whatsappMedia, medusaOnboarding,
 * visualInventory/visualStocktake). The /api/storage session path enforces
 * that the caller's session tenant matches; the capability-token path
 * (?cap=…) is unaffected (the token is already bound to the exact key).
 *
 * Namespaces NOT listed here (product-images catalog, kyc, evidence,
 * escrow-attachments) carry no tenant segment in their keys — evidence and
 * escrow attachments are shared via capability tokens, product images are
 * catalog-public — so session-authenticated reads stay as they were.
 */
const TENANT_SCOPED_KEY_PREFIXES = new Set([
  "tenant-branding",
  "whatsapp-media",
  "medusa-onboarding",
  "visual-inventory",
]);

/** The owning tenantId encoded in a storage key, or null when the key's
 *  namespace is not tenant-prefixed. */
export function keyTenantScope(key: string): string | null {
  const segments = key.split("/").filter((s) => s.length > 0);
  if (segments.length < 2) return null;
  if (!TENANT_SCOPED_KEY_PREFIXES.has(segments[0])) return null;
  try {
    return decodeURIComponent(segments[1]);
  } catch {
    return segments[1];
  }
}

/** Session-path authorization: may `user` read an object scoped to
 *  `scopeTenantId`? Platform admins bypass; otherwise the session tenant or
 *  a membership must match. */
export function sessionMayReadScopedKey(
  user: { role?: string | null; tenantId?: string | null; memberships?: readonly string[] | null },
  scopeTenantId: string,
): boolean {
  if (user.role === "admin") return true;
  if (user.tenantId && user.tenantId === scopeTenantId) return true;
  if (Array.isArray(user.memberships) && user.memberships.includes(scopeTenantId)) return true;
  return false;
}

/** Types that must never be served inline on the application origin. */
export function isRiskyInlineType(contentType: string): boolean {
  const t = contentType.split(";")[0].trim().toLowerCase();
  return (
    t === "text/html" ||
    t === "application/xhtml+xml" ||
    t === "image/svg+xml" ||
    t === "application/xml" ||
    t === "text/xml" ||
    t === "text/javascript" ||
    t === "application/javascript"
  );
}

/**
 * Decide the effective served type + disposition for an object.
 * The SNIFFED type wins over the stored (client-supplied) one whenever they
 * disagree; risky types are forced to attachment with text/plain fallback.
 */
export function servedContentPolicy(
  storedType: string,
  head: Buffer | Uint8Array,
): { contentType: string; disposition: "inline" | "attachment" } {
  const sniffed = sniffMime(head);
  const effective = sniffed ?? storedType ?? "application/octet-stream";
  if (isRiskyInlineType(effective) || isRiskyInlineType(storedType)) {
    return { contentType: "application/octet-stream", disposition: "attachment" };
  }
  return { contentType: effective, disposition: "inline" };
}
