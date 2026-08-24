/**
 * W30 auth-gates — step-up OTP challenges (V2#2 kill chain).
 *
 * High-risk money/role actions require a FRESH OTP sent to the tenant admin
 * phone, reusing the existing phoneAuth OTP primitives (WhatsApp send +
 * salted HMAC hash). Challenge rows live in step_up_challenges (mig 0094):
 * single-use, 10-minute TTL, 3-attempt cap.
 *
 * Gated actions (consumers):
 *   - escrow.updatePayoutBankDetails (payout-destination change)
 *   - escrow.requestWithdrawal above WITHDRAWAL_STEPUP_THRESHOLD (major units)
 *   - membership.add with role "owner"
 *   - payment.confirm admin override
 *
 * Pure core (evaluateChallenge) for unit tests + thin db wrappers.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { getDb } from "../db";
import { stepUpChallenges, users, tenantMemberships } from "../../drizzle/schema";
import {
  generateOtp,
  hashOtp,
  verifyOtpHash,
  sendWhatsAppOtp,
  normalisePhone,
} from "../routers/phoneAuth";

export type DbHandle = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export type StepUpPurpose =
  | "payout_change"
  | "withdrawal"
  | "owner_grant"
  | "payment_override";

const CHALLENGE_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 3;

// ─── Pure core ──────────────────────────────────────────────────────────────

export interface StepUpChallengeRow {
  id: string;
  tenantId: string;
  userId: string;
  purpose: string;
  otpHash: string;
  attempts: number;
  consumedAt: Date | null;
  expiresAt: Date;
}

export type ChallengeVerdict =
  | { ok: true }
  | { ok: false; reason: "consumed" | "expired" | "too_many_attempts" | "scope_mismatch" | "bad_otp" };

/**
 * Pure challenge evaluation: is this challenge row usable for (user, tenant,
 * purpose, otp) at `now`? No db, no env — deterministic for unit tests.
 */
export function evaluateChallenge(
  row: StepUpChallengeRow,
  args: { userId: string; tenantId: string; purpose: string; otp: string },
  verify: (stored: string, otp: string) => boolean,
  now: Date = new Date(),
): ChallengeVerdict {
  if (row.consumedAt) return { ok: false, reason: "consumed" };
  if (row.expiresAt.getTime() < now.getTime()) return { ok: false, reason: "expired" };
  if (row.attempts >= MAX_ATTEMPTS) return { ok: false, reason: "too_many_attempts" };
  if (row.userId !== args.userId || row.tenantId !== args.tenantId || row.purpose !== args.purpose) {
    return { ok: false, reason: "scope_mismatch" };
  }
  if (!verify(row.otpHash, args.otp)) return { ok: false, reason: "bad_otp" };
  return { ok: true };
}

/** Withdrawal amounts above this (major units) require step-up. Env-overridable. */
export function withdrawalStepUpThreshold(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.WITHDRAWAL_STEPUP_THRESHOLD ?? "100000");
  return Number.isFinite(raw) && raw >= 0 ? raw : 100000;
}

// ─── Tenant admin phone resolution ──────────────────────────────────────────

/**
 * The step-up OTP goes to the tenant ADMIN phone: the phone of an owner-role
 * member (tenant_memberships), falling back to a phone-bearing user whose
 * users.tenantId matches. Fail closed (null) when none is found.
 */
export async function resolveTenantAdminPhone(db: DbHandle, tenantId: string): Promise<string | null> {
  const ownerRows = await db
    .select({ userId: tenantMemberships.userId })
    .from(tenantMemberships)
    .where(and(eq(tenantMemberships.tenantId, tenantId), eq(tenantMemberships.role, "owner")))
    .limit(5)
    .catch(() => [] as { userId: string }[]);
  for (const m of ownerRows) {
    const uid = Number(m.userId);
    if (!Number.isFinite(uid)) continue;
    const [u] = await db
      .select({ phone: users.phone })
      .from(users)
      .where(eq(users.id, uid))
      .limit(1)
      .catch(() => [] as { phone: string | null }[]);
    if (u?.phone) return normalisePhone(u.phone);
  }
  const [fallback] = await db
    .select({ phone: users.phone })
    .from(users)
    .where(eq(users.tenantId, tenantId))
    .limit(5)
    .catch(() => [] as { phone: string | null }[]);
  if (fallback?.phone) return normalisePhone(fallback.phone);
  return null;
}

// ─── Issue / verify ─────────────────────────────────────────────────────────

/**
 * Issue a step-up challenge: sends a fresh OTP to the tenant admin phone.
 * Returns the challenge id (never the OTP).
 */
export async function issueStepUpChallenge(
  db: DbHandle,
  args: { tenantId: string; userId: string | number; purpose: StepUpPurpose },
): Promise<{ challengeId: string; expiresAt: Date; phoneHint: string }> {
  const phone = await resolveTenantAdminPhone(db, args.tenantId);
  if (!phone) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "No tenant admin phone on file — step-up verification is unavailable. Register a WhatsApp number for this tenant first.",
    });
  }
  const otp = generateOtp();
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS);
  const [row] = await db
    .insert(stepUpChallenges)
    .values({
      tenantId: args.tenantId,
      userId: String(args.userId),
      purpose: args.purpose,
      otpHash: hashOtp(otp),
      phone,
      attempts: 0,
      expiresAt,
    })
    .returning({ id: stepUpChallenges.id });
  await sendWhatsAppOtp(phone, otp);
  return {
    challengeId: row.id,
    expiresAt,
    phoneHint: `${"*".repeat(Math.max(0, phone.length - 4))}${phone.slice(-4)}`,
  };
}

/**
 * Verify + consume a challenge exactly once. The consume is a guarded UPDATE
 * (consumed_at IS NULL) so concurrent verifiers of the same challenge can
 * never both succeed. Throws TRPCError on any failure (fail closed).
 */
export async function consumeStepUpChallenge(
  db: DbHandle,
  args: {
    challengeId: string;
    otp: string;
    userId: string | number;
    tenantId: string;
    purpose: StepUpPurpose;
  },
): Promise<void> {
  const [row] = await db
    .select()
    .from(stepUpChallenges)
    .where(eq(stepUpChallenges.id, args.challengeId))
    .limit(1);
  if (!row) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Step-up challenge not found. Request a fresh OTP." });
  }

  const verdict = evaluateChallenge(
    row as StepUpChallengeRow,
    { userId: String(args.userId), tenantId: args.tenantId, purpose: args.purpose, otp: args.otp },
    verifyOtpHash,
  );
  if (!verdict.ok) {
    // Count failures against the attempt cap (expired/consumed/capped rows
    // are terminal already — no counter bump needed there).
    if (verdict.reason === "bad_otp" || verdict.reason === "scope_mismatch") {
      await db
        .update(stepUpChallenges)
        .set({ attempts: sql`${stepUpChallenges.attempts} + 1` })
        .where(eq(stepUpChallenges.id, row.id))
        .catch(() => {});
    }
    const message =
      verdict.reason === "expired" ? "Step-up OTP expired. Request a fresh one."
      : verdict.reason === "consumed" ? "Step-up challenge already used. Request a fresh OTP."
      : verdict.reason === "too_many_attempts" ? "Too many failed step-up attempts. Request a fresh OTP."
      : verdict.reason === "scope_mismatch" ? "Step-up challenge does not match this action."
      : "Invalid step-up OTP.";
    throw new TRPCError({ code: "UNAUTHORIZED", message });
  }

  const consumed = await db
    .update(stepUpChallenges)
    .set({ consumedAt: new Date() })
    .where(and(eq(stepUpChallenges.id, row.id), isNull(stepUpChallenges.consumedAt)))
    .returning({ id: stepUpChallenges.id });
  if (consumed.length === 0) {
    throw new TRPCError({ code: "CONFLICT", message: "Step-up challenge already used." });
  }
}

/**
 * Require step-up for a gated mutation. When `required` is false this is a
 * no-op. Otherwise the input must carry a valid challengeId + otp.
 */
export async function requireStepUp(
  db: DbHandle,
  args: {
    required: boolean;
    tenantId: string;
    userId: string | number;
    purpose: StepUpPurpose;
    stepUpChallengeId?: string | null;
    stepUpOtp?: string | null;
  },
): Promise<void> {
  if (!args.required) return;
  if (!args.stepUpChallengeId || !args.stepUpOtp) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `This action requires step-up verification (${args.purpose}). Request an OTP challenge first (stepUp.request).`,
    });
  }
  await consumeStepUpChallenge(db, {
    challengeId: args.stepUpChallengeId,
    otp: args.stepUpOtp,
    userId: args.userId,
    tenantId: args.tenantId,
    purpose: args.purpose,
  });
}
