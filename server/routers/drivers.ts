/**
 * drivers.ts — platform-wide independent delivery driver pool.
 *
 * Replaces the per-tenant ONB-S-10 `riders` router (retired 2026-09-26 on the user's explicit
 * direction): "let's have our own drivers, they'll have their own apps, then register, switch on
 * their location, then merchant can pick the driver closest to them to pick up rides to deliver."
 *
 * Two audiences:
 *  - DRIVER-facing (publicProcedure): sign up, verify by email OTP, go online/offline, push their
 *    current location, see their assigned deliveries, update a delivery's status. Drivers are NOT
 *    platform users (no Keycloak account) — auth is a signed JWT ("driver_identity") returned after
 *    OTP verification and passed back as `token` on every subsequent call, the same pattern
 *    phoneAuth.ts already uses for its short-lived `identityProof`, just longer-lived here since this
 *    IS the driver's ongoing session, not a one-shot proof for a follow-up action.
 *  - MERCHANT-facing (protectedProcedure, tenant-scoped): see nearby ONLINE drivers ranked by
 *    distance from the tenant's own location, assign one to a delivery.
 *
 * Email OTP reuses phoneAuth.ts's pure hashing primitives (generateOtp/hashOtp/verifyOtpHash) and
 * sendOtpEmail from services/email/resend.ts (already live in this cluster) — no new crypto, no new
 * email integration, just a new identifier (email, not phone) and a dedicated session table.
 */
import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import jwt from "jsonwebtoken";
import { protectedProcedure, publicProcedure, router, assertTenantAccess } from "../_core/trpc";
import { getDb } from "../db";
import { drivers, driverEmailOtpSessions, deliveries, merchantLocations } from "../../drizzle/schema";
import { ENV } from "../_core/env";
import { generateOtp, hashOtp, verifyOtpHash } from "./phoneAuth";
import { sendOtpEmail } from "../services/email/resend";
import { haversineKm } from "../services/geoDiscovery";
import { writeAuditLog } from "./audit";

async function requireDb() {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
  return db;
}

const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes, matches phoneAuth.ts
const MAX_OTP_ATTEMPTS = 5;
// Drivers are out doing deliveries across many days, not staff at a dashboard — a much longer session
// than the 12h platform default (server/_core/auth.ts's sessionTtl) is a deliberate choice, not an
// oversight: losing access to "update my delivery status" mid-route is worse than the lower risk a
// longer-lived driver token carries (it can only touch driver-scoped actions, never tenant data).
const DRIVER_SESSION_TTL = "30d";

interface DriverIdentity {
  type: "driver_identity";
  driverId: string;
  email: string;
}

function signDriverToken(driverId: string, email: string): string {
  return jwt.sign({ type: "driver_identity", driverId, email } satisfies DriverIdentity, ENV.jwtSecret, {
    expiresIn: DRIVER_SESSION_TTL,
  });
}

async function requireDriver(db: NonNullable<Awaited<ReturnType<typeof getDb>>>, token: string) {
  let proof: DriverIdentity;
  try {
    proof = jwt.verify(token, ENV.jwtSecret) as DriverIdentity;
  } catch {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Session expired or invalid — please sign in again." });
  }
  if (proof?.type !== "driver_identity" || !proof.driverId) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Invalid session token." });
  }
  const [driver] = await db.select().from(drivers).where(eq(drivers.id, proof.driverId)).limit(1);
  if (!driver) throw new TRPCError({ code: "NOT_FOUND", message: "Driver account not found." });
  if (driver.status === "suspended") throw new TRPCError({ code: "FORBIDDEN", message: "This driver account is suspended." });
  return driver;
}

function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

async function issueOtp(db: NonNullable<Awaited<ReturnType<typeof getDb>>>, email: string, purpose: "signup" | "login") {
  const otp = generateOtp();
  const otpHash = hashOtp(otp);
  const now = Date.now();
  await db.insert(driverEmailOtpSessions).values({
    email, otpHash, attempts: 0, purpose,
    expiresAt: new Date(now + OTP_TTL_MS),
    createdAt: new Date(now),
  }).onConflictDoUpdate({
    target: [driverEmailOtpSessions.email, driverEmailOtpSessions.purpose],
    set: { otpHash, attempts: 0, expiresAt: new Date(now + OTP_TTL_MS), createdAt: new Date(now) },
  });
  await sendOtpEmail(email, otp, purpose === "signup" ? "verify" : "login");
}

export const driversRouter = router({
  // ─── Driver-facing ──────────────────────────────────────────────────────

  /** Step 1 of signup: capture profile, email an OTP to verify. Re-signing up an unverified email just resends. */
  signup: publicProcedure
    .input(z.object({
      name: z.string().trim().min(1).max(160),
      phone: z.string().trim().min(7).max(30),
      email: z.string().trim().email().max(255),
      vehicleType: z.string().trim().max(30).optional(),
    }))
    .mutation(async ({ input }) => {
      const db = await requireDb();
      const email = normaliseEmail(input.email);
      const [existing] = await db.select().from(drivers).where(eq(drivers.email, email)).limit(1);
      if (existing?.emailVerifiedAt) {
        throw new TRPCError({ code: "CONFLICT", message: "An account with this email already exists — try signing in instead." });
      }
      if (existing) {
        // Unverified row from an earlier abandoned signup — update it in place rather than duplicate.
        await db.update(drivers).set({
          name: input.name, phone: input.phone, vehicleType: input.vehicleType ?? null, updatedAt: new Date(),
        }).where(eq(drivers.id, existing.id));
      } else {
        await db.insert(drivers).values({
          name: input.name, phone: input.phone, email, vehicleType: input.vehicleType ?? null,
          status: "pending_verification",
        });
      }
      await issueOtp(db, email, "signup");
      return { sent: true };
    }),

  /** Returning driver: request a fresh login OTP. */
  requestLoginOtp: publicProcedure
    .input(z.object({ email: z.string().trim().email().max(255) }))
    .mutation(async ({ input }) => {
      const db = await requireDb();
      const email = normaliseEmail(input.email);
      const [driver] = await db.select().from(drivers).where(eq(drivers.email, email)).limit(1);
      // Don't reveal whether the email is registered — same response either way.
      if (driver?.emailVerifiedAt) await issueOtp(db, email, "login");
      return { sent: true };
    }),

  /** Step 2: verify the OTP. On success, signup rows get emailVerifiedAt + flip to "offline"; either way returns a session token. */
  verifyOtp: publicProcedure
    .input(z.object({
      email: z.string().trim().email().max(255),
      otp: z.string().min(4).max(10),
      purpose: z.enum(["signup", "login"]),
    }))
    .mutation(async ({ input }) => {
      const db = await requireDb();
      const email = normaliseEmail(input.email);
      const [session] = await db.select().from(driverEmailOtpSessions)
        .where(and(eq(driverEmailOtpSessions.email, email), eq(driverEmailOtpSessions.purpose, input.purpose))).limit(1);
      if (!session || session.expiresAt < new Date()) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Code expired or not found — request a new one." });
      }
      if (session.attempts >= MAX_OTP_ATTEMPTS) {
        throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "Too many attempts — request a new code." });
      }
      if (!verifyOtpHash(session.otpHash, input.otp)) {
        await db.update(driverEmailOtpSessions).set({ attempts: session.attempts + 1 })
          .where(eq(driverEmailOtpSessions.id, session.id));
        throw new TRPCError({ code: "BAD_REQUEST", message: "Incorrect code." });
      }
      await db.delete(driverEmailOtpSessions).where(eq(driverEmailOtpSessions.id, session.id));

      const [driver] = await db.select().from(drivers).where(eq(drivers.email, email)).limit(1);
      if (!driver) throw new TRPCError({ code: "NOT_FOUND", message: "Driver account not found." });
      if (input.purpose === "signup" && !driver.emailVerifiedAt) {
        await db.update(drivers).set({ emailVerifiedAt: new Date(), status: "offline", updatedAt: new Date() })
          .where(eq(drivers.id, driver.id));
      }
      const [fresh] = await db.select().from(drivers).where(eq(drivers.id, driver.id)).limit(1);
      return { token: signDriverToken(driver.id, email), driver: fresh! };
    }),

  /** Whoever holds the token — used by the driver page on load to restore a session. */
  me: publicProcedure
    .input(z.object({ token: z.string() }))
    .query(async ({ input }) => {
      const db = await requireDb();
      const driver = await requireDriver(db, input.token);
      return driver;
    }),

  goOnline: publicProcedure
    .input(z.object({ token: z.string() }))
    .mutation(async ({ input }) => {
      const db = await requireDb();
      const driver = await requireDriver(db, input.token);
      await db.update(drivers).set({ status: "online", updatedAt: new Date() }).where(eq(drivers.id, driver.id));
      return { status: "online" as const };
    }),

  goOffline: publicProcedure
    .input(z.object({ token: z.string() }))
    .mutation(async ({ input }) => {
      const db = await requireDb();
      const driver = await requireDriver(db, input.token);
      await db.update(drivers).set({ status: "offline", updatedAt: new Date() }).where(eq(drivers.id, driver.id));
      return { status: "offline" as const };
    }),

  /** Pushed periodically by the driver's own browser (Geolocation watchPosition) while online. */
  updateLocation: publicProcedure
    .input(z.object({ token: z.string(), lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }))
    .mutation(async ({ input }) => {
      const db = await requireDb();
      const driver = await requireDriver(db, input.token);
      await db.update(drivers).set({
        currentLat: String(input.lat), currentLng: String(input.lng), lastLocationAt: new Date(), updatedAt: new Date(),
      }).where(eq(drivers.id, driver.id));
      return { ok: true };
    }),

  myDeliveries: publicProcedure
    .input(z.object({ token: z.string() }))
    .query(async ({ input }) => {
      const db = await requireDb();
      const driver = await requireDriver(db, input.token);
      return db.select().from(deliveries).where(eq(deliveries.driverId, driver.id)).orderBy(deliveries.updatedAt);
    }),

  /** Driver marks progress on an assigned delivery. Reuses the same status pipeline (+ escrow hook) the merchant dashboard path uses. */
  updateDeliveryStatus: publicProcedure
    .input(z.object({
      token: z.string(),
      deliveryId: z.string().uuid(),
      status: z.enum(["picked_up", "in_transit", "delivered", "failed"]),
    }))
    .mutation(async ({ input }) => {
      const db = await requireDb();
      const driver = await requireDriver(db, input.token);
      const [delivery] = await db.select().from(deliveries).where(eq(deliveries.id, input.deliveryId)).limit(1);
      if (!delivery) throw new TRPCError({ code: "NOT_FOUND", message: "Delivery not found." });
      if (delivery.driverId !== driver.id) {
        throw new TRPCError({ code: "FORBIDDEN", message: "This delivery isn't assigned to you." });
      }
      const { applyDeliveryStatus } = await import("../services/delivery/service");
      const result = await applyDeliveryStatus(db, delivery.id, { status: input.status });
      await writeAuditLog({
        actorId: `driver:${driver.id}`, actorRole: "user",
        action: "driver.statusUpdate", entityType: "delivery", entityId: delivery.id,
        tenantId: delivery.tenantId,
        summary: `Driver ${driver.name} marked delivery ${delivery.id} as ${input.status}`,
        before: { status: delivery.status }, after: { status: input.status },
      });
      return result;
    }),

  // ─── Merchant-facing ────────────────────────────────────────────────────

  /** Online drivers ranked by distance from the tenant's own (primary) location. */
  nearby: protectedProcedure
    .input(z.object({ tenantId: z.string(), radiusKm: z.number().min(0.1).max(200).default(30) }))
    .query(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await requireDb();
      const [loc] = await db.select().from(merchantLocations).where(eq(merchantLocations.tenantId, input.tenantId)).limit(1);
      if (!loc) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Set your business location in Settings before assigning a driver." });
      }
      const merchantLat = Number(loc.latitude), merchantLng = Number(loc.longitude);
      const online = await db.select().from(drivers).where(eq(drivers.status, "online"));
      return online
        .filter((d) => d.currentLat != null && d.currentLng != null)
        .map((d) => ({
          id: d.id,
          name: d.name,
          vehicleType: d.vehicleType,
          lastLocationAt: d.lastLocationAt,
          distanceKm: Math.round(haversineKm(merchantLat, merchantLng, Number(d.currentLat), Number(d.currentLng)) * 10) / 10,
        }))
        .filter((d) => d.distanceKm <= input.radiusKm)
        .sort((a, b) => a.distanceKm - b.distanceKm);
    }),

  /** Assign an online driver to a delivery. Returns the driver's phone so the merchant can coordinate directly. */
  assign: protectedProcedure
    .input(z.object({ tenantId: z.string(), orderId: z.string(), driverId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await requireDb();
      const [driver] = await db.select().from(drivers).where(eq(drivers.id, input.driverId)).limit(1);
      if (!driver) throw new TRPCError({ code: "NOT_FOUND", message: "Driver not found." });
      if (driver.status !== "online") {
        throw new TRPCError({ code: "CONFLICT", message: `Driver is ${driver.status} — only online drivers can be assigned.` });
      }
      // Book the delivery on first assignment — no separate "book delivery" step needed. bookDelivery
      // is idempotent (returns the existing row if one's already active), and the built-in
      // "local_dispatch" courier adapter (server/services/delivery/localDispatch.ts) requires no
      // external API — it's the deterministic, always-available default for a merchant's own drivers.
      const { bookDelivery } = await import("../services/delivery/service");
      const { delivery } = await bookDelivery(db, { tenantId: input.tenantId, orderId: input.orderId });
      if (["delivered", "cancelled", "failed"].includes(delivery.status)) {
        throw new TRPCError({ code: "CONFLICT", message: `Delivery is already ${delivery.status}.` });
      }
      await db.update(deliveries).set({ driverId: driver.id, updatedAt: new Date() }).where(eq(deliveries.id, delivery.id));
      await writeAuditLog({
        actorId: String(ctx.user!.id), actorRole: ctx.user!.role,
        action: "driver.assigned", entityType: "delivery", entityId: delivery.id,
        tenantId: input.tenantId,
        summary: `Delivery ${delivery.id} (order ${delivery.orderId}) assigned to driver ${driver.name} (${driver.phone})`,
        before: { driverId: delivery.driverId ?? null }, after: { driverId: driver.id },
      });
      try {
        const { sendEmail } = await import("../services/email/resend");
        await sendEmail({
          to: driver.email,
          subject: "New delivery assigned",
          text: `You've been assigned a new delivery (order ${delivery.orderId}). Open the driver app to see pickup/dropoff details.`,
          html: `<p>You've been assigned a new delivery (order ${delivery.orderId}). Open the driver app to see pickup/dropoff details.</p>`,
        });
      } catch { /* best-effort */ }
      return { assigned: true, deliveryId: delivery.id, driverId: driver.id, driverPhone: driver.phone };
    }),
});
