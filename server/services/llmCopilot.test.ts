/**
 * W22 llmCopilot unit tests — redaction, runbook retrieval, heuristic
 * fallback contract, structured parse, aggregate snapshot, audit logging,
 * and the mocked-LLM happy path. Deterministic: LLM is disabled by default
 * (COPILOT_LLM_ENABLED unset) and explicitly mocked when enabled.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../_core/llm", () => ({ invokeLLM: vi.fn() }));

import { invokeLLM } from "../_core/llm";
import {
  buildAskPrompt,
  buildTriagePrompt,
  fallbackAskAnswer,
  heuristicTriage,
  isCopilotLlmEnabled,
  merchantAsk,
  parseAskResponse,
  parseTriageResponse,
  promptHash,
  redactForPrompt,
  retrieveRunbookExcerpt,
  triageIncident,
} from "./llmCopilot";
import { makeSoc2FakeDb } from "./testUtils/soc2FakeDb";
import {
  anomalyAlerts, copilotQueries, creditAccounts, incidents, orders,
  type Incident,
} from "../../drizzle/schema";

const T1 = "tenant-1";
const INC_ID = "11111111-1111-4111-8111-111111111111";

let store: Map<any, any[]>;
function seed() {
  store = new Map<any, any[]>([
    [incidents, []],
    [anomalyAlerts, []],
    [orders, []],
    [creditAccounts, []],
    [copilotQueries, []],
  ]);
  return makeSoc2FakeDb(store);
}

function incidentRow(over: Partial<Incident> = {}): Incident {
  return {
    id: INC_ID,
    tenantId: T1,
    severity: "low",
    status: "open",
    title: "Suspicious retention purge of customer data",
    description: "Off-hours data export burst by unknown actor +2348012345678",
    openedAt: new Date("2026-02-01T03:00:00Z"),
    resolvedAt: null,
    ...over,
  } as Incident;
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.COPILOT_LLM_ENABLED;
});
afterEach(() => { delete process.env.COPILOT_LLM_ENABLED; });

describe("provider gating", () => {
  it("is disabled by default and enabled only with explicit flag", () => {
    expect(isCopilotLlmEnabled()).toBe(false);
    process.env.COPILOT_LLM_ENABLED = "1";
    expect(isCopilotLlmEnabled()).toBe(true);
    process.env.COPILOT_LLM_ENABLED = "false";
    expect(isCopilotLlmEnabled()).toBe(false);
  });
});

describe("redactForPrompt", () => {
  it("redacts phone numbers, emails and key=value secrets", () => {
    const out = redactForPrompt(
      "call +234 801 234 5678 or 08012345678, mail buyer@example.com, api_key=sk-live-abcdef123456",
    );
    expect(out).not.toContain("801 234 5678");
    expect(out).not.toContain("08012345678");
    expect(out).not.toContain("buyer@example.com");
    expect(out).not.toContain("sk-live-abcdef123456");
    expect(out).toContain("[REDACTED-PHONE]");
    expect(out).toContain("[REDACTED-EMAIL]");
    expect(out).toContain("[REDACTED]");
  });

  it("keeps ordinary numbers (amounts, ids) intact", () => {
    const out = redactForPrompt("sales today: 125000 cents, order #42");
    expect(out).toContain("125000");
    expect(out).toContain("#42");
  });
});

describe("runbook retrieval", () => {
  it("retrieves a relevant SOC2 excerpt by keyword overlap", () => {
    const excerpt = retrieveRunbookExcerpt("incident severity response runbook");
    expect(excerpt.length).toBeGreaterThan(50);
    expect(/INCIDENT_RUNBOOK|incident/i.test(excerpt)).toBe(true);
  });

  it("returns empty string for an out-of-vocabulary query", () => {
    expect(retrieveRunbookExcerpt("zzzqxxk mmmvvv")).toBe("");
  });
});

describe("heuristicTriage", () => {
  it("escalates purge/export incidents to critical with runbook steps", () => {
    const r = heuristicTriage(incidentRow(), [], "");
    expect(r.severitySuggestion).toBe("critical");
    expect(r.runbookSteps.length).toBeGreaterThanOrEqual(3);
    expect(r.postmortemDraft).toContain("Suspicious retention purge");
  });

  it("payment/webhook faults land at high", () => {
    const r = heuristicTriage(incidentRow({ title: "Payment webhook failed", description: "callbacks failing" }), [], "");
    expect(r.severitySuggestion).toBe("high");
  });

  it("unknown incident keeps the current severity", () => {
    const r = heuristicTriage(incidentRow({ title: "Cosmetic UI issue", description: "typo", severity: "medium" }), [], "");
    expect(r.severitySuggestion).toBe("medium");
  });

  it("missing incident row still returns a safe generic suggestion", () => {
    const r = heuristicTriage(null, [], "");
    expect(r.severitySuggestion).toBe("medium");
    expect(r.runbookSteps.length).toBeGreaterThan(0);
  });
});

describe("parseTriageResponse / parseAskResponse", () => {
  it("parses a valid JSON triage reply", () => {
    const p = parseTriageResponse(JSON.stringify({
      severitySuggestion: "high",
      likelyCause: "webhook retries exhausted",
      runbookSteps: ["acknowledge the incident", "contain the threat", "notify stakeholders"],
      postmortemDraft: "Timeline: webhook endpoint began failing at 03:00 UTC ...",
    }));
    expect(p).not.toBeNull();
    expect(p!.severitySuggestion).toBe("high");
    expect(p!.runbookSteps).toHaveLength(3);
  });

  it("rejects malformed / underspecified replies", () => {
    expect(parseTriageResponse("not json")).toBeNull();
    expect(parseTriageResponse('{"severitySuggestion":"bogus"}')).toBeNull();
    expect(parseTriageResponse('{"severitySuggestion":"high","likelyCause":"x","runbookSteps":[],"postmortemDraft":""}')).toBeNull();
  });

  it("bounds the ask answer length", () => {
    expect(parseAskResponse("  You made 5 sales today.  ")).toContain("5 sales");
    expect(parseAskResponse("short")).toBeNull();
    expect(parseAskResponse("x".repeat(3000))).toBeNull();
  });
});

describe("triageIncident (LLM disabled → fallback)", () => {
  it("returns a structured suggestion with fallbackUsed=true and logs the query", async () => {
    const db = seed();
    store.get(incidents)!.push(incidentRow());
    store.get(anomalyAlerts)!.push({
      id: "a1", tenantId: T1, signal: "sensitive_event_rate", score: 0.97,
      detail: { events: 10 }, status: "open",
      windowBucket: new Date("2026-02-01T03:00:00Z"), createdAt: new Date("2026-02-01T03:30:00Z"),
    });
    const res = await triageIncident(T1, INC_ID, db);
    expect(res.fallbackUsed).toBe(true);
    expect(res.severitySuggestion).toBe("critical");
    expect(res.likelyCause).toContain("sensitive_event_rate");
    expect(res.runbookSteps.length).toBeGreaterThan(0);
    expect(res.postmortemDraft.length).toBeGreaterThan(20);
    expect(res.latencyMs).toBeGreaterThanOrEqual(0);
    expect(invokeLLM).not.toHaveBeenCalled();

    const log = store.get(copilotQueries)!;
    expect(log).toHaveLength(1);
    expect(log[0].kind).toBe("triage");
    expect(log[0].fallbackUsed).toBe(true);
    expect(log[0].promptHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(log[0])).not.toContain("2348012345678"); // no PII persisted
  });

  it("never throws: db down + missing incident → fallback result", async () => {
    const res = await triageIncident(T1, "missing", { select: () => { throw new Error("db down"); } } as any);
    expect(res.fallbackUsed).toBe(true);
    expect(res.runbookSteps.length).toBeGreaterThan(0);
  });
});

describe("triageIncident (LLM mocked/enabled → happy path)", () => {
  it("uses the parsed LLM suggestion when the provider returns valid JSON", async () => {
    process.env.COPILOT_LLM_ENABLED = "1";
    (invokeLLM as any).mockResolvedValue({
      id: "x", created: 0, model: "m",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify({
        severitySuggestion: "high",
        likelyCause: "compromised API token driving purge calls",
        runbookSteps: ["revoke token", "rotate keys", "review audit chain"],
        postmortemDraft: "At 03:00 UTC an unattended token drove retention purges ...",
      }) } }],
    });
    const db = seed();
    store.get(incidents)!.push(incidentRow());
    const res = await triageIncident(T1, INC_ID, db);
    expect(invokeLLM).toHaveBeenCalledTimes(1);
    expect(res.fallbackUsed).toBe(false);
    expect(res.severitySuggestion).toBe("high");
    expect(res.likelyCause).toContain("token");
  });

  it("falls back when the LLM reply fails to parse", async () => {
    process.env.COPILOT_LLM_ENABLED = "1";
    (invokeLLM as any).mockResolvedValue({
      id: "x", created: 0, model: "m",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "I cannot help with that." } }],
    });
    const db = seed();
    store.get(incidents)!.push(incidentRow());
    const res = await triageIncident(T1, INC_ID, db);
    expect(res.fallbackUsed).toBe(true);
    expect(res.severitySuggestion).toBe("critical"); // heuristic still applied
  });
});

describe("redaction of assembled prompts", () => {
  it("triage prompt never contains the secret or phone from the incident", () => {
    const inc = incidentRow({ description: "export by +2348012345678 using api_key=sk-live-abcdef123456" });
    const prompt = buildTriagePrompt(inc, [], "Runbook excerpt");
    expect(prompt).not.toContain("+2348012345678");
    expect(prompt).not.toContain("sk-live-abcdef123456");
    expect(prompt).toContain("[REDACTED");
  });

  it("ask prompt redacts PII from the merchant question", () => {
    const prompt = buildAskPrompt(
      { salesCentsToday: 100, ordersToday: 1, topProducts: [], creditOutstandingCents: 0, creditLimitCents: 0 },
      "did buyer@example.com call +234 701 111 2222?",
    );
    expect(prompt).not.toContain("buyer@example.com");
    expect(prompt).not.toContain("701 111 2222");
    expect(promptHash(prompt)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("merchantAsk", () => {
  it("answers from tenant-scoped aggregates with fallbackUsed=true when disabled", async () => {
    const db = seed();
    const now = new Date();
    store.get(orders)!.push(
      { id: "o1", tenantId: T1, totalAmount: "125.50", createdAt: now, items: [{ name: "Rice 50kg", quantity: 2 }] },
      { id: "o2", tenantId: T1, totalAmount: "74.50", createdAt: now, items: [{ name: "Beans", quantity: 1 }, { name: "Rice 50kg", quantity: 1 }] },
      { id: "oX", tenantId: "other-tenant", totalAmount: "999.00", createdAt: now, items: [{ name: "Secret", quantity: 9 }] },
    );
    store.get(creditAccounts)!.push({
      id: "ca1", supplierTenantId: "sup", buyerTenantId: T1,
      limitCents: 500000, outstandingCents: 120000,
    });
    const res = await merchantAsk(T1, "how much did I sell today and what is my credit balance?", db);
    expect(res.fallbackUsed).toBe(true);
    expect(res.snapshot.salesCentsToday).toBe(20000); // integer cents
    expect(res.snapshot.ordersToday).toBe(2);
    expect(res.snapshot.topProducts[0]).toEqual({ name: "Rice 50kg", quantity: 3 });
    expect(res.snapshot.creditOutstandingCents).toBe(120000);
    expect(res.answer).toContain("200.00");
    expect(res.answer).toContain("1200.00");
    expect(res.answer).not.toContain("999"); // other tenant excluded
    expect(invokeLLM).not.toHaveBeenCalled();

    const log = store.get(copilotQueries)!;
    expect(log).toHaveLength(1);
    expect(log[0].kind).toBe("ask");
    expect(log[0].promptHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("uses the LLM answer when enabled and well-formed", async () => {
    process.env.COPILOT_LLM_ENABLED = "1";
    (invokeLLM as any).mockResolvedValue({
      id: "x", created: 0, model: "m",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "You sold 2 orders totaling 200.00 today." } }],
    });
    const db = seed();
    const res = await merchantAsk(T1, "sales today?", db);
    expect(res.fallbackUsed).toBe(false);
    expect(res.answer).toContain("200.00");
  });

  it("never throws when the db is unavailable", async () => {
    const res = await merchantAsk(T1, "anything", { select: () => { throw new Error("down"); } } as any);
    expect(res.fallbackUsed).toBe(true);
    expect(res.answer.length).toBeGreaterThan(10);
  });
});

describe("fallbackAskAnswer", () => {
  const snap = { salesCentsToday: 500, ordersToday: 1, topProducts: [{ name: "Yam", quantity: 4 }], creditOutstandingCents: 0, creditLimitCents: 0 };
  it("is deterministic and question-aware", () => {
    expect(fallbackAskAnswer(snap, "top products?")).toContain("Yam");
    expect(fallbackAskAnswer(snap, "sales today?")).toContain("5.00");
    expect(fallbackAskAnswer(snap, "random question")).toContain("Snapshot");
  });
});
