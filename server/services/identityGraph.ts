// === W57 risk-shield ===
/**
 * identityGraph.ts — Feature 1: identity graph + multi-account default
 * detection.
 *
 * Identity signals (BVN, NIN, phone, email, bank account, device
 * fingerprint) are stored ONLY as keyed hashes — HMAC-SHA256 over
 * `linkType|normalizedValue` with the server secret
 * (IDENTITY_GRAPH_HMAC_SECRET, decryptSecret envelope-aware; sim default
 * 'sim-identity-hmac-secret'). Raw BVN/NIN are NEVER persisted.
 *
 * Links are append-only (identity_links, unique per
 * subject/linkType/linkHash ⇒ idempotent populate hooks). Populate seams:
 *   - KYC verification (routers/kyc.ts review → approved): phone/email +
 *     BVN/NIN when present in kycDocuments.extractedData.
 *   - Signup / buyer registration: recordSignupIdentity() (phone/email/
 *     device fingerprint).
 *   - Bank/payout account registration: recordLink(..., 'bank_account', acct).
 *
 * Multi-account default detection: checkLinkedDefaults() finds OTHER
 * subjects sharing any hash with the subject; when a linked identity has an
 * ACTIVE credit_default_registry row (or a defaulted credit account/loan),
 * the subject gets an identity_flags 'linked_default' row (claim-first —
 * one active flag per subject) → credit eligibility FROZEN. Honest scope:
 * only CREDIT is frozen — cash-on-delivery / prepaid commerce is never
 * blocked. Merchant/admin is alerted via the existing ops-alert seam
 * (adminAlerts.notifyTenantAdminWhatsApp, fail-open).
 *
 * Due process: disputeIdentityFlag() (subject-initiated, reuses the chat
 * dispute intake seam: records an admin notification + flags the row
 * 'disputed') → admin reviewIdentityFlag() clears (eligibility restored) or
 * confirms, with writeAuditLog on every transition.
 *
 * New-identity velocity: NEW_IDENTITY_* constants are consumed by
 * creditScoring.ts as an ADDITIVE post-core ceiling (documented there).
 */
import { createHmac } from "crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  creditDefaultRegistry,
  creditScores,
  identityFlags,
  identityLinks,
  merchantLoans,
} from "../../drizzle/schema";
import { decryptSecret } from "./crypto/secrets";
import type { DbHandle } from "./tradeCredit/accounts";

export type IdentitySubjectType = "buyer" | "merchant";
export type IdentityLinkType = "bvn" | "nin" | "phone" | "email" | "bank_account" | "device";
export type IdentityFlagStatus = "active" | "disputed" | "cleared" | "confirmed";

/** New-identity velocity ceiling (Feature 1): subjects younger than
 * NEW_IDENTITY_TENURE_DAYS cannot score above NEW_IDENTITY_SCORE_CEILING
 * (just below grade B) until they have tenure. Additive creditScoring factor. */
export const NEW_IDENTITY_TENURE_DAYS = 30;
export const NEW_IDENTITY_SCORE_CEILING = 649;

// ── Hashing ─────────────────────────────────────────────────────────────────

/** Resolve the HMAC secret (envelope-aware), sim-safe default. */
export function identityHmacSecret(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env.IDENTITY_GRAPH_HMAC_SECRET ?? "").trim();
  if (raw) {
    try {
      const dec = decryptSecret(raw);
      if (dec) return dec;
    } catch { /* not an envelope — use raw */ }
    return raw;
  }
  if ((env.SIM_MODE ?? "").trim() === "true" || (env.NODE_ENV ?? "") === "test") {
    return "sim-identity-hmac-secret";
  }
  // Fail-closed on identity hashing outside sim/test: an unset secret would
  // make hashes predictable. Callers catch and skip the populate hook
  // (fail-open telemetry at the seam, fail-closed here).
  throw new Error("IDENTITY_GRAPH_HMAC_SECRET is not configured");
}

/** Normalize a raw identity value before hashing (never store the raw). */
export function normalizeLinkValue(linkType: IdentityLinkType, value: string): string {
  const v = String(value ?? "").trim();
  if (linkType === "email") return v.toLowerCase();
  if (linkType === "phone") return v.replace(/[^\d+]/g, "");
  return v.replace(/\s+/g, "").toUpperCase(); // bvn / nin / bank_account / device
}

/** HMAC-SHA256 hex of `linkType|normalized`. 64 chars. */
export function hashIdentityLink(linkType: IdentityLinkType, value: string, env?: NodeJS.ProcessEnv): string {
  const norm = normalizeLinkValue(linkType, value);
  if (!norm) throw new Error("empty identity link value");
  return createHmac("sha256", identityHmacSecret(env)).update(`${linkType}|${norm}`).digest("hex");
}

// ── Populate hooks ──────────────────────────────────────────────────────────

/**
 * Record one identity link (idempotent — unique subject/linkType/linkHash,
 * onConflictDoNothing). Returns the hash, or null when the value is empty.
 * NEVER throws for hashing-config reasons in hooks — callers that must
 * fail-closed use hashIdentityLink directly.
 */
export async function recordLink(
  db: DbHandle,
  opts: {
    tenantId: string;
    subjectType: IdentitySubjectType;
    subjectId: string;
    linkType: IdentityLinkType;
    value: string;
  },
): Promise<{ linkHash: string } | null> {
  if (!opts.value || !String(opts.value).trim()) return null;
  const linkHash = hashIdentityLink(opts.linkType, opts.value);
  await db
    .insert(identityLinks)
    .values({
      tenantId: opts.tenantId,
      subjectType: opts.subjectType,
      subjectId: opts.subjectId,
      linkType: opts.linkType,
      linkHash,
    })
    .onConflictDoNothing();
  return { linkHash };
}

/**
 * Signup / KYC populate hook: records any of phone/email/device (+bvn/nin
 * when a verification artefact carries them) then runs the multi-account
 * default check. FAIL-OPEN at the seam: errors are logged, never thrown —
 * an identity-graph outage must not block signup or KYC.
 */
export async function recordSignupIdentity(
  db: DbHandle,
  opts: {
    tenantId: string;
    subjectType: IdentitySubjectType;
    subjectId: string;
    phone?: string | null;
    email?: string | null;
    deviceFingerprint?: string | null;
    bvn?: string | null;
    nin?: string | null;
  },
): Promise<{ recorded: number; flagged: boolean; flagId: string | null }> {
  let recorded = 0;
  try {
    const candidates: Array<[IdentityLinkType, string | null | undefined]> = [
      ["phone", opts.phone],
      ["email", opts.email],
      ["device", opts.deviceFingerprint],
      ["bvn", opts.bvn],
      ["nin", opts.nin],
    ];
    for (const [linkType, value] of candidates) {
      const r = value ? await recordLink(db, { tenantId: opts.tenantId, subjectType: opts.subjectType, subjectId: opts.subjectId, linkType, value }) : null;
      if (r) recorded += 1;
    }
    const check = await checkLinkedDefaults(db, opts.tenantId, opts.subjectType, opts.subjectId);
    return { recorded, flagged: check.flagged, flagId: check.flagId };
  } catch (e: any) {
    logLine("warn", "identity_link_populate_failed", {
      tenantId: opts.tenantId, subjectType: opts.subjectType, error: String(e?.message ?? e).slice(0, 300),
    });
    return { recorded, flagged: false, flagId: null };
  }
}

function logLine(level: "info" | "warn", metric: string, extra: Record<string, unknown>): void {
  try {
    process.stdout.write(JSON.stringify({ level, metric, ...extra }) + "\n");
  } catch { /* logging must never break the credit path */ }
}

// ── Graph traversal ─────────────────────────────────────────────────────────

/** All link hashes of a subject, grouped by type. */
export async function getSubjectHashes(
  db: DbHandle, subjectType: IdentitySubjectType, subjectId: string,
): Promise<Array<{ linkType: IdentityLinkType; linkHash: string }>> {
  return (await db
    .select({ linkType: identityLinks.linkType, linkHash: identityLinks.linkHash })
    .from(identityLinks)
    .where(and(eq(identityLinks.subjectType, subjectType), eq(identityLinks.subjectId, subjectId)))) as unknown as Array<{
    linkType: IdentityLinkType;
    linkHash: string;
  }>;
}

/**
 * Find OTHER subjects sharing at least one link hash with the subject.
 * Cross-tenant by design (multi-account fraud hops tenants) — only hashes
 * are compared, no raw PII is read or exposed.
 */
export async function findLinkedSubjects(
  db: DbHandle,
  subjectType: IdentitySubjectType,
  subjectId: string,
): Promise<Array<{ subjectType: string; subjectId: string; linkType: string; linkHash: string }>> {
  const own = await getSubjectHashes(db, subjectType, subjectId);
  if (own.length === 0) return [];
  const hashes = own.map((h) => h.linkHash);
  const rows = (await db
    .select({
      subjectType: identityLinks.subjectType,
      subjectId: identityLinks.subjectId,
      linkType: identityLinks.linkType,
      linkHash: identityLinks.linkHash,
    })
    .from(identityLinks)
    .where(and(inArray(identityLinks.linkHash, hashes), sql`${identityLinks.subjectId} <> ${subjectId}`))) as unknown as Array<{
    subjectType: string; subjectId: string; linkType: string; linkHash: string;
  }>;
  return rows;
}

// ── Multi-account default detection ─────────────────────────────────────────

export interface LinkedDefaultCheck {
  flagged: boolean;
  flagId: string | null;
  /** true when a pre-existing active/confirmed flag already covered this. */
  alreadyFlagged: boolean;
  linkedDefaults: number;
}

/**
 * Check whether the subject is linked (by shared hashes) to an identity with
 * defaulted credit: an ACTIVE credit_default_registry row keyed by any of
 * the subject's hashes, or a defaulted merchant loan held by a linked
 * merchant subject. On a hit the subject's credit eligibility is frozen via
 * an identity_flags row (claim-first: at most one live 'linked_default' flag
 * per subject) and the tenant admin is alerted (fail-open).
 */
export async function checkLinkedDefaults(
  db: DbHandle,
  tenantId: string,
  subjectType: IdentitySubjectType,
  subjectId: string,
): Promise<LinkedDefaultCheck> {
  const own = await getSubjectHashes(db, subjectType, subjectId);
  const none: LinkedDefaultCheck = { flagged: false, flagId: null, alreadyFlagged: false, linkedDefaults: 0 };
  if (own.length === 0) return none;

  // Already frozen? Claim-first idempotency.
  const existing = await getActiveFlag(db, tenantId, subjectType, subjectId);
  if (existing) return { flagged: true, flagId: existing.id, alreadyFlagged: true, linkedDefaults: 0 };

  const hashes = own.map((h) => h.linkHash);
  // Registry defaults keyed by ANY of the subject's hashes. A hash shared
  // with a defaulted identity implicates this subject too.
  const registryHits = (await db
    .select({ id: creditDefaultRegistry.id, identityHash: creditDefaultRegistry.identityHash })
    .from(creditDefaultRegistry)
    .where(and(inArray(creditDefaultRegistry.identityHash, hashes), eq(creditDefaultRegistry.status, "active")))
    .limit(10)) as unknown as { id: string; identityHash: string }[];

  // Legacy default signal: linked MERCHANT subjects with defaulted loans.
  let legacyDefaults = 0;
  const linked = await findLinkedSubjects(db, subjectType, subjectId);
  const linkedMerchants = Array.from(new Set(linked.filter((l) => l.subjectType === "merchant").map((l) => l.subjectId)));
  if (linkedMerchants.length > 0) {
    const rows = (await db
      .select({ n: sql<number>`count(*)::int` })
      .from(merchantLoans)
      .where(and(inArray(merchantLoans.tenantId, linkedMerchants), eq(merchantLoans.status, "defaulted")))) as unknown as { n: number }[];
    legacyDefaults = Number(rows[0]?.n ?? 0);
  }

  const linkedDefaults = registryHits.length + legacyDefaults;
  if (linkedDefaults === 0) return none;

  // Claim-first insert: another concurrent check may have flagged first.
  const claimed = (await db
    .insert(identityFlags)
    .values({
      tenantId,
      subjectType,
      subjectId,
      kind: "linked_default",
      status: "active",
      evidence: {
        linkTypes: Array.from(new Set(own.map((h) => h.linkType))),
        registryDefaultRefs: registryHits.map((r) => r.id),
        legacyDefaults,
      },
    })
    .onConflictDoNothing()
    .returning({ id: identityFlags.id })) as unknown as { id: string }[];
  const flagId = claimed[0]?.id ?? (await getActiveFlag(db, tenantId, subjectType, subjectId))?.id ?? null;

  logLine("warn", "identity_linked_default_flagged", { tenantId, subjectType, subjectId, linkedDefaults });
  // Ops alert seam — fail-open, never blocks.
  try {
    const { notifyTenantAdminWhatsApp } = await import("./adminAlerts");
    const { getDb } = await import("../db");
    const adb = (await getDb()) as any;
    if (adb) {
      await notifyTenantAdminWhatsApp(adb, tenantId,
        `⚠️ Credit risk: ${subjectType} ${subjectId} is identity-linked to ${linkedDefaults} defaulted credit account(s). ` +
        `Credit eligibility is FROZEN pending review (cash sales are unaffected).`);
    }
  } catch (e: any) {
    logLine("warn", "identity_flag_alert_failed", { tenantId, error: String(e?.message ?? e).slice(0, 200) });
  }
  return { flagged: true, flagId, alreadyFlagged: false, linkedDefaults };
}

/** Live (active/confirmed/disputed) flag for a subject, newest first. */
export async function getActiveFlag(
  db: DbHandle, tenantId: string, subjectType: IdentitySubjectType, subjectId: string,
) {
  const rows = (await db
    .select()
    .from(identityFlags)
    .where(and(
      eq(identityFlags.tenantId, tenantId),
      eq(identityFlags.subjectType, subjectType),
      eq(identityFlags.subjectId, subjectId),
      inArray(identityFlags.status, ["active", "disputed", "confirmed"]),
    ))
    .limit(1)) as unknown as (typeof identityFlags.$inferSelect)[];
  return rows[0] ?? null;
}

/**
 * CREDIT eligibility gate (fail-closed for credit ONLY): true ⇒ frozen.
 * Cash-on-delivery / prepaid flows MUST NOT consult this. Read by the
 * buyer-credit checkout / credit draw paths and the credit-intelligence
 * chat ("credit risk <customer>").
 */
export async function isCreditFrozen(
  db: DbHandle, tenantId: string, subjectType: IdentitySubjectType, subjectId: string,
): Promise<boolean> {
  return (await getActiveFlag(db, tenantId, subjectType, subjectId)) != null;
}

// ── Due process: dispute + admin review ─────────────────────────────────────

/**
 * Subject-initiated dispute of an identity flag (reuses the chat dispute
 * intake seam: admin notification via disputeNotify + status flip to
 * 'disputed'). Claim-first: only an 'active' flag can be disputed; retries
 * are no-ops returning the current state.
 */
export async function disputeIdentityFlag(
  db: DbHandle,
  opts: { flagId: string; tenantId: string; note?: string; now?: Date },
): Promise<{ ok: boolean; status: IdentityFlagStatus; flagId: string }> {
  const now = opts.now ?? new Date();
  const flipped = (await db
    .update(identityFlags)
    .set({ status: "disputed", updatedAt: now })
    .where(and(eq(identityFlags.id, opts.flagId), eq(identityFlags.status, "active")))
    .returning({ id: identityFlags.id })) as unknown as { id: string }[];
  const [flag] = (await db.select().from(identityFlags).where(eq(identityFlags.id, opts.flagId)).limit(1)) as unknown as (typeof identityFlags.$inferSelect)[];
  if (!flag) return { ok: false, status: "cleared", flagId: opts.flagId };
  if (flipped.length > 0) {
    try {
      const { notifyTenantAdminWhatsApp } = await import("./adminAlerts");
      const { getDb } = await import("../db");
      const adb = (await getDb()) as any;
      if (adb) {
        await notifyTenantAdminWhatsApp(adb, opts.tenantId,
          `📋 Identity-flag dispute raised for ${flag.subjectType} ${flag.subjectId} (flag ${opts.flagId}). ` +
          `Please review the linked-default evidence.${opts.note ? ` Note: ${opts.note.slice(0, 140)}` : ""}`);
      }
    } catch { /* fail-open */ }
    const { writeAuditLog } = await import("../routers/audit");
    await writeAuditLog({
      actorId: String(flag.subjectId),
      actorRole: "user",
      action: "identity.flag_disputed",
      entityType: "identity_flag",
      entityId: opts.flagId,
      tenantId: opts.tenantId,
      summary: `Identity flag ${opts.flagId} disputed by ${flag.subjectType} ${flag.subjectId}`,
      after: { status: "disputed", note: opts.note ?? null },
    }).catch(() => {});
  }
  return { ok: true, status: flag.status as IdentityFlagStatus, flagId: opts.flagId };
}

/**
 * Admin review of an identity flag: 'clear' (eligibility restored — flag
 * resolved 'cleared') or 'confirm' (freeze stands — 'confirmed'). Claim-first
 * from active|disputed so double-reviews are no-ops; audited.
 */
export async function reviewIdentityFlag(
  db: DbHandle,
  opts: { flagId: string; tenantId: string; decision: "clear" | "confirm"; reviewerId: string; note?: string; now?: Date },
): Promise<{ ok: boolean; changed: boolean; status: IdentityFlagStatus }> {
  const now = opts.now ?? new Date();
  const target = opts.decision === "clear" ? "cleared" : "confirmed";
  const flipped = (await db
    .update(identityFlags)
    .set({ status: target, resolvedBy: opts.reviewerId, resolvedAt: now, resolutionNote: opts.note ?? null, updatedAt: now })
    .where(and(eq(identityFlags.id, opts.flagId), inArray(identityFlags.status, ["active", "disputed"])))
    .returning({ id: identityFlags.id })) as unknown as { id: string }[];
  const [flag] = (await db.select().from(identityFlags).where(eq(identityFlags.id, opts.flagId)).limit(1)) as unknown as (typeof identityFlags.$inferSelect)[];
  if (!flag) return { ok: false, changed: false, status: "cleared" };
  if (flipped.length > 0) {
    const { writeAuditLog } = await import("../routers/audit");
    await writeAuditLog({
      actorId: opts.reviewerId,
      actorRole: "admin",
      action: `identity.flag_${target}`,
      entityType: "identity_flag",
      entityId: opts.flagId,
      tenantId: opts.tenantId,
      summary: `Identity flag ${opts.flagId} ${target} by ${opts.reviewerId}${opts.note ? `: ${opts.note}` : ""}`,
      before: { status: "active|disputed" },
      after: { status: target, note: opts.note ?? null },
    }).catch(() => {});
    logLine("info", "identity_flag_reviewed", { tenantId: opts.tenantId, flagId: opts.flagId, decision: opts.decision });
  }
  return { ok: true, changed: flipped.length > 0, status: flag.status as IdentityFlagStatus };
}

// ── Velocity ceiling (additive creditScoring factor) ────────────────────────

/**
 * New-identity velocity ceiling: subjects with tenureDays below
 * NEW_IDENTITY_TENURE_DAYS are capped at NEW_IDENTITY_SCORE_CEILING (just
 * under grade B) until they build tenure. ADDITIVE post-core rule — the
 * pure factor weights are unchanged; applied by computeAndStoreSubjectScore.
 */
export function applyNewIdentityCeiling(score: number, tenureDays: number): { score: number; capped: boolean } {
  if (tenureDays < NEW_IDENTITY_TENURE_DAYS && score > NEW_IDENTITY_SCORE_CEILING) {
    return { score: NEW_IDENTITY_SCORE_CEILING, capped: true };
  }
  return { score, capped: false };
}

/** Stored-score helper for the chat/UI surfaces (score + frozen flag). */
export async function getScoreWithRiskFlag(
  db: DbHandle, tenantId: string, subjectType: IdentitySubjectType, subjectId: string,
) {
  const rows = (await db
    .select()
    .from(creditScores)
    .where(and(
      eq(creditScores.tenantId, tenantId),
      eq(creditScores.subjectType, subjectType),
      eq(creditScores.subjectId, subjectId),
    ))
    .limit(1)) as unknown as (typeof creditScores.$inferSelect)[];
  const frozen = await isCreditFrozen(db, tenantId, subjectType, subjectId);
  return { score: rows[0] ?? null, creditFrozen: frozen };
}
// === END W57 risk-shield ===
