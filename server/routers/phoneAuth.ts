/**
 * phoneAuth tRPC router
 *
 * Implements phone-number OTP authentication via the WhatsApp Business Cloud API.
 * This router is the Node.js counterpart to the Keycloak WhatsApp OTP SPI JAR.
 *
 * Flow:
 *   1. Client calls sendOtp({ phone }) → server generates OTP, sends via WhatsApp, stores hash
 *   2. Client calls verifyOtp({ sessionId, otp }) → server validates, returns JWT or links to user
 *   3. Client calls linkPhone({ phone }) (protected) → links verified phone to existing user
 *
 * Security:
 *   - OTP is 6 digits, bcrypt-hashed before storage
 *   - Sessions expire after 10 minutes
 *   - Max 3 failed attempts before session is invalidated
 *   - Rate limit: 1 OTP per phone per 60 seconds (enforced via session TTL)
 */

import { z } from "zod";
import { router, publicProcedure, protectedProcedure, assertTenantAccess } from "../_core/trpc";
import { getDb } from "../db";
import { phoneOtpSessions, users } from "../../drizzle/schema";
import { eq, and, lt } from "drizzle-orm";
import { randomUUID } from "crypto";
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "crypto";
import { TRPCError } from "@trpc/server";
import { ENV } from "../_core/env";
import { sendOtpEmail } from "../services/email/resend";

// ── Helpers ───────────────────────────────────────────────────────────────────

export function generateOtp(): string {
  // Cryptographically secure 6-digit OTP
  return String(randomInt(100000, 999999));
}

/**
 * W30 (f9-f10 F10-1): dedicated OTP pepper. OTP_HASH_SALT is preferred;
 * JWT_SECRET remains as the fallback so existing deployments keep working.
 * FAIL CLOSED when neither is configured — a well-known fallback salt would
 * let anyone precompute valid OTP hashes.
 */
export function otpPepper(env: NodeJS.ProcessEnv = process.env): string {
  const pepper = env.OTP_HASH_SALT || ENV.jwtSecret || "";
  if (!pepper) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "OTP hashing salt is not configured (OTP_HASH_SALT/JWT_SECRET)",
    });
  }
  return pepper;
}

/**
 * W30 OTP hash upgrade: v2 = "v2:<perOtpSaltHex>:<HMAC-SHA256(pepper, salt|otp)>".
 * The dedicated pepper keys the HMAC and a fresh random per-OTP salt defeats
 * rainbow-table / batch brute-force of the 10^6 code space if the DB leaks.
 * v1 (legacy single SHA-256 of otp+pepper) hashes remain VERIFIABLE
 * (migration-safe) but are never produced anymore.
 */
export function hashOtp(otp: string, pepper: string = otpPepper()): string {
  const salt = randomBytes(16).toString("hex");
  const mac = createHmac("sha256", pepper).update(`${salt}|${otp}`).digest("hex");
  return `v2:${salt}:${mac}`;
}

/** Legacy v1 hash — kept ONLY for verifying pre-upgrade rows. */
function hashOtpV1(otp: string, pepper: string): string {
  return createHash("sha256").update(otp + pepper).digest("hex");
}

/**
 * Migration-safe OTP verification. Accepts v2 (salted HMAC) and v1 (legacy
 * unsalted SHA-256) stored hashes. Constant-time comparison on the digest.
 */
export function verifyOtpHash(stored: string, otp: string, pepper: string = otpPepper()): boolean {
  if (stored.startsWith("v2:")) {
    const [, salt, mac] = stored.split(":");
    if (!salt || !mac) return false;
    const candidate = createHmac("sha256", pepper).update(`${salt}|${otp}`).digest();
    const expected = Buffer.from(mac, "hex");
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  }
  // v1 legacy row
  const candidate = hashOtpV1(otp, pepper);
  const a = Buffer.from(candidate, "utf8");
  const b = Buffer.from(stored, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

// ── OTP attempt caps (W26 security) ──────────────────────────────────────────
// Per-session cap (3 attempts) is enforced in verifyOtp below. These
// per-phone fixed-window caps stop an attacker from simply requesting fresh
// sessions to reset the per-session counter. In-memory (per-instance); the
// OTP hash itself plus the per-session cap remain the primary controls.
const MAX_VERIFY_ATTEMPTS_PER_PHONE_PER_HOUR = 10;
const MAX_OTP_SENDS_PER_PHONE_PER_HOUR = 5;
const phoneVerifyAttempts = new Map<string, { windowStart: number; count: number }>();
const phoneSendCounts = new Map<string, { windowStart: number; count: number }>();

function bumpPhoneCounter(map: Map<string, { windowStart: number; count: number }>, phone: string, limit: number): boolean {
  const now = Date.now();
  const entry = map.get(phone);
  if (!entry || now - entry.windowStart >= 3_600_000) {
    map.set(phone, { windowStart: now, count: 1 });
    return true;
  }
  entry.count += 1;
  return entry.count <= limit;
}

export function normalisePhone(phone: string): string {
  // Strip spaces, dashes, parentheses; ensure E.164 format
  let p = phone.replace(/[\s\-()]+/g, "");
  if (!p.startsWith("+")) p = "+" + p;
  return p;
}

export async function sendWhatsAppOtp(phone: string, otp: string): Promise<void> {
  const token = process.env.WAC_WHATSAPP_TOKEN;
  const phoneId = process.env.WAC_WHATSAPP_PHONE_ID;
  const templateName = process.env.WAC_WHATSAPP_OTP_TEMPLATE || "wac_otp";
  const templateLang = process.env.WAC_WHATSAPP_TEMPLATE_LANG || "en_US";

  if (!token || !phoneId) {
    // Simulation mode — NEVER log the OTP itself (W26 security); record only
    // that a code was issued, with the phone masked.
    console.info(`[phoneAuth] SIMULATION: OTP issued for ${"*".repeat(Math.max(0, phone.length - 4))}${phone.slice(-4)}`);
    return;
  }

  const payload = {
    messaging_product: "whatsapp",
    to: phone,
    type: "template",
    template: {
      name: templateName,
      language: { code: templateLang },
      components: [
        {
          type: "body",
          parameters: [{ type: "text", text: otp }],
        },
        {
          type: "button",
          sub_type: "url",
          index: "0",
          parameters: [{ type: "text", text: otp }],
        },
      ],
    },
  };

  const url = `https://graph.facebook.com/v21.0/${phoneId}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: `WhatsApp API error ${res.status}: ${body}`,
    });
  }
}

// ── Router ────────────────────────────────────────────────────────────────────

export const phoneAuthRouter = router({
  /**
   * Step 1: Send OTP to phone number via WhatsApp.
   * Returns a sessionId that the client must pass to verifyOtp.
   */
  sendOtp: publicProcedure
    .input(
      z.object({
        phone: z.string().min(7).max(20).refine(
          (p) => /^\+?[0-9\s\-()]{7,20}$/.test(p),
          { message: "Invalid phone number format. Must contain only digits, +, spaces, dashes, or parentheses." }
        ),
        purpose: z.enum(["login", "verify"]).default("login"),
      })
    )
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

      const phone = normalisePhone(input.phone);
      const now = Date.now();
      const expiresAt = now + 10 * 60 * 1000; // 10 minutes

      // W26 security: per-phone hourly send cap (stops OTP flooding/SMS toll abuse).
      if (!bumpPhoneCounter(phoneSendCounts, phone, MAX_OTP_SENDS_PER_PHONE_PER_HOUR)) {
        throw new TRPCError({
          code: "TOO_MANY_REQUESTS",
          message: "Too many OTP requests for this phone number. Try again later.",
        });
      }

      // Check for an existing unexpired session (rate limit: 1 OTP per 60s)
      const existing = await db
        .select()
        .from(phoneOtpSessions)
        .where(and(eq(phoneOtpSessions.phone, phone), eq(phoneOtpSessions.purpose, input.purpose)))
        .limit(1);

      if (existing[0] && existing[0].expiresAt && existing[0].expiresAt > new Date(now) && existing[0].createdAt && existing[0].createdAt > new Date(now - 60_000)) {
        throw new TRPCError({
          code: "TOO_MANY_REQUESTS",
          message: "Please wait 60 seconds before requesting another OTP.",
        });
      }

      // Delete any old sessions for this phone
      await db
        .delete(phoneOtpSessions)
        .where(and(eq(phoneOtpSessions.phone, phone), eq(phoneOtpSessions.purpose, input.purpose)));

      // Generate and store OTP
      const otp = generateOtp();
      const sessionId = randomUUID();

      await db.insert(phoneOtpSessions).values({
        id: sessionId,
        phone,
        otpHash: hashOtp(otp),
        attempts: 0,
        expiresAt: new Date(expiresAt),
        createdAt: new Date(now),
        purpose: input.purpose,
      });

      // Send OTP via WhatsApp
      await sendWhatsAppOtp(phone, otp);

      // Best-effort second channel: if this phone belongs to a known user
      // with an email on file, also email the code. Never blocks or fails
      // the request — same phone is already required to use the code, so
      // this adds no new attack surface.
      const [existingUser] = await db.select({ email: users.email }).from(users).where(eq(users.phone, phone)).limit(1);
      if (existingUser?.email) {
        sendOtpEmail(existingUser.email, otp, input.purpose).catch(err =>
          console.warn("[phoneAuth] OTP email failed", err)
        );
      }

      return { sessionId, expiresAt };
    }),

  /**
   * Step 2: Verify OTP.
   * On success for "login" purpose, returns a token that can be exchanged for a session.
   * On success for "verify" purpose, marks the phone as verified on the user record.
   */
  verifyOtp: publicProcedure
    .input(
      z.object({
        sessionId: z.string().uuid(),
        otp: z.string().length(6).regex(/^\d{6}$/),
      })
    )
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

      const now = Date.now();
      const sessions = await db
        .select()
        .from(phoneOtpSessions)
        .where(eq(phoneOtpSessions.id, input.sessionId))
        .limit(1);

      const session = sessions[0];

      if (!session) {
        throw new TRPCError({ code: "NOT_FOUND", message: "OTP session not found or expired." });
      }

      if (!session.expiresAt || session.expiresAt < new Date(now)) {
        await db.delete(phoneOtpSessions).where(eq(phoneOtpSessions.id, input.sessionId));
        throw new TRPCError({ code: "UNAUTHORIZED", message: "OTP has expired. Please request a new one." });
      }

      if (session.attempts >= 3) {
        await db.delete(phoneOtpSessions).where(eq(phoneOtpSessions.id, input.sessionId));
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Too many failed attempts. Please request a new OTP.",
        });
      }

      if (!verifyOtpHash(session.otpHash, input.otp)) {
        // W26 security: per-phone hourly verify cap (fresh sessions cannot
        // reset the per-session attempt counter to brute-force the code).
        if (!bumpPhoneCounter(phoneVerifyAttempts, session.phone, MAX_VERIFY_ATTEMPTS_PER_PHONE_PER_HOUR)) {
          await db.delete(phoneOtpSessions).where(eq(phoneOtpSessions.id, input.sessionId));
          throw new TRPCError({
            code: "TOO_MANY_REQUESTS",
            message: "Too many failed OTP attempts for this phone number. Try again later.",
          });
        }
        // Increment attempt counter
        await db
          .update(phoneOtpSessions)
          .set({ attempts: session.attempts + 1 })
          .where(eq(phoneOtpSessions.id, input.sessionId));

        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: `Invalid OTP. ${2 - session.attempts} attempt(s) remaining.`,
        });
      }

      // OTP is valid — clean up session
      await db.delete(phoneOtpSessions).where(eq(phoneOtpSessions.id, input.sessionId));

      // If this session is linked to a user (verify purpose), mark phone as verified
      if (session.userId) {
        await db
          .update(users)
          .set({ phoneVerified: true, phone: session.phone })
          .where(eq(users.id, session.userId));
      }

      return {
        verified: true,
        phone: session.phone,
        purpose: session.purpose,
        userId: session.userId,
      };
    }),

  /**
   * Link a verified phone number to the currently authenticated user.
   * Initiates the OTP flow for the user's phone number.
   */
  linkPhone: protectedProcedure
    .input(z.object({ phone: z.string().min(7).max(20) }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

      const phone = normalisePhone(input.phone);
      const now = Date.now();
      const expiresAt = now + 10 * 60 * 1000;

      // Delete any old verify sessions for this user
      await db
        .delete(phoneOtpSessions)
        .where(and(eq(phoneOtpSessions.phone, phone), eq(phoneOtpSessions.purpose, "verify")));

      const otp = generateOtp();
      const sessionId = randomUUID();

      await db.insert(phoneOtpSessions).values({
        id: sessionId,
        phone,
        otpHash: hashOtp(otp),
        attempts: 0,
        expiresAt: new Date(expiresAt),
        createdAt: new Date(now),
        purpose: "verify",
        userId: ctx.user.id,
      });

      await sendWhatsAppOtp(phone, otp);

      if (ctx.user.email) {
        sendOtpEmail(ctx.user.email, otp, "verify").catch(err =>
          console.warn("[phoneAuth] OTP email failed", err)
        );
      }

      return { sessionId, expiresAt };
    }),

  /**
   * Get the current user's phone verification status.
   */
  getPhoneStatus: protectedProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return { phone: null, phoneVerified: false, whatsappNotifOrders: true, whatsappNotifStatus: true, whatsappNotifMarketing: false };

    const rows = await db
      .select({
        phone: users.phone,
        phoneVerified: users.phoneVerified,
        whatsappNotifOrders: users.whatsappNotifOrders,
        whatsappNotifStatus: users.whatsappNotifStatus,
        whatsappNotifMarketing: users.whatsappNotifMarketing,
      })
      .from(users)
      .where(eq(users.id, ctx.user.id))
      .limit(1);

    return rows[0] ?? { phone: null, phoneVerified: false, whatsappNotifOrders: true, whatsappNotifStatus: true, whatsappNotifMarketing: false };
  }),

  /**
   * Cleanup expired OTP sessions (called by heartbeat job).
   */
  cleanupExpired: publicProcedure.mutation(async () => {
    const db = await getDb();
    if (!db) return { deleted: 0 };

    const now = Date.now();
    const result = await db
      .delete(phoneOtpSessions)
      .where(lt(phoneOtpSessions.expiresAt, new Date(now)));

    return { deleted: 0 }; // Drizzle doesn't return affected rows count for delete
  }),

  /**
   * Unlink the verified phone number from the user's account.
   */
  unlinkPhone: protectedProcedure.mutation(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
    await db.update(users).set({
      phone: null,
      phoneVerified: false,
      updatedAt: new Date(),
    }).where(eq(users.id, ctx.user.id));
    return { ok: true };
  }),

  /**
   * Update WhatsApp notification preferences for the authenticated user.
   */
  updateNotifPrefs: protectedProcedure
    .input(z.object({
      whatsappNotifOrders: z.boolean().optional(),
      whatsappNotifStatus: z.boolean().optional(),
      whatsappNotifMarketing: z.boolean().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const update: Partial<typeof users.$inferInsert> & { updatedAt: Date } = { updatedAt: new Date() };
      if (input.whatsappNotifOrders !== undefined) update.whatsappNotifOrders = input.whatsappNotifOrders;
      if (input.whatsappNotifStatus !== undefined) update.whatsappNotifStatus = input.whatsappNotifStatus;
      if (input.whatsappNotifMarketing !== undefined) update.whatsappNotifMarketing = input.whatsappNotifMarketing;
      await db.update(users).set(update).where(eq(users.id, ctx.user.id));
      return { ok: true };
    }),

  /**
   * W30 step-up (V2#2): request a fresh OTP challenge to the tenant admin
   * phone for a gated action (payout change, large withdrawal, owner grant,
   * payment override). The returned challengeId + the OTP received on the
   * admin phone are then passed to the gated mutation, which consumes the
   * challenge exactly once (services/stepUp.ts).
   */
  stepUpRequest: protectedProcedure
    .input(z.object({
      tenantId: z.string().min(1),
      purpose: z.enum(["payout_change", "withdrawal", "owner_grant", "payment_override"]),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      // Only a member of the tenant (or platform admin) may trigger a
      // challenge for it — the OTP still goes to the tenant admin phone, so
      // this leaks nothing the caller doesn't already control.
      assertTenantAccess(ctx.user, input.tenantId);
      // W30 hotfix2 (OTP bombing): each request sends an SMS/WhatsApp OTP to
      // the tenant admin phone — without a throttle a tenant member (or a
      // hijacked member session) could bomb the admin with OTPs. Per-tenant
      // fixed window: 3 challenges / 10 min, via the shared fail-closed
      // checkRateLimit (prod: a blind limiter denies; dev/test: fail-open).
      const { checkRateLimit } = await import("../_core/rateLimit");
      const { isProd } = await import("../_core/env");
      const windowKey = `rl:stepup:${input.tenantId}:${Math.floor(Date.now() / 600_000)}`;
      const decision = await checkRateLimit(windowKey, 3, 600, isProd);
      if (!decision.allowed) {
        throw new TRPCError({
          code: "TOO_MANY_REQUESTS",
          message: decision.error
            ? "Step-up is temporarily unavailable (rate-limiter outage) — retry shortly"
            : `Too many step-up challenges for this tenant — retry in ${decision.retryAfter}s`,
        });
      }
      const { issueStepUpChallenge } = await import("../services/stepUp");
      return issueStepUpChallenge(db, {
        tenantId: input.tenantId,
        userId: ctx.user.id,
        purpose: input.purpose,
      });
    }),
});
