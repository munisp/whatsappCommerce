/**
 * waSender — unit tests
 * Tenant credential resolution, env fallback, chunking, and Graph API delivery.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("./db", () => ({
  getDb: vi.fn(),
}));

import { getDb } from "./db";
import {
  resolveTenantWaCredentials,
  sendWhatsAppText,
  chunkWhatsAppText,
  normalizeWaPhone,
  WA_TEXT_LIMIT,
} from "./services/waSender";

function mockDbWithTenant(tenantRow: unknown | null) {
  const limit = vi.fn().mockResolvedValue(tenantRow ? [tenantRow] : []);
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  const values = vi.fn().mockResolvedValue([]);
  const insert = vi.fn(() => ({ values }));
  (getDb as any).mockResolvedValue({ select, insert });
  return { select, insert, values };
}

describe("resolveTenantWaCredentials", () => {
  beforeEach(() => {
    vi.stubEnv("WAC_WHATSAPP_TOKEN", "");
    vi.stubEnv("WAC_WHATSAPP_PHONE_ID", "");
    vi.stubEnv("WHATSAPP_TOKEN", "");
    vi.stubEnv("WHATSAPP_PHONE_NUMBER_ID", "");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("resolves tenant phone_number_id + settings.whatsapp.accessToken", async () => {
    mockDbWithTenant({
      phoneNumberId: "tenant-phone-123",
      settings: { whatsapp: { accessToken: "tenant-secret-token" } },
    });
    const creds = await resolveTenantWaCredentials("tenant-1");
    expect(creds).toEqual({
      phoneNumberId: "tenant-phone-123",
      accessToken: "tenant-secret-token",
      source: "tenant",
    });
  });

  it("falls back to global env credentials when tenant has none", async () => {
    mockDbWithTenant({ phoneNumberId: null, settings: {} });
    vi.stubEnv("WAC_WHATSAPP_TOKEN", "env-token");
    vi.stubEnv("WAC_WHATSAPP_PHONE_ID", "env-phone");
    const creds = await resolveTenantWaCredentials("tenant-1");
    expect(creds).toEqual({ phoneNumberId: "env-phone", accessToken: "env-token", source: "env" });
  });

  it("falls back to env for the synthetic 'default' tenant", async () => {
    (getDb as any).mockResolvedValue(null);
    vi.stubEnv("WAC_WHATSAPP_TOKEN", "env-token");
    vi.stubEnv("WAC_WHATSAPP_PHONE_ID", "env-phone");
    const creds = await resolveTenantWaCredentials("default");
    expect(creds?.source).toBe("env");
  });

  it("returns null when nothing is configured", async () => {
    mockDbWithTenant(null);
    const creds = await resolveTenantWaCredentials("tenant-1");
    expect(creds).toBeNull();
  });
});

describe("chunkWhatsAppText", () => {
  it("returns a single chunk for short messages", () => {
    expect(chunkWhatsAppText("hello")).toEqual(["hello"]);
  });

  it("splits long messages into <=limit chunks, preferring newlines", () => {
    const line = "x".repeat(100);
    const body = Array.from({ length: 100 }, () => line).join("\n"); // ~10099 chars
    const chunks = chunkWhatsAppText(body);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(WA_TEXT_LIMIT);
    expect(chunks.join("\n").replace(/\n+/g, "\n")).toContain(line);
  });

  it("hard-splits pathological unbroken strings", () => {
    const body = "y".repeat(WA_TEXT_LIMIT * 2 + 10);
    const chunks = chunkWhatsAppText(body);
    expect(chunks.length).toBe(3);
    expect(chunks.join("")).toBe(body);
  });
});

describe("sendWhatsAppText", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("simulates (and does not throw) when no credentials exist", async () => {
    vi.stubEnv("WAC_WHATSAPP_TOKEN", "");
    vi.stubEnv("WAC_WHATSAPP_PHONE_ID", "");
    mockDbWithTenant(null);
    const result = await sendWhatsAppText("tenant-1", "+2348012345678", "hi there");
    expect(result.sent).toBe(false);
    expect(result.simulated).toBe(true);
  });

  it("sends via the tenant phone_number_id with the tenant token", async () => {
    mockDbWithTenant({
      phoneNumberId: "tenant-phone-123",
      settings: { whatsapp: { accessToken: "tenant-secret-token" } },
    });
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ messages: [{ id: "wamid.1" }] }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await sendWhatsAppText("tenant-1", "+234 801 234 5678", "Your order is confirmed");
    expect(result.sent).toBe(true);
    expect(result.wamids).toEqual(["wamid.1"]);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://graph.facebook.com/v21.0/tenant-phone-123/messages");
    expect(opts.headers.Authorization).toBe("Bearer tenant-secret-token");
    const payload = JSON.parse(opts.body);
    expect(payload.to).toBe("2348012345678");
    expect(payload.text.body).toBe("Your order is confirmed");
  });

  it("chunks messages longer than 4000 chars into sequential sends", async () => {
    mockDbWithTenant(null);
    vi.stubEnv("WAC_WHATSAPP_TOKEN", "env-token");
    vi.stubEnv("WAC_WHATSAPP_PHONE_ID", "env-phone");
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ messages: [{ id: "wamid.x" }] }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const body = "z".repeat(WA_TEXT_LIMIT + 50);
    const result = await sendWhatsAppText("tenant-1", "2348012345678", body);
    expect(result.sent).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const first = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(first.text.body.length).toBeLessThanOrEqual(WA_TEXT_LIMIT);
  });

  it("throws on a non-200 Graph API response", async () => {
    mockDbWithTenant(null);
    vi.stubEnv("WAC_WHATSAPP_TOKEN", "env-token");
    vi.stubEnv("WAC_WHATSAPP_PHONE_ID", "env-phone");
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => "Invalid OAuth access token",
    });
    vi.stubGlobal("fetch", mockFetch);

    await expect(sendWhatsAppText("tenant-1", "2348012345678", "hi")).rejects.toThrow(/401/);
  });
});

describe("normalizeWaPhone", () => {
  it("strips + and separators", () => {
    expect(normalizeWaPhone("+234 801-234-5678")).toBe("2348012345678");
  });
});
