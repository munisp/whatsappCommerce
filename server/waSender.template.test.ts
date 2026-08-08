/**
 * waSender.sendWhatsAppTemplate — unit tests.
 * Verifies per-tenant credential resolution, Graph v21.0 template payload,
 * env fallback, simulation mode, and throw-on-non-200 behaviour.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./db", () => ({
  getDb: vi.fn(),
}));

import { getDb } from "./db";
import { sendWhatsAppTemplate } from "./services/waSender";

/** Chainable mock db: select→from→where→limit resolves tenant rows; insert logs. */
function mockDbWithTenant(tenantRow: any) {
  const insertValues = vi.fn().mockResolvedValue(undefined);
  const db: any = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(tenantRow ? [tenantRow] : []),
    insert: vi.fn().mockReturnValue({ values: insertValues }),
  };
  return { db, insertValues };
}

const TENANT_ROW = {
  phoneNumberId: "tenant-phone-id-123",
  settings: { whatsapp: { accessToken: "tenant-secret-token" } },
};

describe("sendWhatsAppTemplate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("WAC_WHATSAPP_TOKEN", "");
    vi.stubEnv("WAC_WHATSAPP_PHONE_ID", "");
    vi.stubEnv("WHATSAPP_TOKEN", "");
    vi.stubEnv("WHATSAPP_PHONE_NUMBER_ID", "");
  });

  it("sends via tenant credentials (tenant phone-number-id + token), not env", async () => {
    // Env creds are set too — tenant creds must win.
    vi.stubEnv("WAC_WHATSAPP_TOKEN", "env-token");
    vi.stubEnv("WAC_WHATSAPP_PHONE_ID", "env-phone-id");

    const { db } = mockDbWithTenant(TENANT_ROW);
    vi.mocked(getDb).mockResolvedValue(db);

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ messages: [{ id: "wamid.tenant" }] }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await sendWhatsAppTemplate(
      "tenant-1",
      "+2348012345678",
      "wac_order_confirmation",
      "en_US",
      [{ type: "body", parameters: [{ type: "text", text: "Amara" }] }],
    );

    expect(result).toEqual({ sent: true, simulated: false, wamid: "wamid.tenant" });
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://graph.facebook.com/v21.0/tenant-phone-id-123/messages");
    expect(opts.headers.Authorization).toBe("Bearer tenant-secret-token");
    const body = JSON.parse(opts.body);
    expect(body.type).toBe("template");
    expect(body.to).toBe("2348012345678"); // digits-only normalization
    expect(body.template.name).toBe("wac_order_confirmation");
    expect(body.template.language.code).toBe("en_US");
    expect(body.template.components[0].parameters[0].text).toBe("Amara");
  });

  it("falls back to env credentials when tenant has none", async () => {
    vi.stubEnv("WAC_WHATSAPP_TOKEN", "env-token");
    vi.stubEnv("WAC_WHATSAPP_PHONE_ID", "env-phone-id");

    const { db } = mockDbWithTenant(null); // no tenant row
    vi.mocked(getDb).mockResolvedValue(db);

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ messages: [{ id: "wamid.env" }] }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await sendWhatsAppTemplate("tenant-1", "2348012345678", "tpl", "en_US", []);
    expect(result.sent).toBe(true);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain("env-phone-id/messages");
    expect(opts.headers.Authorization).toBe("Bearer env-token");
  });

  it("simulates (no fetch, no throw) when no credentials are configured", async () => {
    const { db, insertValues } = mockDbWithTenant(null);
    vi.mocked(getDb).mockResolvedValue(db);
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    const result = await sendWhatsAppTemplate("tenant-1", "2348012345678", "tpl", "en_US");
    expect(result).toEqual({ sent: false, simulated: true, wamid: null });
    expect(mockFetch).not.toHaveBeenCalled();
    // simulated send is still logged
    expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({ status: "simulated", templateName: "tpl" }));
  });

  it("throws on non-200 Graph API response (after logging the failure)", async () => {
    const { db, insertValues } = mockDbWithTenant(TENANT_ROW);
    vi.mocked(getDb).mockResolvedValue(db);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => '{"error":{"message":"template not found"}}',
    }));

    await expect(
      sendWhatsAppTemplate("tenant-1", "2348012345678", "missing_tpl", "en_US"),
    ).rejects.toThrow(/400/);
    expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));
  });

  it("logs the template name on successful sends", async () => {
    const { db, insertValues } = mockDbWithTenant(TENANT_ROW);
    vi.mocked(getDb).mockResolvedValue(db);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ messages: [{ id: "wamid.x" }] }),
    }));

    await sendWhatsAppTemplate("tenant-1", "2348012345678", "wac_broadcast", "en_US", [], {
      notifType: "broadcast",
    });
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ status: "sent", templateName: "wac_broadcast", notifType: "broadcast", tenantId: "tenant-1" }),
    );
  });
});
