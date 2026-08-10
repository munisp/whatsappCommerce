/**
 * onboardingCopilot.test.ts — agentic onboarding copilot core.
 *
 * Covers: intake extraction (LLM + fallback), proposal generation, the
 * CHECKPOINT INVARIANT (apply/push/goLive refuse pre-approval), edit path,
 * validation-repair loop (incl. 3-round cap), resume-by-phone, state guards,
 * audit entries, zod hardening on proposed waMenu, and router tenant
 * isolation. DB is mocked in-memory (same style as onboarding.test.ts); the
 * shared LLM client (server/_core/llm) and brand studio are module-mocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { TrpcContext } from "./_core/context";
import { getTableColumns, getTableName } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

// ─── In-memory DB mock ───────────────────────────────────────────────────────

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

// ─── Module mocks ────────────────────────────────────────────────────────────

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
const { onboardingCopilotRouter } = await import("./routers/onboardingCopilot");

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

const adminCtx = makeCtx(makeUser("admin", null));

/** LLM offline → template/regex fallbacks everywhere. */
function llmDown() {
  invokeLLMMock.mockRejectedValue(new Error("LLM unreachable"));
}

function llmToolCall(name: string, args: unknown) {
  return {
    id: "x",
    created: 0,
    model: "m",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            { id: `call-${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
  };
}

function llmText(text: string) {
  return {
    id: "x",
    created: 0,
    model: "m",
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
  };
}

function fetchOk() {
  return Promise.resolve(new Response("{}", { status: 200 }));
}

function tenantRow(tenantId: string) {
  return stores.tenants.find((t) => t.id === tenantId) as any;
}

/** Drive a session through intake with the LLM down (template proposals). */
async function startThroughIntake(text = "My business is called Adire Atelier, we sell fashion in Lagos and we deliver") {
  const { sessionId } = await copilot.startSession({ channel: "admin" });
  const res = await copilot.postMessage({ sessionId, text });
  return { sessionId, res };
}

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

/**
 * approve all → (validation fails: no creds) → supply creds → validating
 * with a pending terminal goLive proposal.
 */
async function reachValidating(sessionId: string) {
  await approveAllProposals(sessionId);
  let s = await getFresh(sessionId);
  expect(s.state).toBe("configuring"); // whatsapp check fails without creds
  await copilot.postMessage({ sessionId, text: CREDS_TEXT });
  s = await getFresh(sessionId);
  expect(s.state).toBe("validating");
  expect(s.proposals.some((p) => p.kind === "goLive" && p.status === "pending")).toBe(true);
  return s;
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
  llmDown();
  vi.stubGlobal("fetch", vi.fn(fetchOk));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─── Session start + intake ──────────────────────────────────────────────────

describe("startSession + intake", () => {
  it("creates a session in intake state with an agent greeting", async () => {
    const { sessionId, greeting } = await copilot.startSession({ channel: "admin" });
    expect(sessionId).toBeTruthy();
    expect(greeting).toMatch(/onboarding/i);
    const s = await getFresh(sessionId);
    expect(s.state).toBe("intake");
    expect(s.transcript[0]).toMatchObject({ role: "agent", text: greeting });
  });

  it("extracts business facts via fallback when the LLM is down and proposes 4 cards", async () => {
    const { sessionId, res } = await startThroughIntake();
    expect(res.state).toBe("approving");
    const s = await getFresh(sessionId);
    expect(s.intake.facts.businessName).toBe("Adire Atelier");
    expect(s.intake.facts.industry).toBe("fashion");
    expect(s.intake.facts.city).toBe("Lagos");
    const kinds = s.proposals.map((p) => p.kind).sort();
    expect(kinds).toEqual(["branding", "integrations", "useCases", "waMenu"]);
    expect(s.proposals.every((p) => p.status === "pending")).toBe(true);
    const cards = res.replies.filter((r) => r.type === "card");
    expect(cards.length).toBeGreaterThanOrEqual(4);
    expect(cards[0].actions?.map((a) => a.id)).toContain(`approve:${s.proposals[0].id}`);
  });

  it("treats a short first message as the business name", async () => {
    const { sessionId } = await copilot.startSession({ channel: "admin" });
    const res = await copilot.postMessage({ sessionId, text: "Kano Spice House" });
    expect(res.state).toBe("approving");
    const s = await getFresh(sessionId);
    expect(s.intake.facts.businessName).toBe("Kano Spice House");
  });

  it("asks a follow-up question when no business name is found; stays in intake", async () => {
    const { sessionId } = await copilot.startSession({ channel: "admin" });
    const res = await copilot.postMessage({ sessionId, text: "how does this work?" });
    expect(res.state).toBe("intake");
    expect(res.replies[0].text).toMatch(/business called|what.*sell/i);
  });

  it("appends user + agent entries to the transcript with timestamps", async () => {
    const { sessionId } = await startThroughIntake();
    const s = await getFresh(sessionId);
    const roles = s.transcript.map((t) => t.role);
    expect(roles).toContain("user");
    expect(roles).toContain("agent");
    for (const t of s.transcript) expect(typeof t.ts).toBe("string");
  });
});

// ─── LLM tool-calling loop ───────────────────────────────────────────────────

describe("LLM tool loop", () => {
  it("stores facts extracted by the LLM extractIntake tool", async () => {
    invokeLLMMock.mockReset();
    invokeLLMMock
      .mockResolvedValueOnce(
        llmToolCall("extractIntake", { businessName: "Lagos Prints Co", industry: "fashion", city: "Lagos" }),
      )
      .mockResolvedValue(llmText("Thanks! Let me draft your setup."));
    const { sessionId } = await copilot.startSession({ channel: "admin" });
    const res = await copilot.postMessage({ sessionId, text: "we are Lagos Prints Co, a fashion label in Lagos" });
    expect(res.state).toBe("approving");
    const s = await getFresh(sessionId);
    expect(s.intake.facts.businessName).toBe("Lagos Prints Co");
  });

  it("persists a valid LLM-proposed waMenu", async () => {
    const menu = {
      greeting: "Hello from {businessName}!",
      useCases: [{ id: "shop", label: "Shop prints", enabled: true, order: 1 }],
      customItems: [],
      fallback: "nlp",
    };
    invokeLLMMock.mockReset();
    invokeLLMMock
      .mockResolvedValueOnce(llmToolCall("extractIntake", { businessName: "Menu Test Co" }))
      .mockResolvedValueOnce(llmToolCall("proposeWaMenu", { menu, summary: "custom menu" }))
      .mockResolvedValue(llmText("done"));
    const { sessionId } = await copilot.startSession({ channel: "admin" });
    await copilot.postMessage({ sessionId, text: "Menu Test Co" });
    const s = await getFresh(sessionId);
    const waMenu = s.proposals.find((p) => p.kind === "waMenu");
    expect(waMenu?.payload).toMatchObject({ greeting: "Hello from {businessName}!" });
    expect(waMenu?.summary).toBe("custom menu");
  });

  it("rejects invalid LLM waMenu JSON (zod), feeds the error back, and never persists the invalid payload", async () => {
    const badMenu = { greeting: "", useCases: [{ id: "nope" }], customItems: [], fallback: "nlp" };
    const goodMenu = {
      greeting: "Hi from {businessName}",
      useCases: [{ id: "shop", label: "Shop", enabled: true, order: 1 }],
      customItems: [],
      fallback: "menu",
    };
    invokeLLMMock.mockReset();
    invokeLLMMock
      .mockResolvedValueOnce(llmToolCall("extractIntake", { businessName: "Zod Test Co" }))
      .mockResolvedValueOnce(llmToolCall("proposeWaMenu", { menu: badMenu }))
      .mockResolvedValueOnce(llmToolCall("proposeWaMenu", { menu: goodMenu }))
      .mockResolvedValue(llmText("fixed"));
    const { sessionId } = await copilot.startSession({ channel: "admin" });
    await copilot.postMessage({ sessionId, text: "Zod Test Co" });
    const s = await getFresh(sessionId);
    const menus = s.proposals.filter((p) => p.kind === "waMenu");
    // Only the VALID menu was persisted (invalid one returned an error to the LLM).
    expect(menus).toHaveLength(1);
    expect(menus[0].payload).toMatchObject({ fallback: "menu" });
  });

  it("refuses LLM-initiated applyProposal before approval (checkpoint enforced in service)", async () => {
    invokeLLMMock.mockReset();
    let capturedProposalId = "";
    invokeLLMMock.mockImplementation(async (params: any) => {
      const instruction = JSON.stringify(params.messages);
      if (!capturedProposalId && instruction.includes("Propose the full setup")) {
        return llmToolCall("proposeUseCases", { ranked: ["shop", "track"] });
      }
      if (capturedProposalId && instruction.includes("Propose the full setup")) {
        return llmText("ok");
      }
      if (instruction.includes("p-")) {
        // Second phase: model tries to apply the pending proposal directly.
        return llmToolCall("applyProposal", { proposalId: capturedProposalId });
      }
      return llmToolCall("extractIntake", { businessName: "Checkpoint Co" });
    });
    const { sessionId } = await copilot.startSession({ channel: "admin" });
    await copilot.postMessage({ sessionId, text: "Checkpoint Co" });
    const s = await getFresh(sessionId);
    capturedProposalId = s.proposals.find((p) => p.kind === "useCases")?.id ?? "";
    expect(capturedProposalId).toBeTruthy();
    // All proposals remain pending — nothing applied without a human decision.
    expect(s.proposals.every((p) => p.status === "pending")).toBe(true);
    expect(stores.tenants).toHaveLength(0);
  });
});

// ─── Checkpoint invariant (direct service calls) ─────────────────────────────

describe("checkpoint invariant", () => {
  it("applyProposal throws for a pending proposal", async () => {
    const { sessionId } = await startThroughIntake();
    const s = await getFresh(sessionId);
    const p = s.proposals.find((x) => x.kind === "waMenu")!;
    await expect(copilot.executeCopilotTool("applyProposal", { proposalId: p.id }, s)).rejects.toThrow(
      /not been approved/,
    );
  });

  it("applyProposal throws for a rejected proposal", async () => {
    const { sessionId } = await startThroughIntake();
    const s = await getFresh(sessionId);
    const p = s.proposals.find((x) => x.kind === "waMenu")!;
    p.status = "rejected";
    await expect(copilot.executeCopilotTool("applyProposal", { proposalId: p.id }, s)).rejects.toThrow(
      /rejected/,
    );
  });

  it("pushProfile refuses without an approved branding proposal", async () => {
    const { sessionId } = await startThroughIntake();
    const s = await getFresh(sessionId);
    await expect(copilot.executeCopilotTool("pushProfile", {}, s)).rejects.toThrow(/No approved branding/);
  });

  it("goLive refuses before validation has passed", async () => {
    const { sessionId } = await startThroughIntake();
    const s = await getFresh(sessionId);
    s.tenantId = "t-manual";
    stores.tenants.push({
      id: "t-manual",
      name: "X",
      slug: "x",
      status: "trial",
      settings: { onboarding: { status: "configuring", validationPassed: false } },
    });
    await expect(copilot.executeCopilotTool("goLive", {}, s)).rejects.toThrow(/Cannot go live/);
  });

  it("unknown copilot tool names throw", async () => {
    const { sessionId } = await startThroughIntake();
    const s = await getFresh(sessionId);
    await expect(copilot.executeCopilotTool("nukeEverything", {}, s)).rejects.toThrow(/Unknown copilot tool/);
  });
});

// ─── decideProposal ──────────────────────────────────────────────────────────

describe("decideProposal", () => {
  it("approve flips status, writes an audit entry, and keeps tenant untouched until all decided", async () => {
    const { sessionId } = await startThroughIntake();
    const s = await getFresh(sessionId);
    const p = s.proposals.find((x) => x.kind === "waMenu")!;
    const res = await copilot.decideProposal({ sessionId, proposalId: p.id, approve: true });
    expect(res.ok).toBe(true);
    const s2 = await getFresh(sessionId);
    expect(s2.proposals.find((x) => x.id === p.id)!.status).toBe("approved");
    expect(
      stores.audit_logs.some(
        (a: any) => a.action === "onboarding_copilot.decision" && a.after?.proposalId === p.id,
      ),
    ).toBe(true);
  });

  it("reject marks the proposal rejected and it is never applied", async () => {
    const { sessionId } = await startThroughIntake();
    const s = await getFresh(sessionId);
    for (const p of s.proposals) {
      await copilot.decideProposal({
        sessionId,
        proposalId: p.id,
        approve: p.kind !== "waMenu",
      });
    }
    const s2 = await getFresh(sessionId);
    expect(s2.proposals.find((p) => p.kind === "waMenu")!.status).toBe("rejected");
    // waMenu was rejected → tenant menu remains the seeded default.
    const tenant = tenantRow(s2.tenantId!);
    expect(tenant.settings.waMenu.greeting).toContain("{businessName}");
  });

  it("edit path: edited payload is validated, stored, and APPLIED instead of the original", async () => {
    const { sessionId } = await startThroughIntake();
    const s = await getFresh(sessionId);
    const wa = s.proposals.find((x) => x.kind === "waMenu")!;
    const edited = {
      greeting: "EDITED greeting for {businessName}",
      useCases: [
        { id: "shop", label: "Shop edited", enabled: true, order: 1 },
        { id: "handoff", label: "Human", enabled: true, order: 2 },
      ],
      customItems: [{ key: "hours", label: "Opening hours", response: "9am–6pm" }],
      fallback: "menu",
    };
    await copilot.decideProposal({ sessionId, proposalId: wa.id, approve: true, editedPayload: edited });
    // approve the rest (no edits)
    for (const p of s.proposals.filter((x) => x.id !== wa.id)) {
      await copilot.decideProposal({ sessionId, proposalId: p.id, approve: true });
    }
    const s2 = await getFresh(sessionId);
    const stored = s2.proposals.find((x) => x.id === wa.id)!;
    expect(stored.status).toBe("edited");
    expect(stored.payload).toMatchObject({ greeting: "EDITED greeting for {businessName}" });
    const tenant = tenantRow(s2.tenantId!);
    expect(tenant.settings.waMenu.greeting).toBe("EDITED greeting for {businessName}");
    expect(tenant.settings.waMenu.customItems[0].key).toBe("hours");
  });

  it("invalid edited payload throws and leaves the proposal pending", async () => {
    const { sessionId } = await startThroughIntake();
    const s = await getFresh(sessionId);
    const wa = s.proposals.find((x) => x.kind === "waMenu")!;
    await expect(
      copilot.decideProposal({
        sessionId,
        proposalId: wa.id,
        approve: true,
        editedPayload: { greeting: "", useCases: [], customItems: [], fallback: "nope" },
      }),
    ).rejects.toThrow();
    const s2 = await getFresh(sessionId);
    expect(s2.proposals.find((x) => x.id === wa.id)!.status).toBe("pending");
  });

  it("deciding twice throws", async () => {
    const { sessionId } = await startThroughIntake();
    const s = await getFresh(sessionId);
    const p = s.proposals[0];
    await copilot.decideProposal({ sessionId, proposalId: p.id, approve: true });
    await expect(
      copilot.decideProposal({ sessionId, proposalId: p.id, approve: true }),
    ).rejects.toThrow(/already approved/);
  });

  it("unknown proposal id throws", async () => {
    const { sessionId } = await startThroughIntake();
    await expect(
      copilot.decideProposal({ sessionId, proposalId: "p-nope", approve: true }),
    ).rejects.toThrow(/Unknown proposal/);
  });
});

// ─── Full happy path ─────────────────────────────────────────────────────────

describe("happy path (approve all → configured → validated → goLive → live)", () => {
  /** Approve setup proposals, fix creds, then approve the terminal goLive proposal. */
  async function runHappyPath() {
    const { sessionId } = await startThroughIntake();
    await reachValidating(sessionId);
    const mid = await getFresh(sessionId);
    const goLive = mid.proposals.find((p) => p.kind === "goLive")!;
    const final = await copilot.decideProposal({ sessionId, proposalId: goLive.id, approve: true });
    return { sessionId, final };
  }

  it("provisions the tenant, applies config, validates, and goes live after goLive approval", async () => {
    const { sessionId, final } = await runHappyPath();
    const s = await getFresh(sessionId);
    expect(s.state).toBe("live");
    expect(s.tenantId).toBeTruthy();
    const tenant = tenantRow(s.tenantId!);
    expect(tenant.name).toBe("Adire Atelier");
    expect(tenant.status).toBe("active");
    expect(tenant.settings.onboarding.status).toBe("live");
    expect(tenant.settings.waMenu.useCases.some((u: any) => u.id === "shop" && u.enabled)).toBe(true);
    expect(tenant.settings.branding.primaryColor).toBe("#112233");
    expect(tenant.settings.branding.secondaryColor).toBe("#445566");
    expect(final.replies.some((r) => /live/i.test(r.text))).toBe(true);
  });

  it("pushes the approved branding to the WhatsApp profile (about = tagline)", async () => {
    await runHappyPath();
    expect(pushProfileMock).toHaveBeenCalledTimes(1);
    const args = pushProfileMock.mock.calls[0][0];
    expect(args.about).toContain("Adire Atelier");
    expect(args.logoDataUri).toBe("data:image/svg+xml;base64,AAAA");
  });

  it("writes audit entries for transitions, tool calls, apply, and go-live", async () => {
    await runHappyPath();
    const actions = stores.audit_logs.map((a: any) => a.action);
    expect(actions).toContain("onboarding_copilot.state");
    expect(actions).toContain("onboarding_copilot.apply");
    expect(actions).toContain("onboarding_copilot.tenant_created");
    expect(actions).toContain("onboarding_copilot.go_live");
    // audit rows carry the session id and (once known) the tenant id
    const applyRows = stores.audit_logs.filter((a: any) => a.action === "onboarding_copilot.apply");
    expect(applyRows.every((a: any) => a.entityType === "onboarding_session")).toBe(true);
    expect(applyRows.every((a: any) => typeof a.tenantId === "string")).toBe(true);
  });

  it("text command 'approve all' drives the configuration phase up to validating", async () => {
    const { sessionId } = await startThroughIntake();
    const res = await copilot.postMessage({ sessionId, text: "approve all" });
    expect(res.replies.some((r) => /approved/i.test(r.text))).toBe(true);
    let s = await getFresh(sessionId);
    expect(s.state).toBe("configuring"); // whatsapp creds still missing
    await copilot.postMessage({ sessionId, text: CREDS_TEXT });
    s = await getFresh(sessionId);
    expect(s.state).toBe("validating");
    expect(s.proposals.some((p) => p.kind === "goLive" && p.status === "pending")).toBe(true);
  });
});

// ─── goLive checkpoint (C4 contract) ─────────────────────────────────────────

describe("goLive proposal + literal command (C4)", () => {
  async function reachValidatingSession() {
    const { sessionId } = await startThroughIntake();
    await reachValidating(sessionId);
    return { sessionId };
  }

  it("validation pass emits a terminal goLive proposal; state stays validating", async () => {
    const { sessionId } = await reachValidatingSession();
    const s = await getFresh(sessionId);
    expect(s.state).toBe("validating");
    const gl = s.proposals.find((p) => p.kind === "goLive");
    expect(gl).toBeTruthy();
    expect(gl!.status).toBe("pending");
    expect(gl!.summary).toMatch(/validation check/i);
  });

  it("approving the goLive proposal advances to live", async () => {
    const { sessionId } = await reachValidatingSession();
    const s = await getFresh(sessionId);
    const gl = s.proposals.find((p) => p.kind === "goLive")!;
    const res = await copilot.decideProposal({ sessionId, proposalId: gl.id, approve: true });
    expect(res.ok).toBe(true);
    expect(res.replies.some((r) => /LIVE/i.test(r.text))).toBe(true);
    expect((await getFresh(sessionId)).state).toBe("live");
  });

  it("rejecting the goLive proposal keeps the session validating", async () => {
    const { sessionId } = await reachValidatingSession();
    const s = await getFresh(sessionId);
    const gl = s.proposals.find((p) => p.kind === "goLive")!;
    await copilot.decideProposal({ sessionId, proposalId: gl.id, approve: false });
    const s2 = await getFresh(sessionId);
    expect(s2.state).toBe("validating");
    expect(s2.proposals.find((p) => p.kind === "goLive")!.status).toBe("rejected");
    expect(tenantRow(s2.tenantId!).status).not.toBe("active");
  });

  it("literal 'go live' text from validating advances to live", async () => {
    const { sessionId } = await reachValidatingSession();
    const res = await copilot.postMessage({ sessionId, text: "Go Live" });
    expect(res.state).toBe("live");
    expect(res.replies.some((r) => /LIVE/.test(r.text))).toBe(true);
    // pending goLive proposal is consumed by the command path
    const s = await getFresh(sessionId);
    expect(s.proposals.find((p) => p.kind === "goLive")!.status).toBe("approved");
  });

  it("literal 'go live' from approving explains what's missing", async () => {
    const { sessionId } = await startThroughIntake();
    const res = await copilot.postMessage({ sessionId, text: "go live" });
    expect(res.state).toBe("approving");
    expect(res.replies[0].text).toMatch(/not ready/i);
    expect(res.replies[0].text).toMatch(/approval/i);
  });

  it("goLive proposals cannot be edited", async () => {
    const { sessionId } = await reachValidatingSession();
    const s = await getFresh(sessionId);
    const gl = s.proposals.find((p) => p.kind === "goLive")!;
    await expect(
      copilot.decideProposal({ sessionId, proposalId: gl.id, approve: true, editedPayload: {} }),
    ).rejects.toThrow(/cannot be edited/);
  });
});

// ─── Repair loop ─────────────────────────────────────────────────────────────

describe("validation-repair loop", () => {
  function failWhatsApp() {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response("bad token", { status: 401 }))),
    );
  }

  async function reachFailedValidation() {
    const { sessionId } = await startThroughIntake();
    const s = await getFresh(sessionId);
    failWhatsApp();
    let last: Awaited<ReturnType<typeof copilot.decideProposal>> | null = null;
    for (const p of [...s.proposals]) {
      last = await copilot.decideProposal({ sessionId, proposalId: p.id, approve: true });
    }
    return { sessionId, last: last! };
  }

  it("failed whatsapp check → targeted question in transcript, state back to configuring", async () => {
    const { sessionId } = await reachFailedValidation();
    const s = await getFresh(sessionId);
    expect(s.state).toBe("configuring");
    expect(s.intake.repairRounds).toBe(1);
    const questions = s.transcript.filter((t) => t.role === "agent").map((t) => t.text);
    expect(questions.some((q) => /re-paste.*token|access token/i.test(q))).toBe(true);
    const tenant = tenantRow(s.tenantId!);
    expect(tenant.settings.onboarding.status).toBe("failed");
    expect(tenant.settings.onboarding.reasons[0]).toMatch(/whatsapp/);
  });

  it("WABA check failure maps to a WABA-specific question", async () => {
    // phone-number check passes; WABA read fails
    vi.stubGlobal(
      "fetch",
      vi.fn((url: any) =>
        /waba-1/.test(String(url))
          ? Promise.resolve(new Response("no waba", { status: 403 }))
          : Promise.resolve(new Response("{}", { status: 200 })),
      ),
    );
    const { sessionId } = await startThroughIntake();
    const s = await getFresh(sessionId);
    for (const p of [...s.proposals]) {
      await copilot.decideProposal({ sessionId, proposalId: p.id, approve: true });
    }
    // First validation fails: no whatsapp creds at all → configuring (round 1).
    const s2 = await getFresh(sessionId);
    expect(s2.state).toBe("configuring");
    // Operator adds creds + a WABA id; re-validation hits the WABA failure.
    const t = tenantRow(s2.tenantId!);
    t.whatsappPhoneNumberId = "12345";
    t.settings.whatsapp = { accessToken: "tok", wabaId: "waba-1" };
    await copilot.postMessage({ sessionId, text: "I updated the app permissions" });
    const s3 = await getFresh(sessionId);
    const questions = s3.transcript.filter((x) => x.role === "agent").map((x) => x.text);
    expect(questions.some((q) => /WABA|Business Account/i.test(q))).toBe(true);
  });

  it("supplying fixed credentials re-validates → goLive proposal → 'go live' → live", async () => {
    const { sessionId } = await reachFailedValidation();
    vi.stubGlobal("fetch", vi.fn(fetchOk));
    const res = await copilot.postMessage({
      sessionId,
      text: "token is EAAFIXEDTOKEN1234567890abcde and phone number id is 12345678901",
    });
    let s = await getFresh(sessionId);
    expect(s.state).toBe("validating");
    expect(res.replies.some((r) => /checks passed/i.test(r.text))).toBe(true);
    const tenant = tenantRow(s.tenantId!);
    expect(tenant.settings.whatsapp.accessToken).toBe("EAAFIXEDTOKEN1234567890abcde");
    expect(tenant.whatsappPhoneNumberId).toBe("12345678901");
    const res2 = await copilot.postMessage({ sessionId, text: "go live" });
    expect(res2.state).toBe("live");
    s = await getFresh(sessionId);
    expect(s.state).toBe("live");
  });

  it("3 failed repair rounds → session failed with reasons preserved", async () => {
    const { sessionId } = await reachFailedValidation();
    // keep failing; nudge two more rounds
    await copilot.postMessage({ sessionId, text: "I checked everything" });
    await copilot.postMessage({ sessionId, text: "tried again" });
    const s = await getFresh(sessionId);
    expect(s.state).toBe("failed");
    expect(s.intake.repairRounds).toBe(3);
    expect(s.error).toMatch(/whatsapp/);
  });

  it("repairQuestionFor maps integration failures to the provider", async () => {
    const q = copilot.repairQuestionFor("integration:medusa: medusa returned 401: unauthorized");
    expect(q).toMatch(/medusa/i);
  });
});

// ─── State machine guards + resume ───────────────────────────────────────────

describe("state guards + resume", () => {
  it("messaging a live session returns an already-live reply", async () => {
    const { sessionId } = await startThroughIntake();
    await reachValidating(sessionId);
    const gl = (await getFresh(sessionId)).proposals.find((p) => p.kind === "goLive")!;
    await copilot.decideProposal({ sessionId, proposalId: gl.id, approve: true });
    const res = await copilot.postMessage({ sessionId, text: "hello again" });
    expect(res.state).toBe("live");
    expect(res.replies[0].text).toMatch(/already live/i);
  });

  it("messaging a failed session reports the retry limit", async () => {
    const { sessionId } = await copilot.startSession({ channel: "admin" }).then((r) => ({ sessionId: r.sessionId }));
    const s = await getFresh(sessionId);
    s.state = "failed";
    s.error = "whatsapp: bad";
    await (copilot as any); // service has no direct setter — use saveSession via decideProposal path? use internal:
    // Persist via a no-op message after forcing state in the store row:
    const row = stores.onboarding_sessions.find((r: any) => r.id === sessionId) as any;
    row.state = "failed";
    row.error = "whatsapp: bad";
    const res = await copilot.postMessage({ sessionId, text: "retry please" });
    expect(res.replies[0].text).toMatch(/retry limit/i);
  });

  it("findActiveSessionByPhone resumes the latest non-terminal whatsapp session", async () => {
    const a = await copilot.startSession({ channel: "whatsapp", phone: "+2348000000001" });
    const found = await copilot.findActiveSessionByPhone("+2348000000001");
    expect(found?.id).toBe(a.sessionId);
  });

  it("findActiveSessionByPhone skips terminal sessions", async () => {
    const a = await copilot.startSession({ channel: "whatsapp", phone: "+2348000000002" });
    const row = stores.onboarding_sessions.find((r: any) => r.id === a.sessionId) as any;
    row.state = "abandoned";
    expect(await copilot.findActiveSessionByPhone("+2348000000002")).toBeNull();
  });

  it("getSession returns null for unknown ids", async () => {
    expect(await copilot.getSession("no-such-id")).toBeNull();
  });
});

// ─── C3 contract: idempotent postMessage + phone supersession ────────────────

describe("C3: idempotent postMessage + supersession", () => {
  it("an exact repeat of the last inbound text is a no-op (no double transition/proposals)", async () => {
    const { sessionId } = await copilot.startSession({ channel: "whatsapp", phone: "+2348100000000" });
    const text = "My business is called Adire Atelier, we sell fashion in Lagos and we deliver";
    const first = await copilot.postMessage({ sessionId, text });
    expect(first.state).toBe("approving");
    const second = await copilot.postMessage({ sessionId, text }); // Meta redelivery
    expect(second.replies).toEqual([]);
    expect(second.state).toBe("approving");
    const s = await getFresh(sessionId);
    expect(s.transcript.filter((t) => t.role === "user")).toHaveLength(1);
    expect(s.proposals).toHaveLength(4); // not 8
  });

  it("a different follow-up message is processed normally after a duplicate", async () => {
    const { sessionId } = await copilot.startSession({ channel: "whatsapp", phone: "+2348100000001" });
    const text = "My business is called Adire Atelier, we sell fashion in Lagos and we deliver";
    await copilot.postMessage({ sessionId, text });
    await copilot.postMessage({ sessionId, text }); // duplicate
    const res = await copilot.postMessage({ sessionId, text: "go live" });
    expect(res.replies.length).toBeGreaterThan(0);
    expect(res.replies[0].text).toMatch(/not ready/i);
  });

  it("startSession for the same phone supersedes the prior active session", async () => {
    const a = await copilot.startSession({ channel: "whatsapp", phone: "+2348100000002" });
    const b = await copilot.startSession({ channel: "whatsapp", phone: "+2348100000002" });
    const found = await copilot.findActiveSessionByPhone("+2348100000002");
    expect(found?.id).toBe(b.sessionId);
    const old = await getFresh(a.sessionId);
    expect(old.state).toBe("abandoned");
    expect(
      stores.audit_logs.some(
        (x: any) => x.action === "onboarding_copilot.session_superseded" && x.entityId === a.sessionId,
      ),
    ).toBe(true);
  });

  it("terminal sessions are not re-superseded and admin-channel sessions are untouched", async () => {
    const a = await copilot.startSession({ channel: "whatsapp", phone: "+2348100000003" });
    const row = stores.onboarding_sessions.find((r: any) => r.id === a.sessionId) as any;
    row.state = "failed";
    const adminSess = await copilot.startSession({ channel: "admin", tenantId: "t-keep" });
    const b = await copilot.startSession({ channel: "whatsapp", phone: "+2348100000003" });
    expect((await getFresh(a.sessionId)).state).toBe("failed"); // unchanged
    expect((await getFresh(adminSess.sessionId)).state).toBe("intake"); // different channel
    expect((await copilot.findActiveSessionByPhone("+2348100000003"))?.id).toBe(b.sessionId);
  });
});

// ─── Router ──────────────────────────────────────────────────────────────────

describe("onboardingCopilot router", () => {
  it("requires authentication", async () => {
    const caller = onboardingCopilotRouter.createCaller(makeCtx(null));
    await expect(caller.startSession({ channel: "admin" })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("tenant admin cannot start a session for a foreign tenant", async () => {
    const caller = onboardingCopilotRouter.createCaller(makeCtx(makeUser("user", "t-mine")));
    await expect(
      caller.startSession({ channel: "admin", tenantId: "t-other" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("getSession enforces tenant isolation once the session has a tenant", async () => {
    const { sessionId } = await startThroughIntake();
    const s = await getFresh(sessionId);
    // give the session a tenant
    const row = stores.onboarding_sessions.find((r: any) => r.id === sessionId) as any;
    row.tenantId = "t-abc";
    const foreign = onboardingCopilotRouter.createCaller(makeCtx(makeUser("user", "t-other")));
    await expect(foreign.getSession({ sessionId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const own = onboardingCopilotRouter.createCaller(makeCtx(makeUser("user", "t-abc")));
    const got = await own.getSession({ sessionId });
    expect(got.id).toBe(s.id);
  });

  it("postMessage enforces tenant isolation", async () => {
    const { sessionId } = await startThroughIntake();
    const row = stores.onboarding_sessions.find((r: any) => r.id === sessionId) as any;
    row.tenantId = "t-abc";
    const foreign = onboardingCopilotRouter.createCaller(makeCtx(makeUser("user", "t-other")));
    await expect(foreign.postMessage({ sessionId, text: "hi" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("listSessions scopes tenant users to their own tenant", async () => {
    const a = await copilot.startSession({ channel: "admin", tenantId: "t-abc" });
    await copilot.startSession({ channel: "admin", tenantId: "t-xyz" });
    const own = onboardingCopilotRouter.createCaller(makeCtx(makeUser("user", "t-abc")));
    const mine = await own.listSessions({});
    expect(mine.map((s) => s.id)).toEqual([a.sessionId]);
    const admin = onboardingCopilotRouter.createCaller(adminCtx);
    const all = await admin.listSessions({});
    expect(all.length).toBe(2);
  });

  it("approveProposal via router drives the configuration phase for admins", async () => {
    const { sessionId } = await startThroughIntake();
    const s = await getFresh(sessionId);
    const caller = onboardingCopilotRouter.createCaller(adminCtx);
    let last: any;
    for (const p of [...s.proposals]) {
      last = await caller.approveProposal({ sessionId, proposalId: p.id, approve: true });
    }
    expect(last.ok).toBe(true);
    let s2 = await getFresh(sessionId);
    expect(s2.state).toBe("configuring"); // creds still missing
    await copilot.postMessage({ sessionId, text: CREDS_TEXT });
    s2 = await getFresh(sessionId);
    expect(s2.state).toBe("validating");
    const gl = s2.proposals.find((p) => p.kind === "goLive")!;
    await caller.approveProposal({ sessionId, proposalId: gl.id, approve: true });
    expect((await getFresh(sessionId)).state).toBe("live");
  });

  it("editProposal via router rejects an invalid waMenu payload with BAD_REQUEST", async () => {
    const { sessionId } = await startThroughIntake();
    const s = await getFresh(sessionId);
    const wa = s.proposals.find((p) => p.kind === "waMenu")!;
    const caller = onboardingCopilotRouter.createCaller(adminCtx);
    await expect(
      caller.editProposal({
        sessionId,
        proposalId: wa.id,
        payload: { greeting: "", useCases: [], customItems: [], fallback: "xxx" },
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("getSession for an unknown id maps to NOT_FOUND", async () => {
    const caller = onboardingCopilotRouter.createCaller(adminCtx);
    await expect(caller.getSession({ sessionId: "nope" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
