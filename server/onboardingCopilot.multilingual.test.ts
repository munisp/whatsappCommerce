/**
 * onboardingCopilot.multilingual.test.ts — wave 15 (roadmap F5): multilingual
 * agentic onboarding intake in Hausa (ha), Yoruba (yo), Igbo (ig) and
 * Nigerian Pidgin (pcm), plus en/fr regression.
 *
 * Covers: per-language detection heuristics, diacritic hints, explicit user
 * override ("speak Yoruba" / bare "Hausa"), persistence of the thread
 * language on the session intake jsonb, mid-thread language switches,
 * low-confidence fallback (stay in current language), English fallback for
 * unknown text, full onboarding thread e2e in yo and pcm (LLM down →
 * template fallbacks), localized repair questions, and byte-for-byte
 * English regression of every localized wave-9 string.
 *
 * DB + LLM + brand studio are mocked exactly like onboardingCopilot.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getTableColumns, getTableName } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

// ─── In-memory DB mock (same style as onboardingCopilot.test.ts) ─────────────

const stores: Record<string, Record<string, unknown>[]> = {
  tenants: [],
  onboarding_sessions: [],
  audit_logs: [],
};

const dialect = new PgDialect();

function filterRows(table: unknown, cond: unknown, rows: Record<string, unknown>[]) {
  if (!cond) return rows;
  let compiled: { sql: string; params: unknown[] };
  try {
    compiled = dialect.sqlToQuery(cond as never);
  } catch {
    return rows;
  }
  const colMap: Record<string, string> = {};
  try {
    for (const [prop, col] of Object.entries(getTableColumns(table as never))) {
      colMap[(col as { name: string }).name] = prop;
    }
  } catch {
    return rows;
  }
  const tests: Array<(r: Record<string, unknown>) => boolean> = [];
  for (const part of compiled.sql.split(/ and /)) {
    const mEq = part.match(/"[\w]+"\."([\w]+)" = \$(\d+)/);
    if (mEq) {
      const prop = colMap[mEq[1]];
      const val = compiled.params[Number(mEq[2]) - 1];
      if (prop) tests.push((r) => String(r[prop]) === String(val));
    }
  }
  return rows.filter((r) => tests.every((t) => t(r)));
}

function makeChain(rows: Record<string, unknown>[]): any {
  const self: any = {};
  const chain = () => makeChain(rows);
  self.orderBy = chain;
  self.limit = chain;
  self.offset = chain;
  self.returning = () => Promise.resolve(rows);
  self.then = (resolve: (v: unknown) => void) => {
    resolve(rows);
    return self;
  };
  self.catch = () => self;
  return self;
}

function makeMockDb() {
  const db: any = {
    select: () => ({
      from: (table: unknown) => {
        const name = getTableName(table as never);
        const all = stores[name] ?? [];
        const api: any = {};
        api.where = (cond: unknown) => makeChain(filterRows(table, cond, all));
        api.orderBy = () => ({ limit: () => Promise.resolve(all) });
        api.then = (resolve: (v: unknown) => void) => {
          resolve(all);
          return api;
        };
        return api;
      },
    }),
    insert: (table: unknown) => ({
      values: (vals: Record<string, unknown>) => {
        const name = getTableName(table as never);
        const row = { id: crypto.randomUUID(), createdAt: new Date(), updatedAt: new Date(), ...vals };
        (stores[name] ??= []).push(row);
        return {
          returning: () => Promise.resolve([row]),
          then: (resolve: (v: unknown) => void) => resolve([row]),
        };
      },
    }),
    update: (table: unknown) => ({
      set: (vals: Record<string, unknown>) => ({
        where: (cond: unknown) => {
          const name = getTableName(table as never);
          const matched = filterRows(table, cond, stores[name] ?? []);
          const simpleVals: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(vals)) {
            if (v == null || typeof v !== "object" || v instanceof Date) simpleVals[k] = v;
            else if (!("sql" in (v as object))) simpleVals[k] = v;
          }
          for (const row of matched) Object.assign(row, simpleVals, { updatedAt: new Date() });
          return {
            returning: () => Promise.resolve(matched),
            then: (resolve: (v: unknown) => void) => resolve(matched),
          };
        },
      }),
    }),
    delete: (table: unknown) => ({
      where: (cond: unknown) => {
        const name = getTableName(table as never);
        const matched = filterRows(table, cond, stores[name] ?? []);
        stores[name] = (stores[name] ?? []).filter((r) => !matched.includes(r));
        return Promise.resolve(matched);
      },
    }),
  };
  return db;
}

vi.mock("./db", () => ({
  getDb: vi.fn().mockImplementation(() => Promise.resolve(makeMockDb())),
}));
vi.mock("./permify", () => ({ permifyCheck: vi.fn().mockResolvedValue(true) }));
vi.mock("./_core/llm", () => ({ invokeLLM: vi.fn() }));
vi.mock("./services/brandStudio", () => ({
  generateBrandKit: vi.fn(),
  pushWhatsappProfile: vi.fn(),
}));

import { invokeLLM } from "./_core/llm";
import { generateBrandKit, pushWhatsappProfile } from "./services/brandStudio";

const invokeLLMMock = invokeLLM as unknown as ReturnType<typeof vi.fn>;
const generateBrandKitMock = generateBrandKit as unknown as ReturnType<typeof vi.fn>;
const pushProfileMock = pushWhatsappProfile as unknown as ReturnType<typeof vi.fn>;

const copilot = await import("./services/onboardingCopilot");
const langApi = await import("./services/onboardingCopilot/language");
const { repairQuestionFor } = await import("./services/onboardingCopilot/repair");

const {
  COPILOT_LANGUAGES,
  COPILOT_TEXT_PACKS,
  detectMessageLanguage,
  parseExplicitLanguageChoice,
  resolveTurnLanguage,
  t,
} = langApi;

const EN_PACK = COPILOT_TEXT_PACKS.en;

function fetchOk() {
  return Promise.resolve(new Response("{}", { status: 200 }));
}

beforeEach(() => {
  stores.tenants = [];
  stores.onboarding_sessions = [];
  stores.audit_logs = [];
  invokeLLMMock.mockReset();
  generateBrandKitMock.mockReset();
  pushProfileMock.mockReset();
  generateBrandKitMock.mockResolvedValue({
    logoSvgDataUri: "data:image/svg+xml;base64,AAAA",
    logoUrl: null,
    primaryColor: "#112233",
    secondaryColor: "#445566",
    tagline: "Adire Atelier — bold prints, daily",
  });
  pushProfileMock.mockResolvedValue({ ok: true, pushed: ["about", "description"], failed: [] });
  invokeLLMMock.mockRejectedValue(new Error("LLM unreachable"));
  vi.stubGlobal("fetch", vi.fn(fetchOk));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function getFresh(sessionId: string) {
  const s = await copilot.getSession(sessionId);
  if (!s) throw new Error("session missing");
  return s;
}

const CREDS_TEXT = "token is EAAHAPPYTOKEN1234567890abcde and phone number id is 12345678901";

async function approveAllProposals(sessionId: string) {
  const s = await getFresh(sessionId);
  for (const p of [...s.proposals]) {
    await copilot.decideProposal({ sessionId, proposalId: p.id, approve: true });
  }
}

// ─── Detection heuristics ────────────────────────────────────────────────────

describe("detectMessageLanguage", () => {
  it("detects Hausa from stopwords", () => {
    const d = detectMessageLanguage("Sannu! Ina son in buɗe kantin kayayyaki a Kano, nawa ne kudin?");
    expect(d.language).toBe("ha");
    expect(d.confidence).toBe("high");
  });

  it("detects Yoruba from stopwords + diacritics", () => {
    const d = detectMessageLanguage("Mo fẹ́ bẹ̀rẹ̀ iṣòwò aṣọ mi, ṣe o ràn mí lọ́wọ́?");
    expect(d.language).toBe("yo");
    expect(d.confidence).toBe("high");
  });

  it("detects Igbo from stopwords + diacritics", () => {
    const d = detectMessageLanguage("Kedu, achọrọ m ịmalite azụmahịa m, biko nye m aka");
    expect(d.language).toBe("ig");
    expect(d.confidence).toBe("high");
  });

  it("detects Nigerian Pidgin", () => {
    const d = detectMessageLanguage("Abeg, I wan open shop, we dey sell food for Lagos");
    expect(d.language).toBe("pcm");
    expect(d.confidence).toBe("high");
  });

  it("detects French", () => {
    const d = detectMessageLanguage("Bonjour, je voulez ouvrir ma boutique, merci beaucoup");
    expect(d.language).toBe("fr");
  });

  it("returns en/low-confidence for unknown or plain English text", () => {
    const d = detectMessageLanguage("hello, I would like to set up my store");
    expect(d.language).toBe("en");
    expect(d.confidence).toBe("low");
  });

  it("returns en/low for empty text", () => {
    expect(detectMessageLanguage("")).toMatchObject({ language: "en", confidence: "low" });
  });

  it("Yoruba diacritic ṣ alone is a strong signal", () => {
    const d = detectMessageLanguage("ṣeun");
    expect(d.language).toBe("yo");
    expect(d.confidence).toBe("high");
  });

  it("Igbo diacritics ị/ụ are a strong signal", () => {
    const d = detectMessageLanguage("daalụ");
    expect(d.language).toBe("ig");
    expect(d.confidence).toBe("high");
  });
});

// ─── Explicit override parsing ───────────────────────────────────────────────

describe("parseExplicitLanguageChoice", () => {
  it("parses 'speak Yoruba'", () => {
    expect(parseExplicitLanguageChoice("speak Yoruba")).toBe("yo");
  });
  it("parses 'please reply in Hausa'", () => {
    expect(parseExplicitLanguageChoice("please reply in Hausa")).toBe("ha");
  });
  it("parses 'switch to pidgin'", () => {
    expect(parseExplicitLanguageChoice("switch to pidgin")).toBe("pcm");
  });
  it("parses bare language names with politeness markers", () => {
    expect(parseExplicitLanguageChoice("Hausa please")).toBe("ha");
    expect(parseExplicitLanguageChoice("yoruba?")).toBe("yo");
    expect(parseExplicitLanguageChoice("pidgin abeg")).toBe("pcm");
  });
  it("parses English and French requests", () => {
    expect(parseExplicitLanguageChoice("speak English")).toBe("en");
    expect(parseExplicitLanguageChoice("please respond in French")).toBe("fr");
  });
  it("does not fire on business names that merely mention a language", () => {
    expect(parseExplicitLanguageChoice("My shop name is Yoruba Foods Lagos")).toBeNull();
    expect(parseExplicitLanguageChoice("I sell Hausa fabrics in Kano")).toBeNull();
  });
  it("returns null for unrelated text", () => {
    expect(parseExplicitLanguageChoice("I deliver to Lekki every day")).toBeNull();
  });
});

// ─── Text packs ──────────────────────────────────────────────────────────────

describe("copilot text packs", () => {
  it("every language pack has every key", () => {
    const keys = Object.keys(EN_PACK) as Array<keyof typeof EN_PACK>;
    for (const lang of COPILOT_LANGUAGES) {
      for (const k of keys) {
        expect(typeof COPILOT_TEXT_PACKS[lang][k], `${lang}.${k}`).toBe("string");
        expect(COPILOT_TEXT_PACKS[lang][k].length).toBeGreaterThan(0);
      }
    }
  });

  it("ha/yo/ig/pcm packs actually differ from English", () => {
    for (const lang of ["ha", "yo", "ig", "pcm"] as const) {
      expect(COPILOT_TEXT_PACKS[lang].greeting).not.toBe(EN_PACK.greeting);
      expect(COPILOT_TEXT_PACKS[lang].goLiveReady).not.toBe(EN_PACK.goLiveReady);
      expect(COPILOT_TEXT_PACKS[lang].live).not.toBe(EN_PACK.live);
    }
  });

  it("t() substitutes params and falls back to English for unknown locales", () => {
    expect(t("yo", "decideApproved", { kind: "waMenu" })).toContain("waMenu");
    expect(t("xx", "askBusiness")).toBe(EN_PACK.askBusiness);
    expect(t("pcm", "missingProposals", { count: 3 })).toContain("3");
    expect(t("en", "missingProposals", { count: 2 })).toBe(
      "there are 2 proposal(s) waiting for your approval — approve them first.",
    );
  });

  it("English pack is byte-identical to the wave-9 strings (regression)", () => {
    expect(EN_PACK.greeting).toBe(
      "Hi! I'm your onboarding assistant. Tell me about your business — " +
        "the name, what you sell, and your city — and I'll draft your WhatsApp " +
        "menu, branding and integrations for you to approve.",
    );
    expect(EN_PACK.askBusiness).toBe(
      "Great to meet you! What's your business called, and what do you sell? " +
        "A city and how you handle delivery helps too.",
    );
    expect(EN_PACK.live).toBe(
      "🎉 You're LIVE! Your customers can now message your business on WhatsApp.",
    );
    expect(EN_PACK.alreadyLive).toBe("You're already live! 🎉");
    expect(EN_PACK.decideDiscarded).toBe(
      "Discarded the {kind} proposal. Tell me what you'd prefer and I'll draft another.",
    );
    expect(EN_PACK.repairWhatsapp).toContain("Meta Business Settings → WhatsApp → API Setup");
  });
});

// ─── resolveTurnLanguage (session-level policy) ──────────────────────────────

describe("resolveTurnLanguage", () => {
  function fakeSession(language?: string) {
    return { intake: { facts: {}, ...(language ? { language } : {}) } };
  }

  it("explicit choice wins and persists on the session", () => {
    const s = fakeSession();
    const r = resolveTurnLanguage(s, "speak Igbo");
    expect(r).toMatchObject({ language: "ig", switched: true, explicit: true });
    expect(s.intake.language).toBe("ig");
  });

  it("high-confidence detection switches the thread language", () => {
    const s = fakeSession("en");
    const r = resolveTurnLanguage(s, "Abeg, we dey sell phone accessories, wetin you need?");
    expect(r.language).toBe("pcm");
    expect(r.switched).toBe(true);
    expect(s.intake.language).toBe("pcm");
  });

  it("low-confidence text stays in the current language", () => {
    const s = fakeSession("yo");
    const r = resolveTurnLanguage(s, "ok, sounds good");
    expect(r).toMatchObject({ language: "yo", switched: false, explicit: false });
    expect(s.intake.language).toBe("yo");
  });

  it("explicit switch back to English works", () => {
    const s = fakeSession("pcm");
    const r = resolveTurnLanguage(s, "speak English");
    expect(r.language).toBe("en");
    expect(s.intake.language).toBe("en");
  });

  it("same-language detection is not a switch", () => {
    const s = fakeSession("ha");
    const r = resolveTurnLanguage(s, "Sannu, yaya kake? ina son taimako");
    expect(r).toMatchObject({ language: "ha", switched: false });
  });
});

// ─── Localized repair questions ──────────────────────────────────────────────

describe("repairQuestionFor localization", () => {
  it("English (no lang) is byte-identical to wave-9", () => {
    expect(repairQuestionFor("whatsapp: Graph API returned 403")).toBe(
      "I couldn't reach your WhatsApp phone number with the token on file. " +
        "Please re-paste your WhatsApp access token and phone number ID from Meta Business Settings → WhatsApp → API Setup.",
    );
    expect(repairQuestionFor("integration:odoo: connection refused")).toBe(
      "The odoo connection test failed. Please check the odoo URL and API key " +
        "in Settings → Integrations (or paste them here) and I'll try again.",
    );
  });

  it("renders in pcm/yo/ha/ig", () => {
    expect(repairQuestionFor("whatsapp: x", "pcm")).toContain("Abeg");
    expect(repairQuestionFor("whatsapp:waba: x", "yo")).toContain("WABA");
    expect(repairQuestionFor("integration:odoo: x", "ha")).toContain("odoo");
    expect(repairQuestionFor("other: boom", "ig")).toContain("other: boom");
  });
});

// ─── Service-level: greetings + intake in-language ───────────────────────────

describe("multilingual copilot service", () => {
  it("startSession defaults to the English greeting (byte-identical)", async () => {
    const { greeting } = await copilot.startSession({ channel: "admin" });
    expect(greeting).toBe(EN_PACK.greeting);
  });

  it("startSession with an explicit language greets in that language", async () => {
    const { greeting, sessionId } = await copilot.startSession({ channel: "whatsapp", phone: "+2348000000001", language: "yo" });
    expect(greeting).toBe(COPILOT_TEXT_PACKS.yo.greeting);
    const s = await getFresh(sessionId);
    expect(s.intake.language).toBe("yo");
  });

  it("detects Hausa on the first inbound message, replies in Hausa and persists it", async () => {
    const { sessionId } = await copilot.startSession({ channel: "whatsapp", phone: "+2348000000002" });
    const res = await copilot.postMessage({
      sessionId,
      text: "Sannu! Ina son in buɗe kantin sayar da kayayyaki a Kano don kasuwancina",
    });
    const s = await getFresh(sessionId);
    expect(s.intake.language).toBe("ha");
    const agentTexts = res.replies.map((r) => r.text).join("\n");
    expect(agentTexts).toBe(COPILOT_TEXT_PACKS.ha.askBusiness);
  });

  it("language persists across messages and reloads (low-confidence msg keeps ha)", async () => {
    const { sessionId } = await copilot.startSession({ channel: "whatsapp", phone: "+2348000000003" });
    await copilot.postMessage({ sessionId, text: "Sannu! Ina son in buɗe kantin kayayyaki a Kano, za ka iya taimako?" });
    expect((await getFresh(sessionId)).intake.language).toBe("ha");
    const res = await copilot.postMessage({ sessionId, text: "Kano Spice House" }); // name only — no signal
    expect(res.state).toBe("approving");
    const s = await getFresh(sessionId);
    expect(s.intake.language).toBe("ha");
    expect(s.intake.facts.businessName).toBe("Kano Spice House");
    // Proposal intro rendered in Hausa.
    expect(res.replies[0].text).toContain("{businessName}".length ? "Kano Spice House" : "");
    expect(res.replies[0].text).toBe(
      t("ha", "proposalIntro", { businessName: "Kano Spice House" }),
    );
  });

  it("mid-thread switch: a Pidgin message flips an English thread to pcm", async () => {
    const { sessionId } = await copilot.startSession({ channel: "admin" });
    const res1 = await copilot.postMessage({ sessionId, text: "how does this work?" });
    expect(res1.replies[0].text).toBe(EN_PACK.askBusiness);
    const res2 = await copilot.postMessage({
      sessionId,
      text: "Abeg, wetin you dey ask? I wan sell Ankara fabrics",
    });
    const s = await getFresh(sessionId);
    expect(s.intake.language).toBe("pcm");
    expect(res2.replies[0].text).toBe(COPILOT_TEXT_PACKS.pcm.askBusiness);
  });

  it("explicit 'speak Yoruba' switches the thread and confirms in Yoruba", async () => {
    const { sessionId } = await copilot.startSession({ channel: "admin" });
    const res = await copilot.postMessage({ sessionId, text: "speak Yoruba" });
    const s = await getFresh(sessionId);
    expect(s.intake.language).toBe("yo");
    expect(res.replies).toHaveLength(1);
    expect(res.replies[0].text).toBe(t("yo", "languageSwitched", { language: "Yorùbá" }));
    // Follow-up messages now answer in Yoruba.
    const res2 = await copilot.postMessage({ sessionId, text: "bawo ni?" });
    expect(res2.replies[0].text).toBe(COPILOT_TEXT_PACKS.yo.askBusiness);
  });

  it("decideProposal confirmations follow the session language", async () => {
    const { sessionId } = await copilot.startSession({ channel: "admin" });
    await copilot.postMessage({ sessionId, text: "speak Igbo" });
    await copilot.postMessage({ sessionId, text: "My business is called Oja Express, we sell food in Lagos and we deliver" });
    const s = await getFresh(sessionId);
    expect(s.proposals.length).toBeGreaterThanOrEqual(3);
    const first = s.proposals[0];
    const res = await copilot.decideProposal({ sessionId, proposalId: first.id, approve: true });
    expect(res.replies[0].text).toBe(t("ig", "decideApproved", { kind: first.kind }));
  });

  it("full onboarding thread e2e in Yoruba (LLM down → templates) reaches live", async () => {
    const { sessionId } = await copilot.startSession({ channel: "whatsapp", phone: "+2348000000004" });
    // 1) Yoruba intake message (diacritics + stopwords → yo).
    const res1 = await copilot.postMessage({
      sessionId,
      text: "Mo fẹ́ bẹ̀rẹ̀ iṣòwò aṣọ (fashion) mi ní Lagos, ṣe mo lè fi àṣẹ ránṣẹ́?",
    });
    const s1 = await getFresh(sessionId);
    expect(s1.intake.language).toBe("yo");
    expect(res1.replies[0].text).toBe(COPILOT_TEXT_PACKS.yo.askBusiness);
    // 2) Short reply → business name (no language signal → stays yo).
    const res2 = await copilot.postMessage({ sessionId, text: "Adire Atelier" });
    expect(res2.state).toBe("approving");
    expect(res2.replies[0].text).toBe(t("yo", "proposalIntro", { businessName: "Adire Atelier" }));
    const s2 = await getFresh(sessionId);
    expect(s2.intake.language).toBe("yo");
    // 3) Approve all → validation fails (no creds) → repair question in Yoruba.
    await approveAllProposals(sessionId);
    const s3 = await getFresh(sessionId);
    expect(s3.state).toBe("configuring");
    const lastAgent = s3.transcript.filter((x) => x.role === "agent").at(-1)!;
    expect(lastAgent.text).toBe(COPILOT_TEXT_PACKS.yo.repairWhatsapp);
    // 4) Supply creds → validating with go-live checkpoint in Yoruba.
    const res4 = await copilot.postMessage({ sessionId, text: CREDS_TEXT });
    const s4 = await getFresh(sessionId);
    expect(s4.state).toBe("validating");
    expect(res4.replies.some((r) => r.text === COPILOT_TEXT_PACKS.yo.goLiveReady)).toBe(true);
    // 5) go live → celebration in Yoruba.
    const res5 = await copilot.postMessage({ sessionId, text: "go live" });
    expect(res5.state).toBe("live");
    expect(res5.replies.some((r) => r.text === COPILOT_TEXT_PACKS.yo.live)).toBe(true);
    const s5 = await getFresh(sessionId);
    expect(s5.intake.language).toBe("yo");
  });

  it("full onboarding thread e2e in Pidgin (LLM down → templates) reaches live", async () => {
    const { sessionId } = await copilot.startSession({ channel: "whatsapp", phone: "+2348000000005" });
    const res1 = await copilot.postMessage({
      sessionId,
      text: "Abeg, I wan open my fashion shop for Lagos, we dey deliver anywhere",
    });
    const s1 = await getFresh(sessionId);
    expect(s1.intake.language).toBe("pcm");
    expect(res1.replies[0].text).toBe(COPILOT_TEXT_PACKS.pcm.askBusiness);
    const res2 = await copilot.postMessage({ sessionId, text: "Mama Ngozi Stores" });
    expect(res2.state).toBe("approving");
    expect(res2.replies[0].text).toBe(t("pcm", "proposalIntro", { businessName: "Mama Ngozi Stores" }));
    // Card action labels localized in pcm.
    const card = res2.replies.find((r) => r.type === "card");
    expect(card?.actions?.map((a) => a.label)).toEqual([
      COPILOT_TEXT_PACKS.pcm.actionApprove,
      COPILOT_TEXT_PACKS.pcm.actionEdit,
      COPILOT_TEXT_PACKS.pcm.actionReject,
    ]);
    await approveAllProposals(sessionId);
    const s3 = await getFresh(sessionId);
    expect(s3.state).toBe("configuring");
    const res4 = await copilot.postMessage({ sessionId, text: CREDS_TEXT });
    expect((await getFresh(sessionId)).state).toBe("validating");
    expect(res4.replies.some((r) => r.text === COPILOT_TEXT_PACKS.pcm.goLiveReady)).toBe(true);
    const res5 = await copilot.postMessage({ sessionId, text: "go live" });
    expect(res5.state).toBe("live");
    expect(res5.replies.some((r) => r.text === COPILOT_TEXT_PACKS.pcm.live)).toBe(true);
  });

  it("merchant switches language mid-thread and the copilot follows", async () => {
    const { sessionId } = await copilot.startSession({ channel: "admin" });
    await copilot.postMessage({ sessionId, text: "how does this work?" });
    const res = await copilot.postMessage({
      sessionId,
      text: "Kedu, ị nwere ike ịkọwakwa ya m? achọrọ m azụmahịa",
    });
    const s = await getFresh(sessionId);
    expect(s.intake.language).toBe("ig");
    expect(res.replies[0].text).toBe(COPILOT_TEXT_PACKS.ig.askBusiness);
    // Switch back to Pidgin.
    const res2 = await copilot.postMessage({ sessionId, text: "Abeg switch to pidgin" });
    expect((await getFresh(sessionId)).intake.language).toBe("pcm");
    expect(res2.replies[0].text).toBe(t("pcm", "languageSwitched", { language: "Nigerian Pidgin" }));
  });

  it("en regression: full thread stays byte-identical to wave-9", async () => {
    const { sessionId } = await copilot.startSession({ channel: "admin" });
    const res1 = await copilot.postMessage({ sessionId, text: "how does this work?" });
    expect(res1.replies[0].text).toBe(EN_PACK.askBusiness);
    const res2 = await copilot.postMessage({
      sessionId,
      text: "My business is called Adire Atelier, we sell fashion in Lagos and we deliver",
    });
    expect(res2.state).toBe("approving");
    expect(res2.replies[0].text).toBe(
      "Here's the setup I propose for Adire Atelier. " +
        "Review each card — approve, edit or reject. Nothing is applied until you approve it.",
    );
    const card = res2.replies.find((r) => r.type === "card");
    expect(card?.actions?.map((a) => a.label)).toEqual(["Approve", "Edit", "Reject"]);
    await approveAllProposals(sessionId);
    const res3 = await copilot.postMessage({ sessionId, text: CREDS_TEXT });
    expect(res3.replies.some((r) => r.text === EN_PACK.goLiveReady)).toBe(true);
    const res4 = await copilot.postMessage({ sessionId, text: "go live" });
    expect(res4.replies.some((r) => r.text === EN_PACK.live)).toBe(true);
    const res5 = await copilot.postMessage({ sessionId, text: "anything" });
    expect(res5.replies[0].text).toBe(EN_PACK.liveHint);
  });

  it("fr thread: greeting and intake question in French", async () => {
    const { sessionId, greeting } = await copilot.startSession({ channel: "admin", language: "fr" });
    expect(greeting).toBe(COPILOT_TEXT_PACKS.fr.greeting);
    const res = await copilot.postMessage({ sessionId, text: "comment ça marche?" });
    expect(res.replies[0].text).toBe(COPILOT_TEXT_PACKS.fr.askBusiness);
  });

  it("unknown-language text stays in the current language (en by default)", async () => {
    const { sessionId } = await copilot.startSession({ channel: "admin" });
    const res = await copilot.postMessage({ sessionId, text: "zzzzz qqqqq?" });
    const s = await getFresh(sessionId);
    expect(s.intake.language ?? "en").toBe("en");
    expect(res.replies[0].text).toBe(EN_PACK.askBusiness);
  });
});
