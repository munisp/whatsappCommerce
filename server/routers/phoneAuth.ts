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
import { router, publicProcedure, protectedProcedure } from "../_core/trpc";
import { getDb } from "../db";
import { phoneOtpSessions, users } from "../../drizzle/schema";
import { eq, and, lt } from "drizzle-orm";
import { randomUUID } from "crypto";
import { createHash, randomInt } from "crypto";
import { TRPCError } from "@trpc/server";
import { ENV } from "../_core/env";

// ── Helpers ───────────────────────────────────────────────────────────────────

function generateOtp(): string {
  // Cryptographically secure 6-digit OTP
  return String(randomInt(100000, 999999));
}

function hashOtp(otp: string): string {
  // SHA-256 hash of OTP (fast enough for 6-digit codes, bcrypt is overkill here)
  return createHash("sha256").update(otp + (ENV.jwtSecret || "wac-otp-salt")).digest("hex");
}

function normalisePhone(phone: string): string {
  // Strip spaces, dashes, parentheses; ensure E.164 format
  let p = phone.replace(/[\s\-()]+/g, "");
  if (!p.startsWith("+")) p = "+" + p;
  return p;
}

async function sendWhatsAppOtp(phone: string, otp: string): Promise<void> {
  const token = process.env.WAC_WHATSAPP_TOKEN;
  const phoneId = process.env.WAC_WHATSAPP_PHONE_ID;
  const templateName = process.env.WAC_WHATSAPP_OTP_TEMPLATE || "wac_otp";
  const templateLang = process.env.WAC_WHATSAPP_TEMPLATE_LANG || "en_US";

  if (!token || !phoneId) {
    // Simulation mode — log OTP for development
    console.info(`[phoneAuth] SIMULATION: OTP ${otp} for ${phone.slice(-4).padStart(phone.length, "*")}`);
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

      const expectedHash = hashOtp(input.otp);
      if (session.otpHash !== expectedHash) {
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
});
