/**
 * waSender rich messaging — unit tests
 * Interactive payload builders (button/list cap rules), media payload builder,
 * and the interactive/media senders over the same creds/logging/error path as
 * sendWhatsAppText.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("./db", () => ({
  getDb: vi.fn(),
}));

import { getDb } from "./db";
import {
  buildInteractivePayload,
  buildMediaPayload,
  sendWhatsAppInteractive,
  sendWhatsAppMedia,
  WA_BUTTONS_MAX,
  WA_BUTTON_TITLE_LIMIT,
  WA_LIST_ROWS_MAX,
  WA_LIST_ROW_TITLE_LIMIT,
} from "./services/waSender";

function mockDbWithTenant(tenantRow: unknown | null) {
  const limit = vi.fn().mockResolvedValue(tenantRow ? [tenantRow] : []);
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  const values = vi.fn().mockResolvedValue([]);
  const insert = vi.fn(() => ({ values }));
  (getDb as any).mockResolvedValue({ select, insert });
}

function stubEnvCreds() {
  vi.stubEnv("WAC_WHATSAPP_TOKEN", "env-token");
  vi.stubEnv("WAC_WHATSAPP_PHONE_ID", "env-phone");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("buildInteractivePayload — buttons", () => {
  it("builds a reply-button payload with header/body/footer", () => {
    const payload = buildInteractivePayload({
      headerText: "Ada Stores",
      bodyText: "What would you like to do?",
      footerText: "Tap a button",
      action: {
        type: "button",
        buttons: [
          { id: "menu_1", title: "Shop products" },
          { id: "menu_2", title: "Track my order" },
        ],
      },
    }) as any;
    expect(payload.type).toBe("button");
    expect(payload.header).toEqual({ type: "text", text: "Ada Stores" });
    expect(payload.body.text).toBe("What would you like to do?");
    expect(payload.footer.text).toBe("Tap a button");
    expect(payload.action.buttons).toEqual([
      { type: "reply", reply: { id: "menu_1", title: "Shop products" } },
      { type: "reply", reply: { id: "menu_2", title: "Track my order" } },
    ]);
  });

  it("accepts exactly 3 buttons and rejects a 4th", () => {
    const buttons = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ id: `b${i}`, title: `B${i}` }));
    expect(() =>
      buildInteractivePayload({ bodyText: "x", action: { type: "button", buttons: buttons(WA_BUTTONS_MAX) } }),
    ).not.toThrow();
    expect(() =>
      buildInteractivePayload({ bodyText: "x", action: { type: "button", buttons: buttons(WA_BUTTONS_MAX + 1) } }),
    ).toThrow(/at most 3 buttons/);
  });

  it("truncates over-long button titles to 20 chars", () => {
    const payload = buildInteractivePayload({
      bodyText: "x",
      action: { type: "button", buttons: [{ id: "b", title: "T".repeat(40) }] },
    }) as any;
    expect(payload.action.buttons[0].reply.title.length).toBeLessThanOrEqual(WA_BUTTON_TITLE_LIMIT);
  });

  it("rejects empty button lists and missing body", () => {
    expect(() => buildInteractivePayload({ bodyText: "x", action: { type: "button", buttons: [] } })).toThrow();
    expect(() =>
      buildInteractivePayload({ bodyText: "", action: { type: "button", buttons: [{ id: "b", title: "B" }] } }),
    ).toThrow();
  });
});

describe("buildInteractivePayload — lists", () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `r${i}`, title: `Row ${i}` }));

  it("builds a list payload with a default button label", () => {
    const payload = buildInteractivePayload({
      bodyText: "Pick one",
      action: { type: "list", sections: [{ title: "Menu", rows: rows(3) }] },
    }) as any;
    expect(payload.type).toBe("list");
    expect(payload.action.button).toBe("Choose");
    expect(payload.action.sections[0].rows).toHaveLength(3);
  });

  it("accepts 10 rows per section and rejects an 11th", () => {
    expect(() =>
      buildInteractivePayload({ bodyText: "x", action: { type: "list", sections: [{ rows: rows(WA_LIST_ROWS_MAX) }] } }),
    ).not.toThrow();
    expect(() =>
      buildInteractivePayload({ bodyText: "x", action: { type: "list", sections: [{ rows: rows(WA_LIST_ROWS_MAX + 1) }] } }),
    ).toThrow(/at most 10 rows/);
  });

  it("truncates over-long row titles to 24 chars", () => {
    const payload = buildInteractivePayload({
      bodyText: "x",
      action: { type: "list", sections: [{ rows: [{ id: "r", title: "R".repeat(50) }] }] },
    }) as any;
    expect(payload.action.sections[0].rows[0].title.length).toBeLessThanOrEqual(WA_LIST_ROW_TITLE_LIMIT);
  });
});

describe("buildMediaPayload", () => {
  it("builds an image payload by link with caption", () => {
    expect(buildMediaPayload({ type: "image", link: "https://cdn.example.com/p.jpg", caption: "Nice" })).toEqual({
      link: "https://cdn.example.com/p.jpg",
      caption: "Nice",
    });
  });

  it("builds a document payload by mediaId with filename", () => {
    expect(buildMediaPayload({ type: "document", mediaId: "media-1", filename: "menu.pdf" })).toEqual({
      id: "media-1",
      filename: "menu.pdf",
    });
  });

  it("requires exactly one of link or mediaId", () => {
    expect(() => buildMediaPayload({ type: "image" })).toThrow(/exactly one/);
    expect(() => buildMediaPayload({ type: "image", link: "https://x", mediaId: "m" })).toThrow(/exactly one/);
  });
});

describe("sendWhatsAppInteractive", () => {
  it("simulates (and does not throw) when no credentials exist", async () => {
    vi.stubEnv("WAC_WHATSAPP_TOKEN", "");
    vi.stubEnv("WAC_WHATSAPP_PHONE_ID", "");
    mockDbWithTenant(null);
    const result = await sendWhatsAppInteractive("tenant-1", "+2348012345678", {
      bodyText: "Menu",
      action: { type: "button", buttons: [{ id: "menu_1", title: "Shop" }] },
    });
    expect(result).toEqual({ sent: false, simulated: true, wamid: null });
  });

  it("posts a type=interactive payload with the tenant token", async () => {
    mockDbWithTenant({
      phoneNumberId: "tenant-phone-123",
      settings: { whatsapp: { accessToken: "tenant-secret-token" } },
    });
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ messages: [{ id: "wamid.int1" }] }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await sendWhatsAppInteractive("tenant-1", "+234 801 234 5678", {
      bodyText: "Choose an option",
      action: { type: "list", sections: [{ rows: [{ id: "menu_1", title: "Shop" }] }] },
    });
    expect(result).toEqual({ sent: true, simulated: false, wamid: "wamid.int1" });
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://graph.facebook.com/v21.0/tenant-phone-123/messages");
    expect(opts.headers.Authorization).toBe("Bearer tenant-secret-token");
    const payload = JSON.parse(opts.body);
    expect(payload.to).toBe("2348012345678");
    expect(payload.type).toBe("interactive");
    expect(payload.interactive.type).toBe("list");
    expect(payload.interactive.action.sections[0].rows[0].id).toBe("menu_1");
  });

  it("throws on a non-200 Graph API response", async () => {
    mockDbWithTenant(null);
    stubEnvCreds();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 400, text: async () => "bad request" }));
    await expect(
      sendWhatsAppInteractive("tenant-1", "2348012345678", {
        bodyText: "x",
        action: { type: "button", buttons: [{ id: "b", title: "B" }] },
      }),
    ).rejects.toThrow(/400/);
  });
});

describe("sendWhatsAppMedia", () => {
  it("posts a type=document payload with link + filename", async () => {
    mockDbWithTenant(null);
    stubEnvCreds();
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ messages: [{ id: "wamid.doc1" }] }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await sendWhatsAppMedia("tenant-1", "2348012345678", {
      type: "document",
      link: "https://cdn.example.com/menu.pdf",
      caption: "Our menu",
      filename: "menu.pdf",
    });
    expect(result.sent).toBe(true);
    const payload = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(payload.type).toBe("document");
    expect(payload.document).toEqual({
      link: "https://cdn.example.com/menu.pdf",
      caption: "Our menu",
      filename: "menu.pdf",
    });
  });

  it("posts a type=image payload by mediaId and simulates without creds", async () => {
    mockDbWithTenant(null);
    stubEnvCreds();
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ messages: [{ id: "wamid.img1" }] }),
    });
    vi.stubGlobal("fetch", mockFetch);
    const sent = await sendWhatsAppMedia("tenant-1", "2348012345678", { type: "image", mediaId: "m-1" });
    expect(sent.wamid).toBe("wamid.img1");
    expect(JSON.parse(mockFetch.mock.calls[0][1].body).image).toEqual({ id: "m-1" });

    vi.unstubAllEnvs();
    vi.stubEnv("WAC_WHATSAPP_TOKEN", "");
    vi.stubEnv("WAC_WHATSAPP_PHONE_ID", "");
    const sim = await sendWhatsAppMedia("tenant-1", "2348012345678", { type: "image", mediaId: "m-1" });
    expect(sim.simulated).toBe(true);
  });
});
