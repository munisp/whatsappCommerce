import { z } from "zod";
import { router, protectedProcedure } from "../_core/trpc";
import { getDb } from "../db";
import { paymentGatewayConfigs } from "../../drizzle/schema";
import { eq, and } from "drizzle-orm";
import { randomUUID } from "crypto";

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
});
