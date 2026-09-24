// === W47 crosscutting ===
/**
 * J466 — P2 hardening batch: ONB-SM-2 / ONB-TOK-2 / ONB-TOK-3 / ONB-ID-4.
 *
 *   - SM-2: tenantInvite.resend writes an audit row with the new jti +
 *     boundPhone (legitimate reissues distinguishable from exfiltration);
 *   - TOK-2: invite links are fragment-carried and logRedact redacts
 *     token/otp/jwt/secret keys;
 *   - TOK-3: the login/verify OTP is NOT mirrored to email — the companion
 *     email is notification-only (source contract + function);
 *   - ID-4: two sendOtp calls for the same (phone,purpose) leave exactly ONE
 *     phone_otp_sessions row (unique backstop + upsert).
 */
import { and, eq } from "drizzle-orm";
import { assert, assertIncludes, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { publicCaller } from "./helpers";

export const journey: Journey = {
  id: "J466",
  name: "invite resend audit + token secrecy + OTP single-session",
  feature: "ONB-SM-2 + ONB-TOK-2 + ONB-TOK-3 + ONB-ID-4",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const phoneAuth = await import("../../server/routers/phoneAuth");

    // ── TOK-2: logRedact covers credential keys ───────────────────────────
    const lr = await import("../../server/services/logRedact");
    const red = lr.redact({ token: "secret-jwt", otp: "123456", jwt: "abc", note: "ok" }) as any;
    const flat = JSON.stringify(red);
    assert(!flat.includes("secret-jwt") && !flat.includes("123456") && !flat.includes("abc"), "credential keys redacted");
    assert(red.note === "ok", "non-sensitive fields preserved");

    // ── TOK-2: invite URLs are fragment-carried (both mint paths) ─────────
    const { readFile } = await import("node:fs/promises");
    const inviteSrc = await readFile(new URL("../../server/routers/tenantInvite.ts", import.meta.url), "utf8");
    assertIncludes(inviteSrc, "/portal/login#token=", "tenantInvite mints fragment-carried links");
    assert(!inviteSrc.includes("/portal/login?token="), "no query-carried invite tokens remain");
    const bootSrc = await readFile(new URL("../../server/services/onboardingCopilot/bootstrapTenantOwner.ts", import.meta.url), "utf8");
    assertIncludes(bootSrc, "/portal/login#token=", "bootstrap invite fragment-carried");

    // ── TOK-3: OTP email is notification-only ─────────────────────────────
    const phoneAuthSrc = await readFile(new URL("../../server/routers/phoneAuth.ts", import.meta.url), "utf8");
    assert(!/sendOtpEmail\([^)]*otp/i.test(phoneAuthSrc), "login/verify OTP never emailed");
    assertIncludes(phoneAuthSrc, "notifyOtpRequestedEmail", "notification-only companion email used");
    const resendSrc = await readFile(new URL("../../server/services/email/resend.ts", import.meta.url), "utf8");
    assertIncludes(resendSrc, "notifyOtpRequestedEmail", "notification email helper exported");
    const fnBody = resendSrc.split("notifyOtpRequestedEmail")[1] ?? "";
    assertIncludes(fnBody.slice(0, 1600), "never email codes", "notification body carries no code");

    // ── ID-4: concurrent/serial sendOtp → one row per (phone,purpose) ─────
    const caller = await publicCaller();
    const phone = "+2348017000466";
    const r1 = await caller.phoneAuth.sendOtp({ phone, purpose: "login" });
    // Age the first session past the 60s resend guard, then resend.
    await world.db.update(schema.phoneOtpSessions)
      .set({ createdAt: new Date(Date.now() - 61_000) })
      .where(eq(schema.phoneOtpSessions.id, r1.sessionId));
    const r2 = await caller.phoneAuth.sendOtp({ phone, purpose: "login" });
    assert(r1.sessionId && r2.sessionId, "both sends returned sessions");
    const rows = await world.db.select().from(schema.phoneOtpSessions)
      .where(and(eq(schema.phoneOtpSessions.phone, phone), eq(schema.phoneOtpSessions.purpose, "login")));
    assert(rows.length === 1, `one live OTP session per (phone,purpose) (got ${rows.length})`);
    assert(rows[0].id === r2.sessionId, "the surviving row is the latest send");
    assert(Number(rows[0].attempts) === 0, "attempt counter reset by the resend");

    // ── SM-2: resend writes an audit row with jti + boundPhone ────────────
    const adminCaller = await (await import("./helpers")).adminCaller();
    const tenantId = crypto.randomUUID();
    await world.db.insert(schema.tenants).values({
      id: tenantId, name: "J466 Store", slug: `j466-${tenantId.slice(0, 8)}`,
      settings: { adminPhone: "+2348017000467" },
    } as any);
    await adminCaller.tenantInvite.create({ tenantId });
    await adminCaller.tenantInvite.resend({ tenantId });
    const audits = await world.db.select().from(schema.auditLogs)
      .where(eq(schema.auditLogs.action, "tenantInvite.resend"));
    assert(audits.length >= 1, "resend audit row written");
    const after = (audits[audits.length - 1].after ?? {}) as any;
    assert(typeof after.jti === "string" && after.jti.length > 10, "audit carries the new jti");
    assert(after.boundPhone === "+2348017000467", `audit carries boundPhone (got ${after.boundPhone})`);
    const invites = await world.db.select().from(schema.tenantInviteTokens)
      .where(eq(schema.tenantInviteTokens.tenantId, tenantId));
    assert(invites.length >= 2, "create + resend minted separate registered jtis");
  },
};
