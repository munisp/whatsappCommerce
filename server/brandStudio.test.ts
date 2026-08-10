/**
 * brandStudio tests — monogram determinism + edge cases, palette saturation
 * guard, tagline templates, branding schema backwards-compat, brand-kit
 * provider fallback, and WhatsApp profile push (field assembly, partial
 * failure mapping, never-throws, about clamp, photo handle flow).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("./db", () => ({ getDb: vi.fn() }));
vi.mock("./services/waSender", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./services/waSender")>();
  return { ...orig, resolveTenantWaCredentials: vi.fn() };
});

import { getDb } from "./db";
import { resolveTenantWaCredentials } from "./services/waSender";
import { brandingConfigSchema } from "../shared/tenantConfig";
import {
  buildMonogramSvg,
  buildTagline,
  clampProfileField,
  clampSaturation,
  derivePalette,
  generateBrandKit,
  generateMonogramLogo,
  hashSeed,
  hexToHsl,
  hslToHex,
  initialsFromName,
  isLetterChar,
  parseDataUri,
  pushWhatsappProfile,
  svgToDataUri,
  WA_PROFILE_LIMITS,
} from "./services/brandStudio";

const mockedGetDb = vi.mocked(getDb);
const mockedResolve = vi.mocked(resolveTenantWaCredentials);

const PNG_1PX =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PNG_DATA_URI = `data:image/png;base64,${PNG_1PX}`;

const ENV_KEYS = ["IMAGE_GEN_API_KEY", "OPENAI_API_KEY", "IMAGE_GEN_API_URL", "IMAGE_GEN_MODEL", "WHATSAPP_APP_ID", "WAC_WHATSAPP_APP_ID"];
let savedEnv: Record<string, string | undefined> = {};

function graphOk(body: any = { success: true }) {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}
function graphErr(status = 400, body: any = { error: { message: "bad request" } }) {
  return { ok: false, status, json: async () => body } as unknown as Response;
}

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  mockedGetDb.mockReset().mockResolvedValue(null as any);
  mockedResolve.mockReset();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.unstubAllGlobals();
});

// ─── Monogram determinism + initials ─────────────────────────────────────────

describe("monogram logo", () => {
  it("is deterministic — same name, same logo", () => {
    const a = generateMonogramLogo("Adire Threads");
    const b = generateMonogramLogo("Adire Threads");
    expect(a.dataUri).toBe(b.dataUri);
    expect(a.primaryColor).toBe(b.primaryColor);
    expect(a.secondaryColor).toBe(b.secondaryColor);
  });

  it("different names produce different palettes (practically)", () => {
    const names = ["Adire Threads", "Lagos Groceries", "Zara Beauty", "Kano Electronics", "Enugu Books"];
    const colors = new Set(names.map((n) => generateMonogramLogo(n).primaryColor));
    expect(colors.size).toBeGreaterThan(1);
  });

  it("initials: two-word name → first letter of each word", () => {
    expect(initialsFromName("Adire Threads")).toBe("AT");
  });

  it("initials: single word → first two letters", () => {
    expect(initialsFromName("Zara")).toBe("ZA");
  });

  it("initials: single-character word", () => {
    expect(initialsFromName("X")).toBe("X");
  });

  it("initials: unicode names are handled (NFC + uppercase)", () => {
    expect(initialsFromName("Élodie Café")).toBe("ÉC");
    expect(initialsFromName(" Ìfẹ́ Textiles ")).toBe("ÌT");
  });

  it("initials: long names are capped at two letters, digits/punct skipped", () => {
    expect(initialsFromName("The Quick Brown Fox Jumps")).toBe("TQ");
    expect(initialsFromName("24/7 Mini Mart")).toBe("MM");
  });

  it("initials: empty/whitespace/degenerate input never crashes", () => {
    expect(initialsFromName("")).toBe("?");
    expect(initialsFromName("   ")).toBe("?");
    expect(initialsFromName("123 !!!")).toBe("?");
  });

  it("isLetterChar covers cased + uncased scripts, rejects digits/symbols", () => {
    expect(isLetterChar("a")).toBe(true);
    expect(isLetterChar("中")).toBe(true);
    expect(isLetterChar("7")).toBe(false);
    expect(isLetterChar("!")).toBe(false);
  });

  it("hashSeed is stable across calls", () => {
    expect(hashSeed("Adire")).toBe(hashSeed("Adire"));
    expect(hashSeed("Adire")).not.toBe(hashSeed("adire"));
  });

  it("SVG output contains initials and escapes XML", () => {
    const svg = buildMonogramSvg("A&", "#5B7C99");
    expect(svg).toContain("A&amp;");
    expect(svg).toContain("#5B7C99");
    expect(svg.startsWith("<svg")).toBe(true);
  });

  it("data URI is base64 SVG", () => {
    const uri = svgToDataUri(buildMonogramSvg("AT", "#5B7C99"));
    expect(uri.startsWith("data:image/svg+xml;base64,")).toBe(true);
    expect(Buffer.from(uri.split(",")[1], "base64").toString("utf8")).toContain("<svg");
  });
});

// ─── Palette saturation guard ────────────────────────────────────────────────

describe("palette saturation guard", () => {
  it("clampSaturation pulls neon down to the ceiling", () => {
    const clamped = clampSaturation("#FF00FF");
    expect(hexToHsl(clamped).s).toBeLessThanOrEqual(0.46); // rounding slack on hex round-trip
    expect(clamped).toMatch(/^#[0-9A-F]{6}$/);
  });

  it("clampSaturation leaves muted colors alone (round-trip stable)", () => {
    expect(clampSaturation("#6B7A8A")).toBe("#6B7A8A"); // slate, s ≈ 0.13
    expect(hexToHsl(clampSaturation("#8A5A2B")).s).toBeLessThanOrEqual(0.45 + 1e-9);
  });

  it("hslToHex/hexToHsl round-trips grayscale", () => {
    const { h, s, l } = hexToHsl("#808080");
    expect(s).toBe(0);
    expect(hslToHex(h, s, l)).toBe("#808080");
  });

  it("every derived palette stays low-saturation across many seeds", () => {
    for (let seed = 0; seed < 500; seed += 7) {
      const { primaryColor, secondaryColor } = derivePalette(seed);
      expect(primaryColor).toMatch(/^#[0-9A-F]{6}$/);
      expect(secondaryColor).toMatch(/^#[0-9A-F]{6}$/);
      expect(hexToHsl(primaryColor).s).toBeLessThanOrEqual(0.45 + 1e-9);
      expect(hexToHsl(secondaryColor).s).toBeLessThanOrEqual(0.45 + 1e-9);
    }
  });
});

// ─── Taglines ────────────────────────────────────────────────────────────────

describe("taglines", () => {
  it("is deterministic for the same input", () => {
    expect(buildTagline("fashion", "Adire")).toBe(buildTagline("fashion", "Adire"));
  });

  it("industry keyword match picks the industry template", () => {
    expect(buildTagline("Fashion Retail", "Adire")).toBe("Style that fits your story");
    expect(buildTagline("restaurant", "Mama Put")).toBe("Fresh flavor, one message away");
  });

  it("unknown industry falls back deterministically and stays within limits", () => {
    const t = buildTagline("quantum widgets", "Qwerty Corp");
    expect(t).toBe(buildTagline("quantum widgets", "Qwerty Corp"));
    expect(t.length).toBeLessThanOrEqual(120);
    expect(t.length).toBeGreaterThan(0);
  });
});

// ─── Branding schema backwards-compat ────────────────────────────────────────

describe("brandingConfigSchema extension", () => {
  it("old 3-field settings JSON still parses", () => {
    const old = { name: "Adire", logoUrl: null, primaryColor: "#8A5A2B" };
    const parsed = brandingConfigSchema.parse(old);
    expect(parsed.primaryColor).toBe("#8A5A2B");
    expect(parsed.secondaryColor).toBeUndefined();
    expect(parsed.logoGeneratedAt).toBeUndefined();
  });

  it("new fields validate: secondaryColor hex, tagline, waProfileAbout, logoGeneratedAt", () => {
    const parsed = brandingConfigSchema.parse({
      name: "Adire",
      logoUrl: "https://cdn.example.com/l.png",
      primaryColor: "#5B7C99",
      secondaryColor: "#A9BCCB",
      tagline: "Style that fits your story",
      waProfileAbout: "Hand-dyed adire from Lagos",
      logoGeneratedAt: new Date().toISOString(),
    });
    expect(parsed.secondaryColor).toBe("#A9BCCB");
  });

  it("logoGeneratedAt accepts null", () => {
    const parsed = brandingConfigSchema.parse({
      name: "Adire", logoUrl: null, primaryColor: "#5B7C99", logoGeneratedAt: null,
    });
    expect(parsed.logoGeneratedAt).toBeNull();
  });

  it("rejects bad secondaryColor hex", () => {
    expect(() =>
      brandingConfigSchema.parse({ name: "A", logoUrl: null, primaryColor: "#5B7C99", secondaryColor: "blue" }),
    ).toThrow();
  });

  it("rejects waProfileAbout over Meta's 139-char limit", () => {
    expect(() =>
      brandingConfigSchema.parse({ name: "A", logoUrl: null, primaryColor: "#5B7C99", waProfileAbout: "x".repeat(140) }),
    ).toThrow();
  });

  it("rejects tagline over 120 chars", () => {
    expect(() =>
      brandingConfigSchema.parse({ name: "A", logoUrl: null, primaryColor: "#5B7C99", tagline: "x".repeat(121) }),
    ).toThrow();
  });
});

// ─── generateBrandKit ────────────────────────────────────────────────────────

describe("generateBrandKit", () => {
  it("returns the contract shape with the monogram when no provider is configured", async () => {
    const kit = await generateBrandKit({ businessName: "Adire Threads", industry: "fashion" });
    expect(kit.logoSvgDataUri.startsWith("data:image/svg+xml;base64,")).toBe(true);
    expect(kit.logoUrl).toBeNull();
    expect(kit.primaryColor).toMatch(/^#[0-9A-F]{6}$/);
    expect(kit.secondaryColor).toMatch(/^#[0-9A-F]{6}$/);
    expect(kit.tagline).toBe("Style that fits your story");
  });

  it("provider failure (fetch throws) falls back to the monogram silently", async () => {
    process.env.IMAGE_GEN_API_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    const kit = await generateBrandKit({ businessName: "Adire Threads" });
    expect(kit.logoUrl).toBeNull();
    expect(kit.logoSvgDataUri.startsWith("data:image/svg+xml;base64,")).toBe(true);
  });

  it("provider HTTP error also falls back silently", async () => {
    process.env.IMAGE_GEN_API_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(graphErr(500)));
    const kit = await generateBrandKit({ businessName: "Adire Threads" });
    expect(kit.logoUrl).toBeNull();
  });

  it("provider success returns a logoUrl and persists assets + settings when tenantId given", async () => {
    process.env.IMAGE_GEN_API_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(graphOk({ data: [{ b64_json: PNG_1PX }] })));

    const inserts: any[] = [];
    const updates: any[] = [];
    const db: any = {
      insert: vi.fn(() => ({ values: vi.fn((v: any) => { inserts.push(v); return Promise.resolve(); }) })),
      select: vi.fn(() => {
        const c: any = { from: vi.fn(() => c), where: vi.fn(() => c), limit: vi.fn(() => Promise.resolve([{ settings: { branding: { name: "Adire Threads", logoUrl: null, primaryColor: "#8A5A2B" } } }])) };
        return c;
      }),
      update: vi.fn(() => ({ set: vi.fn((v: any) => { updates.push(v); return { where: vi.fn(() => Promise.resolve()) }; }) })),
    };
    mockedGetDb.mockResolvedValue(db);

    const kit = await generateBrandKit({ tenantId: "t-1", businessName: "Adire Threads", industry: "fashion" });
    expect(kit.logoUrl).toBe(`data:image/png;base64,${PNG_1PX}`);
    expect(inserts).toHaveLength(2); // monogram svg + ai png
    expect(inserts[0].mime).toBe("image/svg+xml");
    expect(inserts[1].mime).toBe("image/png");
    expect(inserts[0].tenantId).toBe("t-1");
    expect(updates).toHaveLength(1);
    const branding = updates[0].settings.branding;
    expect(branding.secondaryColor).toBe(kit.secondaryColor);
    expect(branding.tagline).toBe(kit.tagline);
    expect(typeof branding.logoGeneratedAt).toBe("string");
    expect(branding.primaryColor).toBe(kit.primaryColor); // default gets replaced
  });

  it("keeps a customized tenant primaryColor when merging settings", async () => {
    const updates: any[] = [];
    const db: any = {
      insert: vi.fn(() => ({ values: vi.fn(() => Promise.resolve()) })),
      select: vi.fn(() => {
        const c: any = { from: vi.fn(() => c), where: vi.fn(() => c), limit: vi.fn(() => Promise.resolve([{ settings: { branding: { name: "Adire", logoUrl: "https://x/l.png", primaryColor: "#123456" } } }])) };
        return c;
      }),
      update: vi.fn(() => ({ set: vi.fn((v: any) => { updates.push(v); return { where: vi.fn(() => Promise.resolve()) }; }) })),
    };
    mockedGetDb.mockResolvedValue(db);
    await generateBrandKit({ tenantId: "t-1", businessName: "Adire" });
    expect(updates[0].settings.branding.primaryColor).toBe("#123456");
    expect(updates[0].settings.branding.logoUrl).toBe("https://x/l.png");
  });

  it("persistence failure never fails the kit", async () => {
    mockedGetDb.mockRejectedValue(new Error("db down"));
    const kit = await generateBrandKit({ tenantId: "t-1", businessName: "Adire" });
    expect(kit.logoSvgDataUri.startsWith("data:image/svg+xml;base64,")).toBe(true);
  });
});

// ─── Profile field helpers ───────────────────────────────────────────────────

describe("profile field helpers", () => {
  it("clampProfileField leaves short values untouched", () => {
    expect(clampProfileField("Hello there", 139)).toBe("Hello there");
  });

  it("clampProfileField clamps to Meta's about limit on a word boundary", () => {
    const long = ("hand-dyed adire fabrics made with love in lagos nigeria ".repeat(4)).trim();
    const clamped = clampProfileField(long, WA_PROFILE_LIMITS.about);
    expect(clamped.length).toBeLessThanOrEqual(139);
    expect(clamped.endsWith(" ")).toBe(false);
  });

  it("parseDataUri parses base64 payloads and rejects junk", () => {
    const parsed = parseDataUri(PNG_DATA_URI);
    expect(parsed?.mime).toBe("image/png");
    expect(parsed?.bytes.length).toBeGreaterThan(0);
    expect(parseDataUri("not-a-data-uri")).toBeNull();
    expect(parseDataUri("data:image/png;base64,")).toBeNull();
  });
});

// ─── pushWhatsappProfile ─────────────────────────────────────────────────────

describe("pushWhatsappProfile", () => {
  const CREDS = { phoneNumberId: "pn-1", accessToken: "tok", source: "tenant" as const };

  it("assembles the business-profile POST and reports pushed fields", async () => {
    mockedResolve.mockResolvedValue(CREDS);
    const fetchMock = vi.fn().mockResolvedValue(graphOk());
    vi.stubGlobal("fetch", fetchMock);

    const res = await pushWhatsappProfile({
      tenantId: "t-1",
      about: "Hand-dyed adire",
      description: "We sell adire",
      address: "12 Marina Rd, Lagos",
      vertical: "RETAIL",
    });
    expect(res).toEqual({ ok: true, pushed: ["about", "description", "address", "vertical"], failed: [] });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://graph.facebook.com/v21.0/pn-1/whatsapp_business_profile");
    const body = JSON.parse(init.body);
    expect(body.messaging_product).toBe("whatsapp");
    expect(body.about).toBe("Hand-dyed adire");
    expect(body.vertical).toBe("RETAIL");
    expect(init.headers.authorization).toBe("Bearer tok");
  });

  it("clamps about to 139 chars before sending", async () => {
    mockedResolve.mockResolvedValue(CREDS);
    const fetchMock = vi.fn().mockResolvedValue(graphOk());
    vi.stubGlobal("fetch", fetchMock);
    const res = await pushWhatsappProfile({ tenantId: "t-1", about: "word ".repeat(60) });
    expect(res.ok).toBe(true);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.about.length).toBeLessThanOrEqual(139);
  });

  it("maps Meta errors to failed[] without throwing", async () => {
    mockedResolve.mockResolvedValue(CREDS);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(graphErr(400)));
    const res = await pushWhatsappProfile({ tenantId: "t-1", about: "Hi", vertical: "RETAIL" });
    expect(res.ok).toBe(false);
    expect(res.pushed).toEqual([]);
    expect(res.failed.sort()).toEqual(["about", "vertical"]);
  });

  it("network throw → never throws, reports failed fields", async () => {
    mockedResolve.mockResolvedValue(CREDS);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNRESET")));
    const res = await pushWhatsappProfile({ tenantId: "t-1", about: "Hi" });
    expect(res.ok).toBe(false);
    expect(res.failed).toEqual(["about"]);
  });

  it("no credentials → ok:false, everything failed, never throws", async () => {
    mockedResolve.mockResolvedValue(null);
    const res = await pushWhatsappProfile({ tenantId: "t-1", about: "Hi", logoDataUri: PNG_DATA_URI });
    expect(res.ok).toBe(false);
    expect(res.pushed).toEqual([]);
    expect(res.failed.sort()).toEqual(["about", "photo"]);
  });

  it("credential resolution throwing is swallowed", async () => {
    mockedResolve.mockRejectedValue(new Error("db exploded"));
    const res = await pushWhatsappProfile({ tenantId: "t-1", description: "x" });
    expect(res.ok).toBe(false);
    expect(res.failed).toEqual(["description"]);
  });

  it("photo flow: upload session → file handle → profile_picture_handle", async () => {
    process.env.WHATSAPP_APP_ID = "app-123";
    mockedResolve.mockResolvedValue(CREDS);
    const fetchMock = vi.fn((url: string) => {
      if (url.includes("/app-123/uploads")) return Promise.resolve(graphOk({ id: "upload-1" }));
      if (url.includes("/upload-1")) return Promise.resolve(graphOk({ h: "handle-abc" }));
      return Promise.resolve(graphOk()); // business profile POSTs
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await pushWhatsappProfile({ tenantId: "t-1", about: "Hi", logoDataUri: PNG_DATA_URI });
    expect(res).toEqual({ ok: true, pushed: ["about", "photo"], failed: [] });

    // session creation carried file metadata
    const sessionUrl = fetchMock.mock.calls[1][0] as string;
    expect(sessionUrl).toContain("/app-123/uploads");
    expect(sessionUrl).toContain("file_type=image%2Fpng");
    // raw bytes uploaded with OAuth header
    const [uploadUrl, uploadInit] = fetchMock.mock.calls[2];
    expect(uploadUrl).toContain("/upload-1");
    expect(uploadInit.headers.authorization).toBe("OAuth tok");
    expect(uploadInit.headers.file_offset).toBe("0");
    // handle applied to the profile
    const picBody = JSON.parse(fetchMock.mock.calls[3][1].body);
    expect(picBody.profile_picture_handle).toBe("handle-abc");
  });

  it("partial success: text pushed, photo failed (no app id)", async () => {
    mockedResolve.mockResolvedValue(CREDS);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(graphOk()));
    const res = await pushWhatsappProfile({ tenantId: "t-1", about: "Hi", logoDataUri: PNG_DATA_URI });
    expect(res.ok).toBe(false);
    expect(res.pushed).toEqual(["about"]);
    expect(res.failed).toEqual(["photo"]);
  });

  it("rejects non-raster photo payloads (SVG) into failed[]", async () => {
    process.env.WHATSAPP_APP_ID = "app-123";
    mockedResolve.mockResolvedValue(CREDS);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(graphOk()));
    const svgUri = "data:image/svg+xml;base64," + Buffer.from("<svg/>").toString("base64");
    const res = await pushWhatsappProfile({ tenantId: "t-1", logoDataUri: svgUri });
    expect(res.ok).toBe(false);
    expect(res.failed).toEqual(["photo"]);
  });

  it("empty args still never throws", async () => {
    mockedResolve.mockResolvedValue(CREDS);
    const res = await pushWhatsappProfile({ tenantId: "t-1" });
    expect(res).toEqual({ ok: false, pushed: [], failed: [] });
  });
});
