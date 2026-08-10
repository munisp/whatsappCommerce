/**
 * secretsWiring.test.ts — credential read/write path wiring for envelope
 * encryption of tenant secrets at rest (w10).
 *
 * Write paths must store the v1: envelope; read paths must decrypt v1:
 * transparently while passing legacy plaintext through unchanged. Covered:
 *   - waSender.resolveTenantWaCredentials (settings.whatsapp.accessToken)
 *   - integrations clients.resolveIntegrationConfig + inbound webhook secret
 *   - integrationSync twenty/odoo/medusa credential loaders
 *   - router write paths: integrations.setConfig, tenantConfig.setMetaCatalog,
 *     tenant.updateWhatsAppConfig, onboarding.updateStep(whatsapp),
 *     twenty.saveConfig, odoo.saveConfig, paymentGateway.configure,
 *     keycloak.saveConfig (+ getConfig round-trip)
 *   - integrations.adminReencryptSecrets sweep (counts + idempotency + ACL)
 *
 * DB is mocked in-memory; a deterministic test master key is injected via
 * SECRETS_MASTER_KEY.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import type { TrpcContext } from "./_core/context";
import {
  tenants,
  twentyIntegrations,
  odooIntegrations,
  tenantIntegrations,
  paymentGatewayConfigs,
} from "../drizzle/schema";

const TEST_KEY_B64 = Buffer.alloc(32, 11).toString("base64");

// ─── In-memory DB fake ───────────────────────────────────────────────────────

type Row = Record<string, any>;

const stores = new Map<unknown, Row[]>();
const updateLog: Array<{ table: unknown; set: Row }> = [];

function pick(r: Row, cols: Row | undefined): Row {
  if (!cols) return { ...r };
  const out: Row = {};
  for (const k of Object.keys(cols)) out[k] = r[k];
  return out;
}

function makeFakeDb() {
  return {
    select(cols?: Row) {
      return {
        from(table: unknown) {
          const getRows = () => (stores.get(table) ?? []).map((r) => pick(r, cols));
          const chain: any = {
            where: () => chain,
            orderBy: () => chain,
            limit: async (n?: number) => {
              const rows = getRows();
              return typeof n === "number" ? rows.slice(0, n) : rows;
            },
            then: (resolve: any, reject: any) => Promise.resolve(getRows()).then(resolve, reject),
          };
          return chain;
        },
      };
    },
    update(table: unknown) {
      return {
        set(vals: Row) {
          return {
            where: async () => {
              updateLog.push({ table, set: vals });
              // Single-row stores in this suite: apply so re-reads see writes.
              const rows = stores.get(table) ?? [];
              if (rows.length > 0) Object.assign(rows[0], vals);
              return [];
            },
          };
        },
      };
    },
    insert(table: unknown) {
      return {
        values(vals: Row) {
          (stores.get(table) ?? stores.set(table, []).get(table)!).push(vals);
          const p: any = Promise.resolve([]);
          p.onConflictDoUpdate = async () => [];
          p.onConflictDoNothing = async () => [];
          return p;
        },
      };
    },
  };
}

vi.mock("./db", () => ({
  getDb: vi.fn().mockImplementation(() => Promise.resolve(makeFakeDb())),
  getTenantById: vi.fn(),
  updateTenant: vi.fn(),
}));
vi.mock("./permify", () => ({ permifyCheck: vi.fn().mockResolvedValue(true) }));

import { getDb, getTenantById, updateTenant } from "./db";
import { encryptSecret, decryptSecret, isEncrypted } from "./services/crypto/secrets";

const { resolveTenantWaCredentials } = await import("./services/waSender");
const integrationSync = await import("./services/integrationSync");
const { resolveIntegrationConfig } = await import("./services/integrations/clients");
const { loadTenantIntegrationConfig } = await import("./services/integrations/inbound");
const { integrationsRouter } = await import("./routers/integrations");
const { tenantConfigRouter } = await import("./routers/tenantConfig");
const { tenantRouter } = await import("./routers/tenant");
const { onboardingRouter } = await import("./routers/onboarding");
const { twentyRouter } = await import("./routers/twenty");
const { odooRouter } = await import("./routers/odoo");
const { paymentGatewayRouter } = await import("./routers/paymentGateway");
const { keycloakRouter } = await import("./routers/keycloak");

beforeAll(() => vi.stubEnv("SECRETS_MASTER_KEY", TEST_KEY_B64));
afterAll(() => vi.unstubAllEnvs());

beforeEach(() => {
  stores.clear();
  updateLog.length = 0;
  (getDb as any).mockClear().mockImplementation(() => Promise.resolve(makeFakeDb()));
  (getTenantById as any).mockReset();
  (updateTenant as any).mockReset().mockResolvedValue(undefined);
});

// ─── Test context helpers ────────────────────────────────────────────────────

function makeUser(role: "admin" | "user", tenantId: string | null): NonNullable<TrpcContext["user"]> {
  return {
    id: role === "admin" ? 1 : 2,
    openId: `openid-${role}-${tenantId}`,
    email: `${role}@example.com`,
    name: `${role} user`,
    loginMethod: "keycloak",
    role,
    tenantId,
    phone: null,
    phoneVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
  } as NonNullable<TrpcContext["user"]>;
}

function makeCtx(user: NonNullable<TrpcContext["user"]> | null): TrpcContext {
  return {
    user,
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: () => {} } as unknown as TrpcContext["res"],
  };
}

const T = "tenant-1";
const adminCtx = () => makeCtx(makeUser("admin", T));
const tenantCtx = () => makeCtx(makeUser("user", T));

// ─── Read path: waSender ─────────────────────────────────────────────────────

describe("waSender.resolveTenantWaCredentials", () => {
  beforeEach(() => {
    vi.stubEnv("WAC_WHATSAPP_TOKEN", "");
    vi.stubEnv("WAC_WHATSAPP_PHONE_ID", "");
    vi.stubEnv("WHATSAPP_TOKEN", "");
    vi.stubEnv("WHATSAPP_PHONE_NUMBER_ID", "");
  });

  it("decrypts a v1:-encrypted settings.whatsapp.accessToken (test key via env)", async () => {
    stores.set(tenants, [
      { id: T, phoneNumberId: "phone-1", settings: { whatsapp: { accessToken: encryptSecret("wa-secret-token") } } },
    ]);
    const creds = await resolveTenantWaCredentials(T);
    expect(creds).toEqual({ phoneNumberId: "phone-1", accessToken: "wa-secret-token", source: "tenant" });
  });

  it("passes a legacy plaintext accessToken through unchanged", async () => {
    stores.set(tenants, [
      { id: T, phoneNumberId: "phone-1", settings: { whatsapp: { accessToken: "legacy-plain" } } },
    ]);
    const creds = await resolveTenantWaCredentials(T);
    expect(creds?.accessToken).toBe("legacy-plain");
  });
});

// ─── Read path: integrations clients / inbound / integrationSync ─────────────

describe("integrations credential resolution", () => {
  it("resolveIntegrationConfig decrypts v1: apiKey + webhookSecret", async () => {
    stores.set(tenants, [
      {
        id: T,
        settings: {
          integrations: {
            twenty: {
              url: "https://twenty.example.com/",
              enabled: true,
              apiKey: encryptSecret("twenty-api-key"),
              webhookSecret: encryptSecret("hook-secret"),
            },
          },
        },
      },
    ]);
    const db = makeFakeDb();
    const cfg = await resolveIntegrationConfig(db as any, T, "twenty");
    expect(cfg.apiKey).toBe("twenty-api-key");
    expect(cfg.webhookSecret).toBe("hook-secret");
    expect(cfg.url).toBe("https://twenty.example.com"); // trailing slash stripped
  });

  it("resolveIntegrationConfig passes legacy plaintext through", async () => {
    stores.set(tenants, [
      { id: T, settings: { integrations: { medusa: { url: "https://m.example.com", apiKey: "legacy-key" } } } },
    ]);
    const cfg = await resolveIntegrationConfig(makeFakeDb() as any, T, "medusa");
    expect(cfg.apiKey).toBe("legacy-key");
  });

  it("loadTenantIntegrationConfig decrypts the webhook signing secret", async () => {
    stores.set(tenants, [
      { id: T, settings: { integrations: { odoo: { url: "https://o.example.com", webhookSecret: encryptSecret("wh-s3cret") } } } },
    ]);
    const cfg = await loadTenantIntegrationConfig(makeFakeDb() as any, T, "odoo");
    expect(cfg?.webhookSecret).toBe("wh-s3cret");
  });

  it("getTwentyIntegrationConfig decrypts the stored apiKey", async () => {
    stores.set(twentyIntegrations, [
      { id: "row-1", tenantId: T, baseUrl: "https://t.example.com/", apiKey: encryptSecret("t-key"), workspaceId: null },
    ]);
    const cfg = await integrationSync.getTwentyIntegrationConfig(T);
    expect(cfg?.apiKey).toBe("t-key");
    expect(cfg?.baseUrl).toBe("https://t.example.com");
  });

  it("getOdooIntegrationConfig decrypts the stored apiKey", async () => {
    stores.set(odooIntegrations, [
      { id: "row-1", tenantId: T, baseUrl: "https://o.example.com/", database: "db", username: "u", apiKey: encryptSecret("o-key") },
    ]);
    const cfg = await integrationSync.getOdooIntegrationConfig(T);
    expect(cfg?.apiKey).toBe("o-key");
  });

  it("getMedusaIntegrationConfig decrypts the stored admin apiKey", async () => {
    stores.set(tenantIntegrations, [
      { id: "row-1", tenantId: T, integrationType: "medusa", baseUrl: "https://m.example.com/", apiKey: encryptSecret("m-admin-key"), apiSecret: "pub-key" },
    ]);
    const cfg = await integrationSync.getMedusaIntegrationConfig(T);
    expect(cfg?.adminApiKey).toBe("m-admin-key");
    expect(cfg?.publishableKey).toBe("pub-key"); // publishable key is not a secret
    expect(cfg?.source).toBe("db");
  });
});

// ─── Write paths: router mutations store v1: ─────────────────────────────────

describe("credential write paths store the v1: envelope", () => {
  it("integrations.setConfig encrypts apiKey + webhookSecret and masks real last-4", async () => {
    stores.set(tenants, [{ id: T, settings: {} }]);
    const caller = integrationsRouter.createCaller(tenantCtx());
    const res = await caller.setConfig({
      tenantId: T,
      system: "medusa",
      url: "https://m.example.com",
      apiKey: "mk-secret-1234",
      webhookSecret: "hook-secret-9",
      enabled: true,
    });
    const write = updateLog.find((u) => u.table === tenants);
    const stored = (write?.set.settings as any).integrations.medusa;
    expect(isEncrypted(stored.apiKey)).toBe(true);
    expect(isEncrypted(stored.webhookSecret)).toBe(true);
    expect(decryptSecret(stored.apiKey)).toBe("mk-secret-1234");
    expect(decryptSecret(stored.webhookSecret)).toBe("hook-secret-9");
    // Masked response hints at the real secret, not ciphertext.
    expect(res.config.apiKey).toBe("****1234");
  });

  it("integrations.setConfig preserves an existing encrypted key when not rotated", async () => {
    const existingKey = encryptSecret("existing-key");
    stores.set(tenants, [{ id: T, settings: { integrations: { twenty: { url: "https://t.example.com", apiKey: existingKey } } } }]);
    const caller = integrationsRouter.createCaller(tenantCtx());
    await caller.setConfig({ tenantId: T, system: "twenty", enabled: true });
    const write = updateLog.find((u) => u.table === tenants);
    expect((write?.set.settings as any).integrations.twenty.apiKey).toBe(existingKey);
  });

  it("tenantConfig.setMetaCatalog encrypts the catalog access token", async () => {
    stores.set(tenants, [{ id: T, name: "T", settings: {} }]);
    const caller = tenantConfigRouter.createCaller(tenantCtx());
    await caller.setMetaCatalog({ tenantId: T, catalogId: "cat-1", accessToken: "meta-catalog-token", enabled: true });
    const write = updateLog.find((u) => u.table === tenants);
    const stored = (write?.set.settings as any).metaCatalog.accessToken;
    expect(isEncrypted(stored)).toBe(true);
    expect(decryptSecret(stored)).toBe("meta-catalog-token");
  });

  it("tenant.updateWhatsAppConfig encrypts the WhatsApp access token", async () => {
    (getTenantById as any).mockResolvedValue({ id: T, settings: {} });
    const caller = tenantRouter.createCaller(adminCtx());
    await caller.updateWhatsAppConfig({
      tenantId: T,
      phoneNumberId: "pn-1",
      wabaId: "waba-1",
      accessToken: "wa-permanent-token",
      verifyToken: "verify-1",
    });
    const [, data] = (updateTenant as any).mock.calls[0];
    const stored = data.settings.whatsapp.accessToken;
    expect(isEncrypted(stored)).toBe(true);
    expect(decryptSecret(stored)).toBe("wa-permanent-token");
  });

  it("onboarding.updateStep(whatsapp) encrypts the access token", async () => {
    stores.set(tenants, [{ id: T, settings: {} }]);
    const caller = onboardingRouter.createCaller(tenantCtx());
    await caller.updateStep({
      tenantId: T,
      step: "whatsapp",
      data: { phoneNumberId: "pn-9", accessToken: "onboarding-wa-token" },
    });
    const write = updateLog.find((u) => u.table === tenants && (u.set as any).settings?.whatsapp);
    const stored = (write?.set.settings as any).whatsapp.accessToken;
    expect(isEncrypted(stored)).toBe(true);
    expect(decryptSecret(stored)).toBe("onboarding-wa-token");
  });

  it("twenty.saveConfig encrypts the API key", async () => {
    stores.set(twentyIntegrations, []);
    const caller = twentyRouter.createCaller(tenantCtx());
    await caller.saveConfig({ baseUrl: "https://t.example.com", apiKey: "twenty-key-1" });
    const stored = (stores.get(twentyIntegrations) ?? [])[0]?.apiKey;
    expect(isEncrypted(stored)).toBe(true);
    expect(decryptSecret(stored)).toBe("twenty-key-1");
  });

  it("odoo.saveConfig encrypts the API key", async () => {
    stores.set(odooIntegrations, []);
    const caller = odooRouter.createCaller(tenantCtx());
    await caller.saveConfig({
      baseUrl: "https://o.example.com",
      database: "db",
      username: "u",
      apiKey: "odoo-key-1",
    });
    const stored = (stores.get(odooIntegrations) ?? [])[0]?.apiKey;
    expect(isEncrypted(stored)).toBe(true);
    expect(decryptSecret(stored)).toBe("odoo-key-1");
  });

  it("paymentGateway.configure encrypts secretKey + webhookSecret", async () => {
    stores.set(paymentGatewayConfigs, []);
    const caller = paymentGatewayRouter.createCaller(tenantCtx());
    await caller.configure({
      tenantId: T,
      provider: "paystack",
      secretKey: "sk_live_123",
      webhookSecret: "whsec_abc",
      isActive: true,
    });
    const row = (stores.get(paymentGatewayConfigs) ?? [])[0];
    expect(isEncrypted(row.secretKey)).toBe(true);
    expect(isEncrypted(row.webhookSecret)).toBe(true);
    expect(decryptSecret(row.secretKey)).toBe("sk_live_123");
    expect(decryptSecret(row.webhookSecret)).toBe("whsec_abc");
  });

  it("keycloak.saveConfig encrypts the config blob and client secret; getConfig round-trips", async () => {
    stores.set(paymentGatewayConfigs, []);
    const caller = keycloakRouter.createCaller(tenantCtx());
    await caller.saveConfig({
      tenantId: T,
      serverUrl: "https://kc.example.com",
      realm: "wacommerce",
      clientId: "portal",
      clientSecret: "kc-client-secret",
      enableSso: true,
    });
    const row = (stores.get(paymentGatewayConfigs) ?? [])[0];
    expect(isEncrypted(row.secretKey)).toBe(true);
    expect(decryptSecret(row.secretKey).startsWith("keycloak::")).toBe(true);
    expect(decryptSecret(row.webhookSecret)).toBe("kc-client-secret");
    const cfg = await caller.getConfig({ tenantId: T });
    expect(cfg).toMatchObject({ serverUrl: "https://kc.example.com", realm: "wacommerce", clientId: "portal" });
  });
});

// ─── adminReencryptSecrets sweep ─────────────────────────────────────────────

describe("integrations.adminReencryptSecrets", () => {
  function seedPlaintextSecrets() {
    stores.set(tenants, [
      {
        id: T,
        settings: {
          whatsapp: { accessToken: "plain-wa" },
          metaCatalog: { accessToken: "plain-meta" },
          integrations: { medusa: { url: "https://m.example.com", apiKey: "plain-mk", webhookSecret: "plain-hook" } },
        },
      },
    ]);
    stores.set(twentyIntegrations, [{ id: "tw-1", tenantId: T, apiKey: "plain-twenty" }]);
    stores.set(odooIntegrations, [{ id: "od-1", tenantId: T, apiKey: "plain-odoo" }]);
    stores.set(tenantIntegrations, [{ id: "ti-1", tenantId: T, integrationType: "medusa", apiKey: "plain-medusa" }]);
    stores.set(paymentGatewayConfigs, [{ id: "pg-1", tenantId: T, secretKey: "plain-sk", webhookSecret: "plain-wh" }]);
  }

  it("re-encrypts every legacy plaintext secret and returns counts", async () => {
    seedPlaintextSecrets();
    const caller = integrationsRouter.createCaller(adminCtx());
    const res = await caller.adminReencryptSecrets();
    expect(res.ok).toBe(true);
    expect(res.reencrypted).toEqual({
      tenantWhatsappAccessTokens: 1,
      tenantMetaCatalogAccessTokens: 1,
      tenantIntegrationApiKeys: 1,
      tenantIntegrationWebhookSecrets: 1,
      twentyIntegrationApiKeys: 1,
      odooIntegrationApiKeys: 1,
      medusaIntegrationApiKeys: 1,
      paymentGatewaySecretKeys: 1,
      paymentGatewayWebhookSecrets: 1,
    });
    // Spot-check stored values decrypt to the originals.
    const t = (stores.get(tenants) ?? [])[0];
    expect(decryptSecret(t.settings.whatsapp.accessToken)).toBe("plain-wa");
    expect(decryptSecret(t.settings.metaCatalog.accessToken)).toBe("plain-meta");
    expect(decryptSecret(t.settings.integrations.medusa.apiKey)).toBe("plain-mk");
    expect(decryptSecret((stores.get(twentyIntegrations) ?? [])[0].apiKey)).toBe("plain-twenty");
    expect(decryptSecret((stores.get(odooIntegrations) ?? [])[0].apiKey)).toBe("plain-odoo");
    expect(decryptSecret((stores.get(tenantIntegrations) ?? [])[0].apiKey)).toBe("plain-medusa");
    expect(decryptSecret((stores.get(paymentGatewayConfigs) ?? [])[0].secretKey)).toBe("plain-sk");
  });

  it("is idempotent — a second sweep re-encrypts nothing", async () => {
    seedPlaintextSecrets();
    const caller = integrationsRouter.createCaller(adminCtx());
    await caller.adminReencryptSecrets();
    const second = await caller.adminReencryptSecrets();
    expect(Object.values(second.reencrypted).every((n) => n === 0)).toBe(true);
  });

  it("rejects non-admin callers", async () => {
    const caller = integrationsRouter.createCaller(tenantCtx());
    await expect(caller.adminReencryptSecrets()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
