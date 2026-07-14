import { z } from "zod";
import { router, protectedProcedure } from "../_core/trpc";
import { publicProcedure } from "../_core/trpc";
import { getDb } from "../db";
import { paymentGatewayConfigs, tenants, tenantSsoProfiles } from "../../drizzle/schema";
import { eq, and, sql, desc } from "drizzle-orm";
import { randomUUID } from "crypto";
import jwt from "jsonwebtoken";
import { ENV } from "../_core/env";

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
    .mutation(async ({ input }) => {
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
      await db.insert(paymentGatewayConfigs).values({
        id: randomUUID(),
        tenantId: input.tenantId,
        provider: "manual",  // store under "manual" slot with keycloak marker in secretKey
        secretKey: `keycloak::${configJson}`,
        webhookSecret: input.clientSecret,
        isActive: true,
      }).onConflictDoUpdate({
        target: [paymentGatewayConfigs.tenantId, paymentGatewayConfigs.provider],
        set: {
          secretKey: `keycloak::${configJson}`,
          webhookSecret: input.clientSecret,
          isActive: true,
          updatedAt: new Date(),
        },
      });
      return { ok: true };
    }),

  // Get Keycloak configuration for a tenant
  getConfig: protectedProcedure
    .input(z.object({ tenantId: z.string() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return null;
      const rows = await db
        .select()
        .from(paymentGatewayConfigs)
        .where(and(eq(paymentGatewayConfigs.tenantId, input.tenantId), eq(paymentGatewayConfigs.provider, "manual")))
        .limit(1);
      if (!rows[0]) return null;
      const raw = rows[0].secretKey ?? "";
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
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database unavailable");
      const rows = await db
        .select()
        .from(paymentGatewayConfigs)
        .where(and(eq(paymentGatewayConfigs.tenantId, input.tenantId), eq(paymentGatewayConfigs.provider, "manual")))
        .limit(1);
      if (!rows[0]) throw new Error("Keycloak not configured for this tenant");
      const raw = rows[0].secretKey ?? "";
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
      const raw = rows[0].secretKey ?? "";
      if (!raw.startsWith("keycloak::")) throw new Error("Keycloak config not found");
      const cfg = JSON.parse(raw.slice("keycloak::".length)) as Record<string, unknown>;
      if (!cfg.enableSso) throw new Error("SSO is disabled for this tenant");

      const serverUrl = (cfg.serverUrl as string).replace(/\/$/, "");
      const realm = cfg.realm as string;
      const clientId = cfg.clientId as string;
      const clientSecret = rows[0].webhookSecret ?? undefined;

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

  // ── List all SSO-provisioned tenant profiles (admin view) ─────────────────
  listSsoProfiles: protectedProcedure
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
