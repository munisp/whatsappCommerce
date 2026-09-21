/**
 * QA follow-up: 4 routers fetched a tenant/caller-supplied URL — with a
 * stored credential attached, in twenty/labelStudio/viCorrections/keycloak's
 * exchangeCode — without the shared SSRF guard (server/services/ssrfGuard)
 * that medusa.ts/odoo.ts/escrow.ts/paymentGateway.ts already used for this
 * exact pattern. Proves the guard now actually rejects a private/internal
 * target BEFORE any credentialed fetch fires, for both the write-time
 * (saveConfig) and request-time (the fetch call sites) checks.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../db", () => ({ getDb: vi.fn() }));
vi.stubGlobal("fetch", vi.fn());

import { getDb } from "../../db";
import { twentyRouter } from "../twenty";
import { labelStudioRouter } from "../labelStudio";
import { keycloakRouter } from "../keycloak";

const TENANT = "tenant-1";
const USER = { user: { id: 1, role: "user", tenantId: TENANT, openId: "u1" } } as any;

function makeChain(rows: any = []) {
  const p = Promise.resolve(rows);
  const c: any = { then: (res: any, rej: any) => p.then(res, rej), catch: (rej: any) => p.catch(rej) };
  for (const m of ["from", "where", "limit", "orderBy", "set", "values"]) c[m] = () => c;
  return c;
}
function makeDb(rows: any = []) {
  return {
    select: vi.fn(() => makeChain(rows)),
    insert: vi.fn(() => ({ values: vi.fn(() => makeChain([])) })),
    update: vi.fn(() => makeChain([])),
  } as any;
}

const METADATA_URL = "http://169.254.169.254/latest/meta-data/";
const LOOPBACK_URL = "http://127.0.0.1:6379/";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fetch).mockReset();
});

describe("twenty.ts — SSRF guard on tenant-supplied baseUrl", () => {
  it("saveConfig rejects a cloud-metadata baseUrl before any DB write", async () => {
    vi.mocked(getDb).mockResolvedValue(makeDb());
    const caller = twentyRouter.createCaller(USER);
    await expect(
      caller.saveConfig({ baseUrl: METADATA_URL, apiKey: "k" } as any),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("configure rejects a loopback apiUrl before any DB write", async () => {
    vi.mocked(getDb).mockResolvedValue(makeDb());
    const caller = twentyRouter.createCaller(USER);
    await expect(
      caller.configure({ apiUrl: LOOPBACK_URL, apiKey: "k" } as any),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("labelStudio.ts — SSRF guard on tenant-supplied labelStudioUrl", () => {
  it("saveConfig rejects a cloud-metadata URL before any DB write", async () => {
    vi.mocked(getDb).mockResolvedValue(makeDb());
    const caller = labelStudioRouter.createCaller(USER);
    await expect(
      caller.saveConfig({ labelStudioUrl: METADATA_URL } as any),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("testConnection refuses to fetch a loopback URL even if it slipped into storage", async () => {
    vi.mocked(getDb).mockResolvedValue(makeDb([{ labelStudioUrl: LOOPBACK_URL, apiToken: "tok" }]));
    const caller = labelStudioRouter.createCaller(USER);
    const r = await caller.testConnection();
    expect(r.connected).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("keycloak.ts — SSRF guard on tenant-supplied Keycloak serverUrl", () => {
  it("saveConfig rejects a cloud-metadata serverUrl before any DB write", async () => {
    vi.mocked(getDb).mockResolvedValue(makeDb());
    const caller = keycloakRouter.createCaller(USER);
    await expect(
      caller.saveConfig({
        tenantId: TENANT, serverUrl: METADATA_URL, realm: "r", clientId: "c",
      } as any),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("testConnection refuses to fetch a loopback serverUrl (admin caller)", async () => {
    // NB: testConnection is built on operatorProcedure, which requires
    // tenantId in the RAW input — but its own .input() Zod schema never
    // declares a tenantId field, so no real non-admin caller can ever
    // satisfy tenantRoleProcedure's check (a separate, pre-existing bug,
    // logged in .qa/defects.md — unrelated to this SSRF fix). Using the
    // admin bypass here keeps this test scoped to the SSRF guard itself.
    const caller = keycloakRouter.createCaller({ user: { id: 1, role: "admin", tenantId: null } } as any);
    const r = await caller.testConnection({
      serverUrl: LOOPBACK_URL, realm: "r", clientId: "c",
    } as any);
    expect(r.success).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("exchangeCode (PUBLIC procedure) refuses to send the real clientSecret to a loopback serverUrl even if it slipped into storage", async () => {
    // Simulates a row saved before this fix existed — the request-time
    // re-check in exchangeCode must still catch it, since this procedure
    // has NO auth at all and sends a real decrypted secret.
    const encryptSecret = (await import("../../services/crypto/secrets")).encryptSecret;
    const configJson = JSON.stringify({
      serverUrl: LOOPBACK_URL, realm: "r", clientId: "c", enableSso: true,
    });
    vi.mocked(getDb).mockResolvedValue(makeDb([{
      secretKey: encryptSecret(`keycloak::${configJson}`),
      webhookSecret: encryptSecret("real-client-secret"),
    }]));
    const caller = keycloakRouter.createCaller({} as any); // publicProcedure — no user needed
    await expect(
      caller.exchangeCode({
        tenantId: TENANT, code: "abc", redirectUri: "https://app.example.com/cb",
      } as any),
    ).rejects.toThrow(/SSRF guard rejected/);
    expect(fetch).not.toHaveBeenCalled();
  });
});
