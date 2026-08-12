import { z } from "zod";
import { router, protectedProcedure, adminProcedure, assertTenantAccess } from "../_core/trpc";
import { publicProcedure } from "../_core/trpc";
import { TRPCError } from "@trpc/server";
import { getDb } from "../db";
import { paymentGatewayConfigs, tenants, tenantSsoProfiles, users } from "../../drizzle/schema";
import { eq, and, sql, desc } from "drizzle-orm";
import { randomUUID } from "crypto";
import jwt from "jsonwebtoken";
import { ENV } from "../_core/env";
import { decryptSecret, encryptSecret } from "../services/crypto/secrets";

// Keycloak integration router — stores realm/client config and tests connectivity
// We store Keycloak config in paymentGatewayConfigs using provider = "keycloak"
// and serialize the realm/client settings into the secretKey field as JSON.
export const keycloakRouter = router({
  // Save Keycloak configuration
  saveConfig: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      serverUrl: z.string().url("Must be a valid URL, e.g. https://auth.example.com"),
      realm: z.string().min(1),
      clientId: z.string().min(1),
      clientSecret: z.string().optional(),
      adminUsername: z.string().optional(),
      adminPassword: z.string().optional(),
      enableSso: z.boolean().default(true),
    }))
    .mutation(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) throw new Error("Database unavailable");
      const configJson = JSON.stringify({
        serverUrl: input.serverUrl,
        realm: input.realm,
        clientId: input.clientId,
        adminUsername: input.adminUsername,
        adminPassword: input.adminPassword,
        enableSso: input.enableSso,
      });
      // The keycloak:: JSON blob contains admin credentials and the
      // clientSecret — both are secrets, encrypt at rest (v1: envelope).
      // Reads decrypt via decryptSecret before the keycloak:: prefix check;
      // legacy plaintext rows pass through unchanged.
      // Upsert is select-then-insert/update: NO unique constraint exists on
      // (tenantId, provider), so onConflictDoUpdate would throw 42P10 on
      // every call (same bug class as the w11 registry upsert).
      const [existing] = await db
        .select({ id: paymentGatewayConfigs.id })
        .from(paymentGatewayConfigs)
        .where(and(eq(paymentGatewayConfigs.tenantId, input.tenantId), eq(paymentGatewayConfigs.provider, "manual")))
        .limit(1);
      const secretKey = encryptSecret(`keycloak::${configJson}`);
      const webhookSecret = input.clientSecret ? encryptSecret(input.clientSecret) : input.clientSecret;
      if (existing) {
        await db
          .update(paymentGatewayConfigs)
          .set({ secretKey, webhookSecret, isActive: true, updatedAt: new Date() })
          .where(eq(paymentGatewayConfigs.id, existing.id));
      } else {
        await db.insert(paymentGatewayConfigs).values({
          id: randomUUID(),
          tenantId: input.tenantId,
          provider: "manual",  // store under "manual" slot with keycloak marker in secretKey
          secretKey,
          webhookSecret,
          isActive: true,
        });
      }
      return { ok: true };
    }),

  // Get Keycloak configuration for a tenant
  getConfig: protectedProcedure
    .input(z.object({ tenantId: z.string() }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) return null;
      const rows = await db
        .select()
        .from(paymentGatewayConfigs)
        .where(and(eq(paymentGatewayConfigs.tenantId, input.tenantId), eq(paymentGatewayConfigs.provider, "manual")))
        .limit(1);
      if (!rows[0]) return null;
      const raw = rows[0].secretKey ? decryptSecret(rows[0].secretKey) : "";
      if (!raw.startsWith("keycloak::")) return null;
      const cfg = JSON.parse(raw.slice("keycloak::".length)) as Record<string, unknown>;
      return {
        serverUrl: cfg.serverUrl as string,
        realm: cfg.realm as string,
        clientId: cfg.clientId as string,
        enableSso: cfg.enableSso as boolean,
        hasClientSecret: !!(cfg.clientSecret),
        hasAdminCredentials: !!(cfg.adminUsername && cfg.adminPassword),
      };
    }),

  // Test Keycloak connectivity by calling the well-known OIDC endpoint
  testConnection: protectedProcedure
    .input(z.object({
      serverUrl: z.string().url(),
      realm: z.string().min(1),
      clientId: z.string().min(1),
      clientSecret: z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      const wellKnownUrl = `${input.serverUrl.replace(/\/$/, "")}/realms/${input.realm}/.well-known/openid-configuration`;
      try {
        const res = await fetch(wellKnownUrl, {
          method: "GET",
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) {
          return { success: false, status: `HTTP ${res.status} from Keycloak realm endpoint` };
        }
        const data = await res.json() as Record<string, unknown>;
        const issuer = data.issuer as string | undefined;
        if (!issuer) {
          return { success: false, status: "Response missing issuer — may not be a valid Keycloak realm" };
        }
        // If client secret provided, attempt client credentials token
        if (input.clientSecret) {
          const tokenUrl = data.token_endpoint as string;
          const tokenRes = await fetch(tokenUrl, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              grant_type: "client_credentials",
              client_id: input.clientId,
              client_secret: input.clientSecret,
            }),
            signal: AbortSignal.timeout(8000),
          });
          if (!tokenRes.ok) {
            const err = await tokenRes.json().catch(() => ({})) as Record<string, unknown>;
            return { success: false, status: `Client credentials failed: ${err.error_description ?? tokenRes.status}` };
          }
          return { success: true, status: `Realm reachable & client credentials valid. Issuer: ${issuer}` };
        }
        return { success: true, status: `Realm reachable. Issuer: ${issuer}` };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { success: false, status: `Connection error: ${msg}` };
      }
    }),

  // Build the Keycloak OIDC authorization URL for a tenant's realm
  getLoginUrl: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      redirectUri: z.string().url(),
      state: z.string().optional(),
    }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const db = await getDb();
      if (!db) throw new Error("Database unavailable");
      const rows = await db
        .select()
        .from(paymentGatewayConfigs)
        .where(and(eq(paymentGatewayConfigs.tenantId, input.tenantId), eq(paymentGatewayConfigs.provider, "manual")))
        .limit(1);
      if (!rows[0]) throw new Error("Keycloak not configured for this tenant");
      const raw = rows[0].secretKey ? decryptSecret(rows[0].secretKey) : "";
      if (!raw.startsWith("keycloak::")) throw new Error("Keycloak config not found");
      const cfg = JSON.parse(raw.slice("keycloak::".length)) as Record<string, unknown>;
      if (!cfg.enableSso) throw new Error("SSO is disabled for this tenant");
      const serverUrl = (cfg.serverUrl as string).replace(/\/$/, "");
      const realm = cfg.realm as string;
      const clientId = cfg.clientId as string;
      const params = new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: input.redirectUri,
        scope: "openid email profile",
        ...(input.state ? { state: input.state } : {}),
      });
      const authUrl = `${serverUrl}/realms/${realm}/protocol/openid-connect/auth?${params.toString()}`;
      return { authUrl, realm, clientId };
    }),

  // Exchange OIDC authorization code for tokens and create a portal session
  exchangeCode: publicProcedure
    .input(
      z.object({
        tenantId: z.string(),
        code: z.string(),
        redirectUri: z.string().url(),
        state: z.string().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database unavailable");

      // Load Keycloak config for this tenant
      const rows = await db
        .select()
        .from(paymentGatewayConfigs)
        .where(
          and(
            eq(paymentGatewayConfigs.tenantId, input.tenantId),
            eq(paymentGatewayConfigs.provider, "manual")
          )
        )
        .limit(1);
      if (!rows[0]) throw new Error("Keycloak not configured for this tenant");
      const raw = rows[0].secretKey ? decryptSecret(rows[0].secretKey) : "";
      if (!raw.startsWith("keycloak::")) throw new Error("Keycloak config not found");
      const cfg = JSON.parse(raw.slice("keycloak::".length)) as Record<string, unknown>;
      if (!cfg.enableSso) throw new Error("SSO is disabled for this tenant");

      const serverUrl = (cfg.serverUrl as string).replace(/\/$/, "");
      const realm = cfg.realm as string;
      const clientId = cfg.clientId as string;
      const clientSecret = rows[0].webhookSecret ? decryptSecret(rows[0].webhookSecret) : undefined;

      // Exchange code for tokens at the Keycloak token endpoint
      const tokenEndpoint = `${serverUrl}/realms/${realm}/protocol/openid-connect/token`;
      const body = new URLSearchParams({
        grant_type: "authorization_code",
        code: input.code,
        redirect_uri: input.redirectUri,
        client_id: clientId,
        ...(clientSecret ? { client_secret: clientSecret } : {}),
      });

      const tokenRes = await fetch(tokenEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
        signal: AbortSignal.timeout(10_000),
      });

      if (!tokenRes.ok) {
        const err = await tokenRes.json().catch(() => ({})) as Record<string, unknown>;
        throw new Error(
          `Token exchange failed: ${err.error_description ?? err.error ?? tokenRes.status}`
        );
      }

      const tokens = await tokenRes.json() as {
        access_token: string;
        id_token?: string;
        refresh_token?: string;
        expires_in: number;
      };

      // Decode the ID token to extract user info (no sig verification needed —
      // we received it directly from Keycloak over HTTPS)
      let userInfo: {
        sub?: string;
        email?: string;
        name?: string;
        preferred_username?: string;
        realm_access?: { roles?: string[] };
        resource_access?: Record<string, { roles?: string[] }>;
      } = {};
      if (tokens.id_token) {
        try {
          const payload = tokens.id_token.split(".")[1];
          userInfo = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
        } catch { /* non-fatal */ }
      }
      // ── Role mapping: Keycloak realm roles → portal role ─────────────────
      // Priority: realm_access.roles > resource_access[clientId].roles
      // Mapping: "admin" | "manager" → "admin", anything else → "agent"
      const ADMIN_ROLES = new Set(["admin", "manager", "portal-admin", "portal-manager"]);
      const keycloakRoles: string[] = [
        ...(userInfo.realm_access?.roles ?? []),
        ...(userInfo.resource_access?.[clientId]?.roles ?? []),
      ];
      const portalRole: "admin" | "agent" = keycloakRoles.some((r) => ADMIN_ROLES.has(r))
        ? "admin"
        : "agent";

      // ── Identity ↔ tenant binding (fail closed) ──────────────────────────
      // A Keycloak token alone must never mint a portal session for an
      // arbitrary input.tenantId. The realm identity (sub) is only accepted
      // for this tenant when:
      //   1. an SSO profile already binds this sub to this tenant, OR
      //   2. first-bind: the tenant has SSO configured (checked above) AND
      //      the realm user's email matches a registered user (tenant
      //      owner/staff) of THIS tenant — i.e. someone explicitly invited
      //      into the tenant account.
      // Anything else is a cross-tenant session forgery attempt → 403.
      const ssoSub = userInfo.sub ?? null;
      const ssoEmail = userInfo.email?.toLowerCase() ?? null;

      const [existingProfile] = await db
        .select()
        .from(tenantSsoProfiles)
        .where(eq(tenantSsoProfiles.tenantId, input.tenantId))
        .limit(1);

      const profileBoundToThisIdentity =
        !!existingProfile && !!ssoSub && existingProfile.ssoSub === ssoSub;

      // ── First-bind rebind lock (W12.1) ───────────────────────────────────
      // Once a tenantSsoProfiles row exists, the tenant's SSO identity is
      // BOUND. A different Keycloak sub must NOT be able to take the binding
      // over via the email-match first-bind path below (a stale/compromised
      // mailbox match would silently transfer the tenant's SSO identity).
      // The only way to rebind is an explicit platform-admin action:
      // keycloak.rebindSsoProfile (adminProcedure).
      if (existingProfile && !profileBoundToThisIdentity) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message:
            "SSO identity for this tenant is already bound to a different Keycloak subject. " +
            "A platform admin must explicitly rebind it (keycloak.rebindSsoProfile).",
        });
      }

      if (!profileBoundToThisIdentity) {
        if (!ssoEmail) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message:
              "SSO identity is not bound to this tenant and the token carries no email to verify against tenant membership",
          });
        }
        // First-bind path: email must match a user registered under this
        // tenant (owner/admin first, then any staff member).
        const tenantUsers = await db
          .select({ email: users.email, role: users.role })
          .from(users)
          .where(eq(users.tenantId, input.tenantId));
        const emailMatch = tenantUsers.some(
          (u) => u.email && u.email.toLowerCase() === ssoEmail,
        );
        if (!emailMatch) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message:
              "SSO identity does not match any account registered for this tenant",
          });
        }
      }

      // Load tenant name for the session
      const [tenant] = await db
        .select({ name: tenants.name })
        .from(tenants)
        .where(eq(tenants.id, input.tenantId));

      // Build a portal session token (same format as magic link sessions)
      const sessionPayload = {
        tenantId: input.tenantId,
        tenantName: tenant?.name ?? input.tenantId,
        sub: userInfo.sub ?? `keycloak::${input.tenantId}`,
        email: userInfo.email,
        name: userInfo.name ?? userInfo.preferred_username,
        loginMethod: "keycloak_sso",
        // Resolved portal role from Keycloak realm/resource roles
        role: portalRole,
        keycloakRoles,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 24 * 3600,
      };

      const sessionToken = jwt.sign(sessionPayload, ENV.jwtSecret);

      // ── Upsert SSO profile for the tenant ────────────────────────────────
      // Provisions the tenant's SSO identity on first login; keeps email/name
      // and lastSsoLoginAt fresh on every subsequent login.
      await db
        .insert(tenantSsoProfiles)
        .values({
          tenantId: input.tenantId,
          ssoSub: userInfo.sub ?? null,
          ssoEmail: userInfo.email ?? null,
          ssoName: userInfo.name ?? userInfo.preferred_username ?? null,
          ssoProvider: "keycloak",
          portalRole,
          ssoLoginCount: 1,
          firstSsoLoginAt: new Date(),
          lastSsoLoginAt: new Date(),
        })
        .onConflictDoUpdate({
          target: tenantSsoProfiles.tenantId,
          set: {
            ssoSub: userInfo.sub ?? null,
            ssoEmail: userInfo.email ?? null,
            ssoName: userInfo.name ?? userInfo.preferred_username ?? null,
            ssoProvider: "keycloak",
            portalRole,
            ssoLoginCount: sql`${tenantSsoProfiles.ssoLoginCount} + 1`,
            lastSsoLoginAt: new Date(),
          },
        })
        .catch((e: unknown) => console.warn("[keycloak] sso profile upsert failed:", e));


      return {
        sessionToken,
        tenantId: input.tenantId,
        tenantName: tenant?.name ?? input.tenantId,
        userEmail: userInfo.email,
        userName: userInfo.name ?? userInfo.preferred_username,
        portalRole,
        keycloakRoles,
      };
    }),

  // ── Platform admin: explicitly rebind a tenant's SSO identity ────────────
  // The ONLY escape from the first-bind rebind lock in exchangeCode. Use when
  // a tenant's Keycloak identity is rotated (realm migration, compromised
  // account). Rewrites ssoSub (+ optional email/name) on the existing profile;
  // login counters are preserved so the audit trail stays continuous.
  rebindSsoProfile: adminProcedure
    .input(
      z.object({
        tenantId: z.string(),
        ssoSub: z.string().min(1),
        ssoEmail: z.string().email().optional(),
        ssoName: z.string().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database unavailable");
      const [existing] = await db
        .select()
        .from(tenantSsoProfiles)
        .where(eq(tenantSsoProfiles.tenantId, input.tenantId))
        .limit(1);
      if (!existing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "No SSO profile exists for this tenant — nothing to rebind",
        });
      }
      await db
        .update(tenantSsoProfiles)
        .set({
          ssoSub: input.ssoSub,
          ...(input.ssoEmail !== undefined ? { ssoEmail: input.ssoEmail } : {}),
          ...(input.ssoName !== undefined ? { ssoName: input.ssoName } : {}),
        })
        .where(eq(tenantSsoProfiles.tenantId, input.tenantId));
      console.warn(
        `[keycloak] SSO REBIND by admin ${ctx.user.id}: tenant=${input.tenantId} ` +
          `oldSub=${existing.ssoSub} newSub=${input.ssoSub}`,
      );
      return { ok: true, previousSub: existing.ssoSub, ssoSub: input.ssoSub };
    }),

  // ── List all SSO-provisioned tenant profiles (admin view) ─────────────────
  listSsoProfiles: adminProcedure
    .input(
      z.object({
        search: z.string().optional(),
        limit: z.number().int().min(1).max(200).default(50),
        offset: z.number().int().min(0).default(0),
      })
    )
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database unavailable");
      // Join with tenants to get tenant name alongside SSO profile
      const rows = await db
        .select({
          tenantId: tenantSsoProfiles.tenantId,
          tenantName: tenants.name,
          ssoSub: tenantSsoProfiles.ssoSub,
          ssoEmail: tenantSsoProfiles.ssoEmail,
          ssoName: tenantSsoProfiles.ssoName,
          ssoProvider: tenantSsoProfiles.ssoProvider,
          ssoLoginCount: tenantSsoProfiles.ssoLoginCount,
          firstSsoLoginAt: tenantSsoProfiles.firstSsoLoginAt,
          lastSsoLoginAt: tenantSsoProfiles.lastSsoLoginAt,
        })
        .from(tenantSsoProfiles)
        .leftJoin(tenants, eq(tenants.id, tenantSsoProfiles.tenantId))
        .orderBy(desc(tenantSsoProfiles.lastSsoLoginAt))
        .limit(input.limit)
        .offset(input.offset);
      const filtered = input.search
        ? rows.filter(
            (r) =>
              r.ssoEmail?.toLowerCase().includes(input.search!.toLowerCase()) ||
              r.ssoName?.toLowerCase().includes(input.search!.toLowerCase()) ||
              r.tenantName?.toLowerCase().includes(input.search!.toLowerCase())
          )
        : rows;
      return { profiles: filtered, total: filtered.length };
    }),
});
