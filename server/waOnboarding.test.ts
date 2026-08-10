/**
 * waOnboarding — unit tests (wave 9 / C3)
 *
 * The w9 C1 copilot core (server/services/onboardingCopilot) is injected via
 * the setOnboardingCopilot() DI hook so these tests stay DB/LLM-free; the
 * mocks below mirror real C1 semantics (approve:false = reject, free-text
 * edits re-drafted via postMessage, idempotent postMessage, phone
 * supersession on startSession).
 *
 * Covers: env gating, action-id wire protocol, greeting → intake → proposal
 * card → approve → live, edit flow, >3-action list fallback, voice notes,
 * restart, copilot-throw fail-safe, and the webhook-branch wiring regression.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "fs";
import path from "path";

// ── transcribe: mocked (voice-note path) ────────────────────────────────────
const isTranscriptionConfiguredMock = vi.fn(() => false);
const transcribeAudioMock = vi.fn(async () => ({ text: null as string | null, error: "not_configured" }));
vi.mock("./services/transcribe", () => ({
  isTranscriptionConfigured: () => isTranscriptionConfiguredMock(),
  transcribeAudio: (...args: any[]) => transcribeAudioMock(...args),
}));

import {
  handleInbound,
  isOnboardingIntakeNumber,
  resolveOnboardingWaCredentials,
  parseOnboardingActionId,
  toWireActionId,
  renderNumberedActionList,
  terminalStateMessage,
  pendingEditProposals,
  setOnboardingCopilot,
  type OnboardingCopilotApi,
  type CopilotReply,
} from "./services/waOnboarding";

const ONB_PNID = "pn-onboarding-1";
const ONB_TOKEN = "onb-token-xyz";
const SENDER = "2348012345678";

function makeCopilot(overrides: Partial<OnboardingCopilotApi> = {}): OnboardingCopilotApi {
  return {
    startSession: vi.fn(async () => ({ sessionId: "sess-1", greeting: "Hi! Let's set up your store. What's it called?" })),
    postMessage: vi.fn(async () => ({ replies: [{ type: "text" as const, text: "Got it — tell me more." }], state: "intake" })),
    decideProposal: vi.fn(async () => ({ ok: true, replies: [{ type: "text" as const, text: "Proposal approved — setting things up." }] })),
    getSession: vi.fn(async () => ({ id: "sess-1", channel: "whatsapp" as const, state: "approving" })),
    findActiveSessionByPhone: vi.fn(async () => null),
    ...overrides,
  };
}

interface FetchCall { url: string; body: any; headers: any }
function stubFetchOk(): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: any, init: any) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null, headers: init?.headers });
    return { ok: true, json: async () => ({ messages: [{ id: "wamid.onb" }] }), text: async () => "" } as any;
  }));
  return calls;
}

function stubOnboardingEnv(): void {
  vi.stubEnv("ONBOARDING_PHONE_NUMBER_ID", ONB_PNID);
  vi.stubEnv("ONBOARDING_WA_TOKEN", ONB_TOKEN);
  vi.stubEnv("APP_URL", "https://admin.example.com");
}

const textMsg = (body: string) => ({ type: "text", text: { body } });
const buttonMsg = (id: string) => ({ type: "interactive", interactive: { button_reply: { id, title: id } } });

beforeEach(() => {
  pendingEditProposals.clear();
});

afterEach(() => {
  setOnboardingCopilot(null);
  pendingEditProposals.clear();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// ── Env gating / routing predicate ──────────────────────────────────────────

describe("env gating", () => {
  it("isOnboardingIntakeNumber is false when ONBOARDING_PHONE_NUMBER_ID is unset (branch inert)", () => {
    vi.stubEnv("ONBOARDING_PHONE_NUMBER_ID", "");
    expect(isOnboardingIntakeNumber("pn-onboarding-1")).toBe(false);
    expect(isOnboardingIntakeNumber("")).toBe(false);
  });

  it("isOnboardingIntakeNumber is true only for the configured number", () => {
    stubOnboardingEnv();
    expect(isOnboardingIntakeNumber(ONB_PNID)).toBe(true);
    expect(isOnboardingIntakeNumber("tenant-pn-9")).toBe(false);
    expect(isOnboardingIntakeNumber(null)).toBe(false);
    expect(isOnboardingIntakeNumber(undefined)).toBe(false);
  });

  it("resolveOnboardingWaCredentials returns null unless BOTH vars are set", () => {
    vi.stubEnv("ONBOARDING_PHONE_NUMBER_ID", "");
    vi.stubEnv("ONBOARDING_WA_TOKEN", "");
    expect(resolveOnboardingWaCredentials()).toBeNull();
    vi.stubEnv("ONBOARDING_PHONE_NUMBER_ID", ONB_PNID);
    expect(resolveOnboardingWaCredentials()).toBeNull();
    vi.stubEnv("ONBOARDING_WA_TOKEN", ONB_TOKEN);
    expect(resolveOnboardingWaCredentials()).toEqual({ phoneNumberId: ONB_PNID, accessToken: ONB_TOKEN });
  });

  it("sends are a logged no-op (simulation) when onboarding creds are unset", async () => {
    vi.stubEnv("ONBOARDING_PHONE_NUMBER_ID", "");
    vi.stubEnv("ONBOARDING_WA_TOKEN", "");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const copilot = makeCopilot();
    setOnboardingCopilot(copilot);
    const out = await handleInbound(textMsg("hello"), SENDER);
    expect(out.outcome).toBe("greeting");
    expect(copilot.startSession).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled(); // nothing actually sent
  });
});

// ── Action-id wire protocol ─────────────────────────────────────────────────

describe("action id protocol", () => {
  it("toWireActionId prefixes plain copilot ids with onb_", () => {
    expect(toWireActionId("approve:prop-1")).toBe("onb_approve:prop-1");
    expect(toWireActionId("edit:prop-1")).toBe("onb_edit:prop-1");
  });

  it("toWireActionId keeps already-prefixed ids", () => {
    expect(toWireActionId("onb_approve:prop-1")).toBe("onb_approve:prop-1");
  });

  it("parses onb_approve / onb_edit with their proposal ids", () => {
    expect(parseOnboardingActionId("onb_approve:prop-1")).toEqual({ kind: "approve", proposalId: "prop-1" });
    expect(parseOnboardingActionId("onb_edit:p9")).toEqual({ kind: "edit", proposalId: "p9" });
  });

  it("rejects non-onboarding ids (tenant menu buttons etc.)", () => {
    expect(parseOnboardingActionId("menu_3")).toBeNull();
    expect(parseOnboardingActionId("order_track:42")).toBeNull();
    expect(parseOnboardingActionId(null)).toBeNull();
    expect(parseOnboardingActionId("")).toBeNull();
  });

  it("rejects malformed ids: empty proposalId, unknown kind, missing colon", () => {
    expect(parseOnboardingActionId("onb_approve:")).toBeNull();
    expect(parseOnboardingActionId("onb_approve")).toBeNull();
    expect(parseOnboardingActionId("onb_delete:prop-1")).toBeNull();
    expect(parseOnboardingActionId("onb_:prop-1")).toBeNull();
  });

  it("renderNumberedActionList enumerates every action", () => {
    const text = renderNumberedActionList("Pick options:", [
      { id: "a:1", label: "Approve" },
      { id: "e:1", label: "Edit name" },
      { id: "x:1", label: "Change currency" },
      { id: "y:1", label: "Ask a human" },
    ]);
    expect(text).toContain("Pick options:");
    expect(text).toContain("1. Approve");
    expect(text).toContain("4. Ask a human");
  });
});

// ── Full conversational path ────────────────────────────────────────────────

describe("handleInbound — session lifecycle", () => {
  it("unknown sender → startSession({channel:'whatsapp', phone}) + greeting via the onboarding number", async () => {
    stubOnboardingEnv();
    const calls = stubFetchOk();
    const copilot = makeCopilot();
    setOnboardingCopilot(copilot);

    const out = await handleInbound(textMsg("hi there"), SENDER);
    expect(out).toEqual({ handled: true, outcome: "greeting" });
    expect(copilot.startSession).toHaveBeenCalledWith({ channel: "whatsapp", phone: SENDER });
    expect(copilot.postMessage).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`https://graph.facebook.com/v21.0/${ONB_PNID}/messages`);
    expect(calls[0].headers.Authorization).toBe(`Bearer ${ONB_TOKEN}`);
    expect(calls[0].body.to).toBe(SENDER);
    expect(calls[0].body.text.body).toContain("set up your store");
  });

  it("known sender resumes mid-session → postMessage, startSession NOT called", async () => {
    stubOnboardingEnv();
    stubFetchOk();
    const session = { id: "sess-9", channel: "whatsapp" as const, state: "intake" };
    const copilot = makeCopilot({ findActiveSessionByPhone: vi.fn(async () => session) });
    setOnboardingCopilot(copilot);

    const out = await handleInbound(textMsg("My shop is called Adire Hub"), SENDER);
    expect(out.outcome).toBe("message");
    expect(copilot.startSession).not.toHaveBeenCalled();
    expect(copilot.postMessage).toHaveBeenCalledWith({ sessionId: "sess-9", text: "My shop is called Adire Hub" });
  });

  it("full path: greeting → intake → proposal card → approve → live", async () => {
    stubOnboardingEnv();
    const calls = stubFetchOk();
    const proposalCard: CopilotReply = {
      type: "card",
      text: "Here's your store setup proposal: Adire Hub, NGN, paystack.",
      actions: [
        { id: "approve:prop-1", label: "Approve" },
        { id: "edit:prop-1", label: "Edit" },
      ],
    };
    const session = { id: "sess-1", channel: "whatsapp" as const, state: "intake" };
    const copilot = makeCopilot({
      findActiveSessionByPhone: vi.fn(async () => session),
      postMessage: vi.fn(async () => ({ replies: [proposalCard], state: "approving" })),
      getSession: vi.fn(async () => ({ id: "sess-1", channel: "whatsapp" as const, state: "live" })),
    });
    setOnboardingCopilot(copilot);

    // 1. intake text → proposal card as interactive buttons (onb_ wire ids)
    const r1 = await handleInbound(textMsg("I sell adire fabrics"), SENDER);
    expect(r1.outcome).toBe("message");
    const cardSend = calls.find((c) => c.body?.type === "interactive");
    expect(cardSend).toBeTruthy();
    const btns = cardSend!.body.interactive.action.buttons.map((b: any) => b.reply.id);
    expect(btns).toEqual(["onb_approve:prop-1", "onb_edit:prop-1"]);

    // 2. buyer taps Approve → decideProposal(approve:true) → live follow-up
    const r2 = await handleInbound(buttonMsg("onb_approve:prop-1"), SENDER);
    expect(r2.outcome).toBe("approve");
    expect(copilot.decideProposal).toHaveBeenCalledWith({
      sessionId: "sess-1",
      proposalId: "prop-1",
      approve: true,
    });
    const texts = calls.filter((c) => c.body?.type === "text").map((c) => c.body.text.body);
    expect(texts.some((t: string) => t.includes("Proposal approved"))).toBe(true);
    const congrats = texts.find((t: string) => t.includes("live"));
    expect(congrats).toContain("https://admin.example.com/settings/whatsapp"); // embedded signup link
    expect(congrats).toContain("https://admin.example.com"); // admin portal URL
  });

  it("state 'failed' → apologetic message with reasons pointer + restart hint", async () => {
    stubOnboardingEnv();
    const calls = stubFetchOk();
    const session = { id: "sess-2", channel: "whatsapp" as const, state: "validating" };
    const copilot = makeCopilot({
      findActiveSessionByPhone: vi.fn(async () => session),
      postMessage: vi.fn(async () => ({
        replies: [{ type: "text" as const, text: "Catalog connection failed: invalid Meta token." }],
        state: "failed",
      })),
    });
    setOnboardingCopilot(copilot);

    const out = await handleInbound(textMsg("my token is abc"), SENDER);
    expect(out.outcome).toBe("message");
    const texts = calls.filter((c) => c.body?.type === "text").map((c) => c.body.text.body);
    expect(texts.some((t: string) => t.includes("invalid Meta token"))).toBe(true);
    const sorry = texts.find((t: string) => t.toLowerCase().includes("sorry"));
    expect(sorry).toContain("restart");
  });

  it("terminalStateMessage returns null for non-terminal states", () => {
    expect(terminalStateMessage("intake")).toBeNull();
    expect(terminalStateMessage("approving")).toBeNull();
    expect(terminalStateMessage("abandoned")).toBeNull();
    expect(terminalStateMessage(null)).toBeNull();
    expect(terminalStateMessage("live")).toContain("live");
    expect(terminalStateMessage("failed")).toContain("restart");
  });
});

// ── Proposal cards: buttons / fallback / decisions ──────────────────────────

describe("proposal cards", () => {
  it("card without actions is sent as plain text", async () => {
    stubOnboardingEnv();
    const calls = stubFetchOk();
    const session = { id: "sess-3", channel: "whatsapp" as const, state: "intake" };
    const copilot = makeCopilot({
      findActiveSessionByPhone: vi.fn(async () => session),
      postMessage: vi.fn(async () => ({
        replies: [{ type: "card" as const, text: "Summary only, no actions." }],
        state: "intake",
      })),
    });
    setOnboardingCopilot(copilot);
    await handleInbound(textMsg("info please"), SENDER);
    expect(calls.every((c) => c.body?.type === "text")).toBe(true);
    expect(calls[0].body.text.body).toBe("Summary only, no actions.");
  });

  it("card with >3 actions falls back to a numbered text list (Meta limit)", async () => {
    stubOnboardingEnv();
    const calls = stubFetchOk();
    const session = { id: "sess-4", channel: "whatsapp" as const, state: "intake" };
    const copilot = makeCopilot({
      findActiveSessionByPhone: vi.fn(async () => session),
      postMessage: vi.fn(async () => ({
        replies: [{
          type: "card" as const,
          text: "Choose what to configure:",
          actions: [
            { id: "a:p2", label: "Payments" },
            { id: "b:p2", label: "Catalog" },
            { id: "c:p2", label: "Logistics" },
            { id: "d:p2", label: "Domain" },
          ],
        }],
        state: "approving",
      })),
    });
    setOnboardingCopilot(copilot);
    await handleInbound(textMsg("next"), SENDER);
    expect(calls.some((c) => c.body?.type === "interactive")).toBe(false);
    const listText = calls.find((c) => c.body?.type === "text")!.body.text.body;
    expect(listText).toContain("1. Payments");
    expect(listText).toContain("4. Domain");
  });

  it("onb_edit prompts for a one-message change and defers the decision", async () => {
    stubOnboardingEnv();
    const calls = stubFetchOk();
    const session = { id: "sess-5", channel: "whatsapp" as const, state: "approving" };
    const copilot = makeCopilot({ findActiveSessionByPhone: vi.fn(async () => session) });
    setOnboardingCopilot(copilot);

    const out = await handleInbound(buttonMsg("onb_edit:prop-7"), SENDER);
    expect(out.outcome).toBe("edit_prompt");
    expect(copilot.decideProposal).not.toHaveBeenCalled();
    expect(pendingEditProposals.get(SENDER)).toBe("prop-7");
    const prompt = calls.find((c) => c.body?.type === "text")!.body.text.body;
    expect(prompt).toContain("reply with your changes in one message");
  });

  it("next text after onb_edit rejects the stale proposal, then postMessage re-drafts from the free text", async () => {
    stubOnboardingEnv();
    stubFetchOk();
    const session = { id: "sess-5", channel: "whatsapp" as const, state: "approving" };
    const copilot = makeCopilot({
      findActiveSessionByPhone: vi.fn(async () => session),
      decideProposal: vi.fn(async () => ({
        ok: true,
        replies: [{ type: "text" as const, text: "Discarded the waMenu proposal. Tell me what you'd prefer and I'll draft another." }],
      })),
    });
    setOnboardingCopilot(copilot);

    await handleInbound(buttonMsg("onb_edit:prop-7"), SENDER);
    const out = await handleInbound(textMsg("Rename it to Adire Palace and switch currency to USD"), SENDER);
    expect(out.outcome).toBe("edit_applied");
    // Real C1 semantics: approve:false (no editedPayload) = reject …
    expect(copilot.decideProposal).toHaveBeenCalledWith({
      sessionId: "sess-5",
      proposalId: "prop-7",
      approve: false,
    });
    // … then the free-text changes go through postMessage for re-drafting.
    expect(copilot.postMessage).toHaveBeenCalledWith({
      sessionId: "sess-5",
      text: "Rename it to Adire Palace and switch currency to USD",
    });
    expect(pendingEditProposals.has(SENDER)).toBe(false);
  });

  it("edit text still reaches postMessage when the stale-proposal reject throws", async () => {
    stubOnboardingEnv();
    stubFetchOk();
    const session = { id: "sess-5", channel: "whatsapp" as const, state: "approving" };
    const copilot = makeCopilot({
      findActiveSessionByPhone: vi.fn(async () => session),
      decideProposal: vi.fn(async () => { throw new Error('Proposal "prop-7" is already approved'); }),
    });
    setOnboardingCopilot(copilot);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await handleInbound(buttonMsg("onb_edit:prop-7"), SENDER);
    const out = await handleInbound(textMsg("actually make it blue"), SENDER);
    expect(out.outcome).toBe("edit_applied"); // NOT the fail-safe "error"
    expect(copilot.postMessage).toHaveBeenCalledWith({ sessionId: "sess-5", text: "actually make it blue" });
    warnSpy.mockRestore();
  });

  it("malformed interactive id → friendly guidance, no decideProposal, no crash", async () => {
    stubOnboardingEnv();
    const calls = stubFetchOk();
    const copilot = makeCopilot();
    setOnboardingCopilot(copilot);

    const out = await handleInbound(buttonMsg("onb_approve:"), SENDER);
    expect(out.outcome).toBe("malformed_action");
    expect(copilot.decideProposal).not.toHaveBeenCalled();
    const msg = calls.find((c) => c.body?.type === "text")!.body.text.body;
    expect(msg).toContain("didn't work");
  });

  it("stale button with no active session → fresh greeting instead of a decision", async () => {
    stubOnboardingEnv();
    stubFetchOk();
    const copilot = makeCopilot(); // findActiveSessionByPhone → null
    setOnboardingCopilot(copilot);
    const out = await handleInbound(buttonMsg("onb_approve:prop-old"), SENDER);
    expect(out.outcome).toBe("greeting");
    expect(copilot.startSession).toHaveBeenCalledTimes(1);
    expect(copilot.decideProposal).not.toHaveBeenCalled();
  });
});

// ── Restart / fail-safe ─────────────────────────────────────────────────────

describe("restart + fail-safe", () => {
  it.each(["restart", "start over", "  Restart  "])("'%s' abandons and starts a fresh session", async (text) => {
    stubOnboardingEnv();
    const calls = stubFetchOk();
    const session = { id: "sess-6", channel: "whatsapp" as const, state: "approving" };
    const copilot = makeCopilot({ findActiveSessionByPhone: vi.fn(async () => session) });
    setOnboardingCopilot(copilot);

    const out = await handleInbound(textMsg(text), SENDER);
    expect(out.outcome).toBe("restart");
    expect(copilot.startSession).toHaveBeenCalledWith({ channel: "whatsapp", phone: SENDER });
    expect(copilot.postMessage).not.toHaveBeenCalled();
    const greeting = calls.find((c) => c.body?.type === "text")!.body.text.body;
    expect(greeting).toContain("set up your store");
    calls.length = 0;
  });

  it("restart clears a pending edit", async () => {
    stubOnboardingEnv();
    stubFetchOk();
    const session = { id: "sess-6", channel: "whatsapp" as const, state: "approving" };
    const copilot = makeCopilot({ findActiveSessionByPhone: vi.fn(async () => session) });
    setOnboardingCopilot(copilot);
    await handleInbound(buttonMsg("onb_edit:prop-8"), SENDER);
    expect(pendingEditProposals.has(SENDER)).toBe(true);
    await handleInbound(textMsg("restart"), SENDER);
    expect(pendingEditProposals.has(SENDER)).toBe(false);
    expect(copilot.decideProposal).not.toHaveBeenCalled();
  });

  it("copilot throw → friendly fail-safe message + resolved outcome (webhook returns 200)", async () => {
    stubOnboardingEnv();
    const calls = stubFetchOk();
    const session = { id: "sess-7", channel: "whatsapp" as const, state: "intake" };
    const copilot = makeCopilot({
      findActiveSessionByPhone: vi.fn(async () => session),
      postMessage: vi.fn(async () => { throw new Error("LLM exploded"); }),
    });
    setOnboardingCopilot(copilot);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const out = await handleInbound(textMsg("boom"), SENDER); // must not reject
    expect(out).toEqual({ handled: true, outcome: "error" });
    const msg = calls.find((c) => c.body?.type === "text")!.body.text.body;
    expect(msg).toContain("Something went wrong");
    expect(msg).toContain("restart");
    errSpy.mockRestore();
  });

  it("terminal goLive proposal approval → live-state congrats with signup link + portal URL", async () => {
    stubOnboardingEnv();
    const calls = stubFetchOk();
    const session = { id: "sess-live", channel: "whatsapp" as const, state: "validating" };
    // Mirrors C1: approving the goLive proposal runs advanceToLive and the
    // session lands in state 'live'.
    const copilot = makeCopilot({
      findActiveSessionByPhone: vi.fn(async () => session),
      decideProposal: vi.fn(async () => ({
        ok: true,
        replies: [
          { type: "text" as const, text: "Approved the goLive proposal." },
          { type: "text" as const, text: "All 6 validation checks passed — you are live!" },
        ],
      })),
      getSession: vi.fn(async () => ({ id: "sess-live", channel: "whatsapp" as const, state: "live" })),
    });
    setOnboardingCopilot(copilot);

    const out = await handleInbound(buttonMsg("onb_approve:prop-golive"), SENDER);
    expect(out.outcome).toBe("approve");
    expect(copilot.decideProposal).toHaveBeenCalledWith({
      sessionId: "sess-live",
      proposalId: "prop-golive",
      approve: true,
    });
    const texts = calls.filter((c) => c.body?.type === "text").map((c) => c.body.text.body);
    const congrats = texts.find((t: string) => t.includes("Congratulations"));
    expect(congrats).toContain("https://admin.example.com/settings/whatsapp");
    expect(congrats).toContain("https://admin.example.com");
  });

  it("literal 'go live' text (C1 postMessage command) → state live → congrats", async () => {
    stubOnboardingEnv();
    const calls = stubFetchOk();
    const session = { id: "sess-gl", channel: "whatsapp" as const, state: "validating" };
    const copilot = makeCopilot({
      findActiveSessionByPhone: vi.fn(async () => session),
      postMessage: vi.fn(async () => ({
        replies: [{ type: "text" as const, text: "All checks passed — you are live!" }],
        state: "live",
      })),
    });
    setOnboardingCopilot(copilot);

    const out = await handleInbound(textMsg("go live"), SENDER);
    expect(out.outcome).toBe("message");
    const texts = calls.filter((c) => c.body?.type === "text").map((c) => c.body.text.body);
    expect(texts.some((t: string) => t.includes("Congratulations"))).toBe(true);
  });

  it("idempotent postMessage redelivery (Meta retry) → empty replies, no duplicate sends", async () => {
    stubOnboardingEnv();
    const calls = stubFetchOk();
    const session = { id: "sess-idem", channel: "whatsapp" as const, state: "intake" };
    // Mirrors C1's idempotent postMessage: an exact repeat returns no replies.
    const copilot = makeCopilot({
      findActiveSessionByPhone: vi.fn(async () => session),
      postMessage: vi.fn(async () => ({ replies: [], state: "intake" })),
    });
    setOnboardingCopilot(copilot);

    const out = await handleInbound(textMsg("My shop is called Adire Hub"), SENDER);
    expect(out.outcome).toBe("message");
    expect(calls.filter((c) => c.body?.type === "text")).toHaveLength(0);
  });
});

// ── Voice notes + unsupported types ─────────────────────────────────────────

describe("voice notes + unsupported types", () => {
  it("audio with transcription configured → transcript enters the text pipeline", async () => {
    stubOnboardingEnv();
    isTranscriptionConfiguredMock.mockReturnValue(true);
    transcribeAudioMock.mockResolvedValue({ text: "I sell handmade shoes", error: undefined });
    const session = { id: "sess-8", channel: "whatsapp" as const, state: "intake" };
    const copilot = makeCopilot({ findActiveSessionByPhone: vi.fn(async () => session) });
    setOnboardingCopilot(copilot);
    vi.stubGlobal("fetch", vi.fn(async (url: any, init: any) => {
      const u = String(url);
      if (u.endsWith("/media-123")) {
        return { ok: true, json: async () => ({ url: "https://cdn.example.com/audio.ogg", mime_type: "audio/ogg" }) } as any;
      }
      if (u.includes("cdn.example.com")) {
        return { ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer } as any;
      }
      return { ok: true, json: async () => ({ messages: [{ id: "wamid.onb" }] }), text: async () => "" } as any;
    }));

    const out = await handleInbound({ type: "audio", audio: { id: "media-123", mime_type: "audio/ogg" } }, SENDER);
    expect(out.outcome).toBe("voice_note");
    expect(transcribeAudioMock).toHaveBeenCalledTimes(1);
    expect(copilot.postMessage).toHaveBeenCalledWith({ sessionId: "sess-8", text: "I sell handmade shoes" });
  });

  it("audio without transcription configured → polite skip, copilot untouched", async () => {
    stubOnboardingEnv();
    const calls = stubFetchOk();
    isTranscriptionConfiguredMock.mockReturnValue(false);
    const copilot = makeCopilot();
    setOnboardingCopilot(copilot);

    const out = await handleInbound({ type: "audio", audio: { id: "media-9" } }, SENDER);
    expect(out.outcome).toBe("voice_unavailable");
    expect(copilot.postMessage).not.toHaveBeenCalled();
    expect(copilot.startSession).not.toHaveBeenCalled();
    const msg = calls.find((c) => c.body?.type === "text")!.body.text.body;
    expect(msg).toContain("type it out");
  });

  it("unsupported message type (image) → guidance, copilot untouched", async () => {
    stubOnboardingEnv();
    const calls = stubFetchOk();
    const copilot = makeCopilot();
    setOnboardingCopilot(copilot);
    const out = await handleInbound({ type: "image", image: { id: "img-1" } }, SENDER);
    expect(out.outcome).toBe("unsupported");
    expect(copilot.startSession).not.toHaveBeenCalled();
    const msg = calls.find((c) => c.body?.type === "text")!.body.text.body;
    expect(msg).toContain("text and voice notes");
  });
});

// ── Webhook wiring regression (server/_core/index.ts) ──────────────────────

describe("webhook branch wiring (regression)", () => {
  const src = readFileSync(path.resolve(import.meta.dirname, "_core/index.ts"), "utf8");

  it("onboarding branch is placed BEFORE tenant resolution and skips tenant dispatch", () => {
    const branchIdx = src.indexOf("isOnboardingIntakeNumber(phoneNumberId)");
    const tenantLookupIdx = src.indexOf("tenants.whatsappPhoneNumberId, phoneNumberId");
    expect(branchIdx).toBeGreaterThan(-1);
    expect(tenantLookupIdx).toBeGreaterThan(-1);
    expect(branchIdx).toBeLessThan(tenantLookupIdx);
    // The branch hands off to waOnboarding.handleInbound and `continue`s.
    const branchBlock = src.slice(branchIdx, tenantLookupIdx);
    expect(branchBlock).toContain('await import("../services/waOnboarding")');
    expect(branchBlock).toContain("handleInbound(msg, waPhoneNumber)");
    expect(branchBlock).toContain("continue;");
  });

  it("existing tenant dispatch path is untouched", () => {
    // Tenant resolution fallback, CTWA, interactive and text dispatch all intact.
    expect(src).toContain('?? "default"');
    expect(src).toContain("handleCtwaInbound");
    expect(src).toContain("handleInteractiveInbound");
    expect(src).toContain("claimWebhookEvent");
  });

  it("env.ts declares ONBOARDING_PHONE_NUMBER_ID + ONBOARDING_WA_TOKEN as optional", () => {
    const envSrc = readFileSync(path.resolve(import.meta.dirname, "_core/env.ts"), "utf8");
    expect(envSrc).toContain('process.env.ONBOARDING_PHONE_NUMBER_ID ?? ""');
    expect(envSrc).toContain('process.env.ONBOARDING_WA_TOKEN ?? ""');
    // Not added to the production boot gate (feature stays opt-in).
    const requiredBlock = envSrc.slice(envSrc.indexOf("REQUIRED_BY_ENV"));
    expect(requiredBlock).not.toContain("ONBOARDING");
  });
});
