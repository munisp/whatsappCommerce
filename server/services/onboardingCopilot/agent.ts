/**
 * onboardingCopilot/agent.ts — the copilot's tool-calling agent loop +
 * deterministic conversation policy.
 *
 * A short deterministic state machine drives WHICH tool is offered next
 * (intake → proposing → approving → configuring → validating → live). The LLM
 * (invokeLLM — the shared client the simulation harness mocks) is used for
 * extraction, proposal content and phrasing. When the LLM is unavailable or
 * returns unusable output, template fallbacks produce proposals so the flow
 * NEVER dead-ends.
 *
 * The checkpoint invariant is enforced in tools.ts (service layer); this file
 * converts checkpoint violations into user-facing refusals.
 */
import { invokeLLM, type Message } from "../../_core/llm";
import { eq } from "drizzle-orm";
import { getDb } from "../../db";
import { tenants } from "../../../drizzle/schema";
import type { ValidationReport } from "../onboarding";
import { updateTenantSettings } from "../onboarding";
import {
  COPILOT_TOOL_SCHEMAS,
  buildIntegrationSuggestions,
  buildRankedUseCases,
  buildTemplateWaMenu,
  executeCopilotTool,
  auditStateTransition,
  type ToolResult,
} from "./tools";
import { runRepairRound } from "./repair";
import {
  addProposal,
  appendTranscript,
  findProposal,
  type CopilotReply,
  type IntakeFacts,
  type OnboardingSession,
  type ProposalKind,
} from "./session";

const MAX_TOOL_ROUNDS = 4;

// ─── State transitions ───────────────────────────────────────────────────────

export async function transition(session: OnboardingSession, to: OnboardingSession["state"]) {
  if (session.state === to) return;
  const from = session.state;
  session.state = to;
  await auditStateTransition(session, from, to);
}

// ─── LLM tool loop ───────────────────────────────────────────────────────────

interface LoopOutcome {
  /** false when the LLM was unreachable/empty → caller uses fallbacks. */
  usedLlm: boolean;
  /** Last assistant text (phrasing), if any. */
  assistantText: string | null;
  replies: CopilotReply[];
}

/**
 * Run the tool-calling loop against the fixed registry. Tool results are fed
 * back as user-role summaries (the shared client normalizes assistant
 * tool_calls away, so this keeps every provider compatible).
 */
export async function runToolLoop(
  session: OnboardingSession,
  instruction: string,
): Promise<LoopOutcome> {
  const replies: CopilotReply[] = [];
  const facts = session.intake.facts;
  const recent = session.transcript
    .slice(-8)
    .map((t) => `${t.role}: ${t.text}`)
    .join("\n");
  const messages: Message[] = [
    {
      role: "system",
      content:
        "You are an onboarding copilot for a WhatsApp commerce platform. " +
        "Help set up the tenant's business by calling the provided tools. " +
        "You may CREATE proposals freely, but NEVER try to apply, push or go live " +
        "before a human approves — the service layer will refuse. " +
        "Keep replies short and friendly.",
    },
    {
      role: "user",
      content:
        `Known facts: ${JSON.stringify(facts)}\n` +
        (recent ? `Recent conversation:\n${recent}\n` : "") +
        `Instruction: ${instruction}`,
    },
  ];

  let assistantText: string | null = null;
  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const res = await invokeLLM({ messages, tools: COPILOT_TOOL_SCHEMAS, toolChoice: "auto" });
      const msg = res.choices?.[0]?.message;
      if (!msg) break;
      const toolCalls = msg.tool_calls ?? [];
      if (toolCalls.length === 0) {
        const text = typeof msg.content === "string" ? msg.content.trim() : "";
        if (text) assistantText = text;
        break;
      }
      const summaries: string[] = [];
      for (const call of toolCalls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.function.arguments || "{}");
        } catch {
          args = {};
        }
        let out: ToolResult;
        try {
          out = await executeCopilotTool(call.function.name, args, session);
        } catch (e: any) {
          // Checkpoint refusals + validation errors go back to the model.
          out = { ok: false, result: { error: String(e?.message ?? e) } };
        }
        if (out.replies) replies.push(...out.replies);
        summaries.push(`${call.function.name} → ${JSON.stringify(out.result)}`);
      }
      messages.push({ role: "assistant", content: typeof msg.content === "string" ? msg.content : "" });
      messages.push({ role: "user", content: `Tool results:\n${summaries.join("\n")}` });
    }
    return { usedLlm: true, assistantText, replies };
  } catch {
    return { usedLlm: false, assistantText: null, replies };
  }
}

// ─── Fallback intake extraction (LLM down) ───────────────────────────────────

const INDUSTRY_KEYWORDS = [
  "fashion", "clothing", "food", "restaurant", "bakery", "grocery", "electronics",
  "beauty", "salon", "pharmacy", "logistics", "wholesale", "furniture", "jewelry",
  "agriculture", "books", "fitness",
];

const KNOWN_CITIES = [
  "lagos", "abuja", "kano", "ibadan", "port harcourt", "enugu", "kaduna",
  "benin", "jos", "ilorin", "owerri", "accra", "nairobi",
];

export function extractFactsFallback(text: string, existing: IntakeFacts): IntakeFacts {
  const facts: IntakeFacts = { ...existing };
  const lower = text.toLowerCase();

  if (!facts.businessName) {
    const m =
      text.match(/(?:called|named|name is|business is|shop is|store is)\s+["']?([A-Za-z0-9'&][A-Za-z0-9'&. ]{1,58}?)["']?(?:[,.!]|$|\s+in\s|\s+we\s|\s+and\s)/i) ??
      text.match(/(?:i run|i own|we run|we own|i have|we have)\s+(?:a|an|the)?\s*(?:small\s+)?(?:business|shop|store|brand|company)?\s*(?:called\s+)?["']?([A-Za-z0-9'&][A-Za-z0-9'&. ]{1,58}?)["']?(?:[,.!]|$)/i);
    if (m) {
      facts.businessName = m[1].trim();
    } else if (text.trim().length <= 60 && !/[?]/.test(text)) {
      facts.businessName = text.trim();
    }
  }
  if (!facts.industry) {
    const hit = INDUSTRY_KEYWORDS.find((k) => lower.includes(k));
    if (hit) facts.industry = hit;
  }
  if (!facts.city) {
    const city = KNOWN_CITIES.find((c) => lower.includes(c));
    if (city) facts.city = city[0].toUpperCase() + city.slice(1);
  }
  if (!facts.delivery && /deliver|dispatch|pickup|ship/.test(lower)) {
    facts.delivery = /pickup|pick up/.test(lower) ? "pickup + delivery" : "offers delivery";
  }
  if (!facts.paymentPrefs) {
    const prefs = ["transfer", "cash", "card", "paystack", "mobile money", "pos"].filter((p) =>
      lower.includes(p),
    );
    if (prefs.length) facts.paymentPrefs = prefs;
  }
  const hints: string[] = [];
  if (/book|appoint/.test(lower)) hints.push("booking");
  if (/track|order status/.test(lower)) hints.push("tracking");
  if (/restock|suppl|wholesale/.test(lower)) hints.push("procurement");
  if (hints.length) facts.useCaseHints = Array.from(new Set([...(facts.useCaseHints ?? []), ...hints]));
  return facts;
}

// ─── Intake ──────────────────────────────────────────────────────────────────

async function handleIntake(session: OnboardingSession, text: string): Promise<CopilotReply[]> {
  // 1) Extract facts — LLM tool loop first, regex fallback after.
  const loop = await runToolLoop(
    session,
    "Extract any business facts from the latest user message with extractIntake. " +
      "If you already know the business name, also propose setup (see instructions). " +
      "Otherwise reply asking for the business name and what they sell.",
  );
  if (!loop.usedLlm) {
    session.intake.facts = extractFactsFallback(text, session.intake.facts);
  }

  const facts = session.intake.facts;
  if (!facts.businessName) {
    const reply: CopilotReply = {
      type: "text",
      text:
        loop.assistantText ??
        "Great to meet you! What's your business called, and what do you sell? " +
          "A city and how you handle delivery helps too.",
    };
    appendTranscript(session, "agent", reply.text);
    return [reply];
  }

  // 2) We have enough to propose — generate proposal cards.
  return generateProposals(session, loop.usedLlm);
}

// ─── Proposal generation (LLM + template fallback) ───────────────────────────

const PROPOSAL_ORDER: ProposalKind[] = ["waMenu", "useCases", "branding", "integrations"];

async function generateProposals(session: OnboardingSession, llmAvailable: boolean): Promise<CopilotReply[]> {
  await transition(session, "proposing");
  const replies: CopilotReply[] = [];

  if (llmAvailable) {
    const loop = await runToolLoop(
      session,
      "Propose the full setup now: call proposeWaMenu, proposeUseCases, proposeBranding and " +
        "proposeIntegrations based on the known facts. Do NOT apply anything — a human approves first.",
    );
    replies.push(...loop.replies);
  }

  // Template fallback for anything the LLM didn't propose — never dead-end.
  const proposedKinds = new Set(session.proposals.map((p) => p.kind));
  if (!proposedKinds.has("waMenu")) {
    const p = addProposal(session, {
      kind: "waMenu",
      summary: "WhatsApp menu (template): greeting + top use cases",
      payload: buildTemplateWaMenu(session.intake.facts),
    });
    replies.push(cardFor(p.id, session));
  }
  if (!proposedKinds.has("useCases")) {
    const ranked = buildRankedUseCases(session.intake.facts);
    const p = addProposal(session, {
      kind: "useCases",
      summary: `Suggested use cases: ${ranked.slice(0, 3).join(", ")}`,
      payload: { ranked },
    });
    replies.push(cardFor(p.id, session));
  }
  if (!proposedKinds.has("branding") && session.intake.facts.businessName) {
    try {
      const out = await executeCopilotTool("proposeBranding", {}, session);
      if (out.replies) replies.push(...out.replies);
    } catch {
      // Brand studio unreachable — skip branding proposal; flow continues.
    }
  }
  if (!proposedKinds.has("integrations")) {
    const providers = buildIntegrationSuggestions(session.intake.facts);
    const p = addProposal(session, {
      kind: "integrations",
      summary: `Suggested integrations: ${providers.map((x) => x.provider).join(", ")}`,
      payload: { providers },
    });
    replies.push(cardFor(p.id, session));
  }

  await transition(session, "approving");
  const intro: CopilotReply = {
    type: "text",
    text:
      `Here's the setup I propose for ${session.intake.facts.businessName}. ` +
      `Review each card — approve, edit or reject. Nothing is applied until you approve it.`,
  };
  appendTranscript(session, "agent", intro.text);
  for (const r of replies) appendTranscript(session, "agent", r.text);
  return [intro, ...replies];
}

function cardFor(proposalId: string, session: OnboardingSession): CopilotReply {
  const p = findProposal(session, proposalId)!;
  return {
    type: "card",
    text: `${p.summary}\n\n${JSON.stringify(p.payload, null, 2)}`,
    actions: [
      { id: `approve:${p.id}`, label: "Approve" },
      { id: `edit:${p.id}`, label: "Edit" },
      { id: `reject:${p.id}`, label: "Reject" },
    ],
  };
}

// ─── Approving: text-command decisions ───────────────────────────────────────

async function handleApproving(session: OnboardingSession, text: string): Promise<CopilotReply[]> {
  const lower = text.trim().toLowerCase();

  const decide = async (approve: boolean, target: string): Promise<CopilotReply | null> => {
    const pending = session.proposals.filter((p) => p.status === "pending");
    const matches =
      target === "all"
        ? pending
        : pending.filter((p) => p.id === target || p.kind.toLowerCase() === target);
    if (matches.length === 0) return null;
    for (const p of matches) p.status = approve ? "approved" : "rejected";
    return {
      type: "text",
      text: approve
        ? `Approved: ${matches.map((p) => p.kind).join(", ")}.`
        : `Rejected: ${matches.map((p) => p.kind).join(", ")}.`,
    };
  };

  let m = lower.match(/^approve(?:\s+(all|[a-z0-9-]+))?$/);
  if (m) {
    const r = await decide(true, m[1] ?? "all");
    if (r) {
      appendTranscript(session, "agent", r.text);
      if (session.proposals.every((p) => p.status !== "pending")) {
        const phase = await runConfigurationPhase(session);
        return [r, ...phase];
      }
      return [r];
    }
  }
  m = lower.match(/^reject\s+(all|[a-z0-9-]+)$/);
  if (m) {
    const r = await decide(false, m[1]);
    if (r) {
      appendTranscript(session, "agent", r.text);
      return [r];
    }
  }

  const reply: CopilotReply = {
    type: "text",
    text:
      "Please review the proposal cards above — reply \"approve all\", \"approve waMenu\", " +
      "or \"reject …\", or use the Approve/Edit buttons.",
  };
  appendTranscript(session, "agent", reply.text);
  return [reply];
}

// ─── Configuration phase (post-approval) ─────────────────────────────────────

/**
 * Apply every approved/edited proposal (checkpoint enforced in tools.ts),
 * push the WhatsApp profile, run validation, then go live or enter the
 * repair loop.
 */
export async function runConfigurationPhase(session: OnboardingSession): Promise<CopilotReply[]> {
  const replies: CopilotReply[] = [];
  await transition(session, "configuring");

  for (const kind of PROPOSAL_ORDER) {
    const approved = session.proposals.filter(
      (p) => p.kind === kind && (p.status === "approved" || p.status === "edited"),
    );
    for (const p of approved) {
      try {
        const out = await executeCopilotTool("applyProposal", { proposalId: p.id }, session);
        if (out.replies) replies.push(...out.replies);
      } catch (e: any) {
        replies.push({ type: "text", text: `Couldn't apply ${p.kind}: ${e?.message ?? e}` });
      }
    }
  }

  // Best-effort profile push (never throws per brand-studio contract).
  const brandingApproved = session.proposals.some(
    (p) => p.kind === "branding" && (p.status === "approved" || p.status === "edited"),
  );
  if (brandingApproved && session.tenantId) {
    try {
      const out = await executeCopilotTool("pushProfile", {}, session);
      if (out.replies) replies.push(...out.replies);
    } catch (e: any) {
      replies.push({ type: "text", text: `Profile push skipped: ${e?.message ?? e}` });
    }
  }

  if (!session.tenantId) {
    const r: CopilotReply = {
      type: "text",
      text: "No proposals were approved, so there's nothing to set up yet. Tell me what you'd like to change!",
    };
    await transition(session, "intake");
    replies.push(r);
    return replies;
  }

  // Validation → live or repair.
  await transition(session, "validating");
  let report: ValidationReport | null = null;
  try {
    const out = await executeCopilotTool("runValidation", {}, session);
    report = out.result as ValidationReport;
  } catch (e: any) {
    report = { passed: false, checks: [{ check: "internal", ok: false, detail: String(e?.message ?? e) }] };
  }

  if (report?.passed) {
    try {
      await executeCopilotTool("goLive", {}, session);
      await transition(session, "live");
      const r: CopilotReply = {
        type: "text",
        text: "🎉 All checks passed — your WhatsApp commerce assistant is LIVE! Customers can message you now.",
      };
      appendTranscript(session, "agent", r.text);
      replies.push(r);
    } catch (e: any) {
      const r: CopilotReply = { type: "text", text: `Validation passed but go-live failed: ${e?.message ?? e}` };
      appendTranscript(session, "agent", r.text);
      replies.push(r);
      await transition(session, "configuring");
    }
    return replies;
  }

  // Failed → targeted repair questions (state → configuring, or failed at cap).
  const outcome = await runRepairRound(session, report ?? { passed: false, checks: [] });
  replies.push(...outcome.replies);
  return replies;
}

// ─── Configuring (repair answers / credential fixes) ─────────────────────────

const WA_TOKEN_RE = /\b(EAA[A-Za-z0-9]{10,}|(?:token\s*(?:is|=|:)\s*)([A-Za-z0-9_-]{20,}))\b/i;
const PHONE_ID_RE = /(?:phone\s*(?:number)?\s*id\s*(?:is|=|:)\s*)(\d{6,})/i;

async function handleConfiguring(session: OnboardingSession, text: string): Promise<CopilotReply[]> {
  const replies: CopilotReply[] = [];

  // Try to capture WhatsApp credential fixes from the reply.
  const tokenMatch = text.match(WA_TOKEN_RE);
  const token = tokenMatch ? (tokenMatch[2] ?? tokenMatch[1]) : null;
  const phoneIdMatch = text.match(PHONE_ID_RE);
  const phoneId = phoneIdMatch ? phoneIdMatch[1] : null;

  if (session.tenantId && (token || phoneId)) {
    const db = await getDb();
    if (db && phoneId) {
      await db
        .update(tenants)
        .set({ whatsappPhoneNumberId: phoneId, updatedAt: new Date() })
        .where(eq(tenants.id, session.tenantId));
    }
    if (token) {
      await updateTenantSettings(session.tenantId, (s) => {
        s.whatsapp = { ...(s.whatsapp ?? {}), accessToken: token };
      });
    }
    appendTranscript(session, "system", "operator supplied updated WhatsApp credentials");
    replies.push({ type: "text", text: "Got it — credentials updated. Re-running the checks…" });
  } else if (!token && !phoneId) {
    const note: CopilotReply = {
      type: "text",
      text:
        "Thanks — once you've updated the setting, paste the new value here (e.g. \"token is EAA…\" " +
        "or \"phone number id is 123456\") and I'll re-run the validation.",
    };
    replies.push(note);
  }

  // Re-run validation whenever we have a tenant.
  if (session.tenantId) {
    await transition(session, "validating");
    let report: ValidationReport | null = null;
    try {
      const out = await executeCopilotTool("runValidation", {}, session);
      report = out.result as ValidationReport;
    } catch (e: any) {
      report = { passed: false, checks: [{ check: "internal", ok: false, detail: String(e?.message ?? e) }] };
    }
    if (report?.passed) {
      try {
        await executeCopilotTool("goLive", {}, session);
        await transition(session, "live");
        const r: CopilotReply = {
          type: "text",
          text: "🎉 All checks passed — you're LIVE! Your customers can now message your business on WhatsApp.",
        };
        appendTranscript(session, "agent", r.text);
        replies.push(r);
      } catch (e: any) {
        replies.push({ type: "text", text: `Validation passed but go-live failed: ${e?.message ?? e}` });
        await transition(session, "configuring");
      }
      return replies;
    }
    const outcome = await runRepairRound(session, report ?? { passed: false, checks: [] });
    replies.push(...outcome.replies);
  }

  for (const r of replies) {
    if (!session.transcript.some((t) => t.role === "agent" && t.text === r.text)) {
      appendTranscript(session, "agent", r.text);
    }
  }
  return replies;
}

// ─── Entry point ─────────────────────────────────────────────────────────────

/**
 * Run one conversation turn. Mutates the session in-memory; the caller
 * (index.ts) persists and audits.
 */
export async function runAgentTurn(session: OnboardingSession, text: string): Promise<CopilotReply[]> {
  switch (session.state) {
    case "intake":
      return handleIntake(session, text);
    case "proposing":
    case "approving":
      return handleApproving(session, text);
    case "configuring":
    case "validating":
      return handleConfiguring(session, text);
    case "live": {
      const r: CopilotReply = {
        type: "text",
        text: "You're already live! Use the admin dashboard to tweak menus, branding or integrations.",
      };
      appendTranscript(session, "agent", r.text);
      return [r];
    }
    case "failed": {
      const r: CopilotReply = {
        type: "text",
        text:
          "This onboarding run hit its retry limit" +
          (session.error ? ` (${session.error})` : "") +
          ". Please contact support, or start a new session.",
      };
      appendTranscript(session, "agent", r.text);
      return [r];
    }
    default: {
      const r: CopilotReply = { type: "text", text: "This session was abandoned. Start a new one to continue." };
      appendTranscript(session, "agent", r.text);
      return [r];
    }
  }
}
