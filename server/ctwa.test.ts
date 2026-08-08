/**
 * CTWA tests: link building, QR token round-trip, campaign creation,
 * inbound keyword attribution + mapped action replies.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./db", () => ({ getDb: vi.fn() }));
vi.mock("./services/waSender", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./services/waSender")>();
  return { ...orig, sendWhatsAppText: vi.fn() };
});
vi.mock("./services/waMenuPreview", () => ({
  previewWaMenuForTenant: vi.fn().mockResolvedValue({ text: "MENU: 1) Shoes", menu: {}, data: {} }),
}));

import QRCode from "qrcode";
import { sendWhatsAppText } from "./services/waSender";
import { previewWaMenuForTenant } from "./services/waMenuPreview";
import {
  attributeCampaign,
  buildCtwaLink,
  createCtwaCampaign,
  ctwaQrToken,
  handleCtwaInbound,
  parseCtwaCampaigns,
  tenantWaPhone,
  verifyCtwaQrToken,
} from "./services/ctwa";

const SETTINGS = {
  whatsapp: { displayPhone: "+234 801 000 1111" },
  ctwa: {
    campaigns: [
      { id: "camp-1", keyword: "menu", label: "Menu link", action: "menu" },
      { id: "camp-2", keyword: "track", label: "Tracking link", action: "track", reply: "Send your order #." },
    ],
  },
};

function makeDb(customerRow?: any) {
  const updates: any[] = [];
  const inserts: any[] = [];
  // customerRow === undefined → select returns the tenant settings row
  // (campaign management path); otherwise it returns customer rows
  // (attribution path).
  const selectRows = customerRow === undefined ? [{ settings: SETTINGS }] : customerRow ? [customerRow] : [];
  const db: any = {
    select: vi.fn(() => {
      const c: any = {
        from: vi.fn(() => c),
        where: vi.fn(() => c),
        limit: vi.fn(() => Promise.resolve(selectRows)),
        catch: vi.fn(() => Promise.resolve(selectRows)),
      };
      return c;
    }),
    update: vi.fn(() => ({
      set: vi.fn((v: any) => {
        updates.push(v);
        return { where: vi.fn(() => Promise.resolve()) };
      }),
    })),
    insert: vi.fn(() => ({
      values: vi.fn((v: any) => {
        inserts.push(v);
        return { onConflictDoNothing: vi.fn(() => Promise.resolve()) };
      }),
    })),
  };
  return { db, updates, inserts };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(sendWhatsAppText).mockResolvedValue({ sent: true, simulated: false, wamids: ["w"], chunks: 1 });
});

describe("buildCtwaLink + tenantWaPhone", () => {
  it("builds wa.me deep links with normalized phone + encoded text", () => {
    expect(buildCtwaLink("+234 801 000 1111", "menu")).toBe("https://wa.me/2348010001111?text=menu");
    expect(buildCtwaLink("234801", "I want a promo")).toBe("https://wa.me/234801?text=I%20want%20a%20promo");
  });

  it("reads the display phone from settings and rejects junk", () => {
    expect(tenantWaPhone(SETTINGS)).toBe("2348010001111");
    expect(tenantWaPhone({ whatsapp: { displayPhone: "abc" } })).toBeNull();
    expect(tenantWaPhone({})).toBeNull();
  });
});

describe("QR token", () => {
  it("round-trips and rejects tampering", () => {
    const tok = ctwaQrToken("t1", "camp-1");
    expect(verifyCtwaQrToken("t1", "camp-1", tok)).toBe(true);
    expect(verifyCtwaQrToken("t1", "camp-2", tok)).toBe(false);
    expect(verifyCtwaQrToken("t2", "camp-1", tok)).toBe(false);
    expect(verifyCtwaQrToken("t1", "camp-1", "garbage")).toBe(false);
    expect(verifyCtwaQrToken("t1", "camp-1", undefined)).toBe(false);
  });
});

describe("QR PNG generation (qrcode lib)", () => {
  it("renders a real PNG buffer with the PNG magic header", async () => {
    const png = await QRCode.toBuffer(buildCtwaLink("2348010001111", "menu"), { type: "png", width: 256 });
    expect(png.length).toBeGreaterThan(100);
    // PNG magic: 89 50 4E 47 0D 0A 1A 0A
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });
});

describe("createCtwaCampaign", () => {
  it("persists the campaign in settings and returns link + token-guarded QR URL", async () => {
    const { db, updates } = makeDb();
    const res = await createCtwaCampaign(db, "t1", { keyword: "VIP Sale", label: "VIP promo", action: "promo" });
    expect(res.campaign.keyword).toBe("vip sale");
    expect(res.link).toBe(`https://wa.me/2348010001111?text=${encodeURIComponent("vip sale")}`);
    expect(res.qrUrl).toContain(`/api/ctwa/t1/${res.campaign.id}.png?token=`);
    const token = res.qrUrl.split("token=")[1];
    expect(verifyCtwaQrToken("t1", res.campaign.id, token)).toBe(true);
    expect(updates).toHaveLength(1);
    // settings is a drizzle sql fragment embedding the ctwa.campaigns array.
    expect(updates[0].settings).toBeDefined();
  });

  it("rejects duplicate keywords", async () => {
    const { db } = makeDb();
    await expect(createCtwaCampaign(db, "t1", { keyword: "menu", label: "dup" })).rejects.toThrow("menu");
  });
});

describe("parseCtwaCampaigns", () => {
  it("parses valid campaigns and defaults action to none", () => {
    const c = parseCtwaCampaigns(SETTINGS);
    expect(c).toHaveLength(2);
    expect(parseCtwaCampaigns({ ctwa: { campaigns: [{ id: "x", keyword: "k" }] } })[0].action).toBe("none");
    expect(parseCtwaCampaigns({})).toEqual([]);
  });
});

describe("attributeCampaign", () => {
  it("creates a new customer with the campaign tag (normalized phone)", async () => {
    const { db, inserts } = makeDb(null);
    await attributeCampaign(db, "t1", "+234 801 555", "menu", "Ada");
    expect(inserts[0]).toMatchObject({ tenantId: "t1", whatsappPhone: "234801555", name: "Ada", tags: ["campaign:menu"] });
  });

  it("appends the tag to an existing customer without duplicating", async () => {
    const existing = { id: "c1", tenantId: "t1", whatsappPhone: "234801555", name: "Ada", tags: ["vip"] };
    const { db, updates } = makeDb(existing);
    await attributeCampaign(db, "t1", "234801555", "menu");
    expect((updates[0] as any).tags).toEqual(["vip", "campaign:menu"]);

    const again = { ...existing, tags: ["vip", "campaign:menu"] };
    const second = makeDb(again);
    await attributeCampaign(second.db, "t1", "234801555", "menu");
    expect(second.updates).toHaveLength(0);
  });
});

describe("handleCtwaInbound", () => {
  function dbForHandler(customerRow: any) {
    // select calls: [tenant settings, customer]; customer rows depend on table —
    // our makeDb returns settings for the first select; for handleCtwaInbound the
    // tenant select happens first, then attributeCampaign selects the customer.
    const selects: any[][] = [[{ settings: SETTINGS }], customerRow ? [customerRow] : []];
    const updates: any[] = [];
    const inserts: any[] = [];
    const db: any = {
      select: vi.fn(() => {
        const rows = selects.shift() ?? [];
        const c: any = {
          from: vi.fn(() => c),
          where: vi.fn(() => c),
          limit: vi.fn(() => Promise.resolve(rows)),
          catch: vi.fn(() => Promise.resolve(rows)),
        };
        return c;
      }),
      update: vi.fn(() => ({ set: vi.fn((v: any) => { updates.push(v); return { where: vi.fn(() => Promise.resolve()) }; }) })),
      insert: vi.fn(() => ({ values: vi.fn((v: any) => { inserts.push(v); return { onConflictDoNothing: vi.fn(() => Promise.resolve()) }; }) })),
    };
    return { db, updates, inserts };
  }

  it("matches a campaign keyword: attributes the customer and sends the mapped menu", async () => {
    const existing = { id: "c1", tenantId: "t1", whatsappPhone: "234801555", name: null, tags: null };
    const { db, updates } = dbForHandler(existing);
    const handled = await handleCtwaInbound({ db, tenantId: "t1", phone: "234801555", text: "  MENU " });
    expect(handled).toBe(true);
    expect(previewWaMenuForTenant).toHaveBeenCalledWith("t1");
    expect(sendWhatsAppText).toHaveBeenCalledWith("t1", "234801555", "MENU: 1) Shoes", expect.objectContaining({ notifType: "ctwa_campaign" }));
    expect((updates[0] as any).tags).toEqual(["campaign:menu"]);
  });

  it("uses the campaign's custom reply when set (track action)", async () => {
    const { db, inserts } = dbForHandler(null);
    const handled = await handleCtwaInbound({ db, tenantId: "t1", phone: "234801999", text: "track" });
    expect(handled).toBe(true);
    expect(sendWhatsAppText).toHaveBeenCalledWith("t1", "234801999", "Send your order #.", expect.any(Object));
    expect(inserts[0].tags).toEqual(["campaign:track"]);
  });

  it("falls back to the static action reply when menu rendering fails", async () => {
    vi.mocked(previewWaMenuForTenant).mockRejectedValueOnce(new Error("no menu config"));
    const { db } = dbForHandler(null);
    const handled = await handleCtwaInbound({ db, tenantId: "t1", phone: "234801999", text: "menu" });
    expect(handled).toBe(true);
    expect(sendWhatsAppText).toHaveBeenCalledWith("t1", "234801999", expect.stringContaining("menu"), expect.any(Object));
  });

  it("ignores non-matching messages", async () => {
    const { db } = dbForHandler(null);
    const handled = await handleCtwaInbound({ db, tenantId: "t1", phone: "234801999", text: "hello there" });
    expect(handled).toBe(false);
    expect(sendWhatsAppText).not.toHaveBeenCalled();
  });

  it("ignores everything when no campaigns are configured", async () => {
    const db: any = {
      select: vi.fn(() => {
        const c: any = {
          from: vi.fn(() => c),
          where: vi.fn(() => c),
          limit: vi.fn(() => Promise.resolve([{ settings: {} }])),
          catch: vi.fn(() => Promise.resolve([{ settings: {} }])),
        };
        return c;
      }),
    };
    expect(await handleCtwaInbound({ db, tenantId: "t1", phone: "1", text: "menu" })).toBe(false);
  });
});
