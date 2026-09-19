// === W47 crosscutting ===
/**
 * bootstrapTenantOwner.ts — ONB-SM-1 / ONB-M-4: a chat-onboarded tenant must
 * have a real, accountable OWNER identity, not just a bare tenant row.
 *
 * Pre-W47 the copilot's ensureTenant() inserted a bare tenant: no users row,
 * no tenant_memberships row, no settings.adminPhone. Consequences: invite
 * minting degraded to unbound bearer links (tenantInvite.create found no
 * boundPhone), there was no governed recovery when the onboarding phone was
 * lost/SIM-swapped, and the "manage your portal" success copy sent merchants
 * to a portal they could not log into.
 *
 * bootstrapTenantOwner() is the single seam that fixes this; it is called by
 * the copilot go-live tool (tools.ts) and may be called by the merchant
 * go-live path (Coder A) — it is fully idempotent:
 *
 *   1. settings.adminPhone = the onboarding phone (verified by webhook
 *      delivery — the merchant demonstrably controls this number).
 *   2. Ensure a users row keyed to that phone (openId "wa-onb:<phone>",
 *      phoneVerified=true — webhook delivery is the proof of possession).
 *   3. Ensure an owner tenant_memberships row for that user.
 *   4. Auto-mint a phone-bound portal invite (tenant_invite_tokens row with
 *      boundPhone = adminPhone, registered jti, ≤24h, single-use) so the
 *      merchant's FIRST portal login goes through the governed TEN-19 path
 *      (link + OTP to the bound phone), and audit-log every step.
 *
 * Recovery: if the phone is lost, platform admin resets devices via
 * phoneAuth.adminResetDevices and re-mints a fresh invite to a re-verified
 * adminPhone (tenantInvite.resend) — the audit trail distinguishes both.
 */
import jwt from "jsonwebtoken";
import { randomUUID } from "crypto";
import { and, eq } from "drizzle-orm";
import { getDb } from "../../db";
import { tenants, tenantInviteTokens, tenantMemberships, users } from "../../../drizzle/schema";
import { ENV } from "../../_core/env";
import { writeAuditLog } from "../../routers/audit";
import { updateTenantSettings } from "../onboarding";
import { normalisePhone } from "../../routers/phoneAuth";

export const BOOTSTRAP_INVITE_EXPIRY_HOURS = 24;

export interface BootstrapTenantOwnerResult {
  tenantId: string;
  adminPhone: string;
  ownerUserId: number;
  /** True when the user row was created by this call (vs already existed). */
  userCreated: boolean;
  membershipId: string | null;
  /** Phone-bound portal invite for the merchant's first login. */
  inviteJti: string;
  inviteUrl: string;
  inviteExpiresAt: string;
}

/**
 * Idempotently ensure the chat-onboarded tenant has an owner identity and a
 * governed first-login path. Throws on DB unavailability; callers (goLive)
 * decide whether bootstrap failure blocks the live transition.
 */
export async function bootstrapTenantOwner(opts: {
  tenantId: string;
  /** Onboarding phone (E.164 or digits) — verified by webhook delivery. */
  phone: string;
  /** Audit attribution, e.g. "copilot:<sessionId>". */
  actorId?: string;
}): Promise<BootstrapTenantOwnerResult> {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const actorId = opts.actorId ?? "copilot:bootstrap";
  const adminPhone = normalisePhone(opts.phone);

  // 1. Record the verified admin phone on the tenant settings.
  await updateTenantSettings(opts.tenantId, (s) => {
    (s as Record<string, unknown>).adminPhone = adminPhone;
  });

  // 2. Ensure a users row keyed to the phone. Phone-first SMB owners rarely
  //    have an email; openId is namespaced so a later Keycloak link can
  //    re-key without collision.
  const openId = `wa-onb:${adminPhone}`;
  let [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.openId, openId))
    .limit(1);
  let userCreated = false;
  if (!user) {
    // A user may already exist with this phone (e.g. prior portal signup) —
    // adopt it rather than duplicate-keying on a future phone unique index.
    const [byPhone] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.phone, adminPhone))
      .limit(1);
    if (byPhone) {
      user = byPhone;
    } else {
      const [created] = await db
        .insert(users)
        .values({
          openId,
          name: null,
          phone: adminPhone,
          phoneVerified: true, // webhook delivery to this number is the proof
          loginMethod: "whatsapp_onboarding",
          role: "user",
          tenantId: opts.tenantId,
          lastSignedIn: new Date(),
        })
        .returning({ id: users.id });
      user = created;
      userCreated = true;
    }
  }
  if (!user) throw new Error("owner user provisioning failed");
  // Keep users.tenantId pointed at the tenant the owner just created
  // (tenantPortal.* resolves the tenant from this column).
  await db.update(users).set({ tenantId: opts.tenantId }).where(eq(users.id, user.id));

  // 3. Ensure the owner membership (unique (tenantId,userId) backstop makes
  //    this race-safe; first member is forced to 'owner' by convention — here
  //    we request it explicitly).
  const [existingMembership] = await db
    .select({ id: tenantMemberships.id })
    .from(tenantMemberships)
    .where(and(
      eq(tenantMemberships.tenantId, opts.tenantId),
      eq(tenantMemberships.userId, String(user.id)),
    ))
    .limit(1);
  let membershipId: string | null = existingMembership?.id ?? null;
  if (!membershipId) {
    const [m] = await db
      .insert(tenantMemberships)
      .values({
        tenantId: opts.tenantId,
        userId: String(user.id),
        role: "owner",
        invitedBy: String(user.id),
      })
      .returning({ id: tenantMemberships.id });
    membershipId = m?.id ?? null;
  }

  // 4. Auto-mint the phone-bound first-login invite (governed TEN-19 path:
  //    registered jti + boundPhone → validate() requires an OTP identity
  //    proof for THIS phone; single-use, ≤24h).
  const [tenant] = await db
    .select({ id: tenants.id, name: tenants.name })
    .from(tenants)
    .where(eq(tenants.id, opts.tenantId))
    .limit(1);
  const jti = randomUUID();
  const expiresAt = new Date(Date.now() + BOOTSTRAP_INVITE_EXPIRY_HOURS * 60 * 60 * 1000);
  const token = jwt.sign(
    {
      type: "portal_invite",
      jti,
      tenantId: opts.tenantId,
      tenantName: tenant?.name ?? "your store",
      issuedBy: `bootstrap:${user.id}`,
      boundPhone: adminPhone,
    },
    ENV.jwtSecret,
    { expiresIn: `${BOOTSTRAP_INVITE_EXPIRY_HOURS}h` },
  );
  await db.insert(tenantInviteTokens).values({
    jti,
    tenantId: opts.tenantId,
    issuedBy: `bootstrap:${user.id}`,
    expiresAt,
    boundPhone: adminPhone,
  });
  const inviteUrl = `${ENV.appUrl}/portal/login#token=${token}`;

  await writeAuditLog({
    actorId,
    actorRole: "system",
    action: "onboarding_copilot.owner_bootstrap",
    entityType: "tenant",
    entityId: opts.tenantId,
    tenantId: opts.tenantId,
    summary:
      `owner bootstrapped for chat-onboarded tenant ${opts.tenantId}: user ${user.id} ` +
      `(${userCreated ? "created" : "adopted"}), membership ${membershipId ?? "existing"}, ` +
      `phone-bound invite ${jti} minted to adminPhone`,
    after: {
      ownerUserId: user.id,
      userCreated,
      membershipId,
      adminPhone,
      inviteJti: jti,
      inviteExpiresAt: expiresAt.toISOString(),
    },
  });

  return {
    tenantId: opts.tenantId,
    adminPhone,
    ownerUserId: user.id,
    userCreated,
    membershipId,
    inviteJti: jti,
    inviteUrl,
    inviteExpiresAt: expiresAt.toISOString(),
  };
}
// === END W47 crosscutting ===
