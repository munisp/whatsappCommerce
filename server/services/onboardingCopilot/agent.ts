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
      facts.businessName = m[1].trim().replace(/^(?:called|named)\s+/i, "");
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

  // Anything else in approving state is REVISION feedback (the edit path):
  // re-draft the affected proposals instead of dead-ending.
  return handleRevision(session, text);
}

// ─── Revision feedback (free-text edits while approving) ────────────────────

/**
 * Proposal kinds the feedback plausibly targets. Kinds with NO pending
 * proposal (e.g. just rejected via the Edit button) are always re-drafted —
 * that is the core edit-path contract: reject → free-text feedback → re-draft.
 */
function revisionTargetKinds(session: OnboardingSession, text: string): ProposalKind[] {
  const lower = text.toLowerCase();
  const kinds = new Set<ProposalKind>();
  if (/purple|violet|lilac|blue|navy|green|red|orange|amber|pink|rose|teal|colou?r|logo|brand|tagline/.test(lower)) {
    kinds.add("branding");
  }
  if (/greet|welcome|warm|friendl|menu/.test(lower)) kinds.add("waMenu");
  if (/use case|feature|flow/.test(lower)) kinds.add("useCases");
  if (/integration|medusa|odoo|twenty|crm/.test(lower)) kinds.add("integrations");
  for (const k of PROPOSAL_ORDER) {
    if (k === "goLive") continue;
    if (!session.proposals.some((p) => p.kind === k && p.status === "pending")) kinds.add(k);
  }
  return Array.from(kinds);
}

/** Deterministic re-draft for one kind (LLM-down supplement / fallback). */
async function redraftKind(
  session: OnboardingSession,
  kind: ProposalKind,
  feedback: string,
): Promise<CopilotReply | null> {
  if (kind === "waMenu") {
    const menu = buildTemplateWaMenu(session.intake.facts);
    if (/greet|welcome|warm|friendl/.test(feedback.toLowerCase())) {
      menu.greeting = `A very warm welcome to {businessName}! We're so glad you're here — how can we help today?`;
    }
    const p = addProposal(session, {
      kind: "waMenu",
      summary: "WhatsApp menu (revised): greeting + top use cases",
      payload: menu,
    });
    return cardFor(p.id, session);
  }
  if (kind === "useCases") {
    const ranked = buildRankedUseCases(session.intake.facts);
    const p = addProposal(session, {
      kind: "useCases",
      summary: `Suggested use cases (revised): ${ranked.slice(0, 3).join(", ")}`,
      payload: { ranked },
    });
    return cardFor(p.id, session);
  }
  if (kind === "branding") {
    try {
      const out = await executeCopilotTool("proposeBranding", { vibe: feedback }, session);
      return out.replies?.[0] ?? null;
    } catch {
      return null; // brand studio unreachable — flow continues
    }
  }
  if (kind === "integrations") {
    const providers = buildIntegrationSuggestions(session.intake.facts);
    const p = addProposal(session, {
      kind: "integrations",
      summary: `Suggested integrations (revised): ${providers.map((x) => x.provider).join(", ")}`,
      payload: { providers },
    });
    return cardFor(p.id, session);
  }
  return null;
}

/**
 * Free-text feedback while proposals await approval ("use purple colors and a
 * warmer greeting"): re-draft the affected proposal kinds so the edit path
 * never dead-ends. LLM tool loop first, deterministic re-draft for anything
 * it missed. The checkpoint invariant is untouched: re-drafted proposals
 * arrive PENDING and still require human approval.
 */
async function handleRevision(session: OnboardingSession, text: string): Promise<CopilotReply[]> {
  const replies: CopilotReply[] = [];

  const loop = await runToolLoop(
    session,
    `The user reviewed the proposals and requested these changes: ${text}\n` +
      "Re-draft the affected proposal(s) by calling the matching propose* tool(s) " +
      "again with updated content (e.g. proposeBranding with the requested vibe, " +
      "proposeWaMenu with a revised greeting). Do NOT apply anything — a human " +
      "approves first.",
  );
  replies.push(...loop.replies);

  // Deterministic supplement: re-draft any affected kind the LLM missed.
  const pendingKinds = new Set(
    session.proposals.filter((p) => p.status === "pending").map((p) => p.kind),
  );
  for (const kind of revisionTargetKinds(session, text)) {
    if (pendingKinds.has(kind)) continue;
    const drafted = await redraftKind(session, kind, text);
    if (drafted) replies.push(drafted);
  }

  if (replies.length === 0) {
    const reply: CopilotReply = {
      type: "text",
      text:
        "Please review the proposal cards above — reply \"approve all\", \"approve waMenu\", " +
        "or \"reject …\", or use the Approve/Edit buttons.",
    };
    appendTranscript(session, "agent", reply.text);
    return [reply];
  }

  await transition(session, "approving");
  const intro: CopilotReply = {
    type: "text",
    text: "I've reworked the proposal(s) with your changes — take another look and approve when ready.",
  };
  appendTranscript(session, "agent", intro.text);
  for (const r of replies) appendTranscript(session, "agent", r.text);
  return [intro, ...replies];
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
    replies.push(...(await emitGoLiveProposal(session, report)));
    return replies;
  }

  // Failed → targeted repair questions (state → configuring, or failed at cap).
  const outcome = await runRepairRound(session, report ?? { passed: false, checks: [] });
  replies.push(...outcome.replies);
  return replies;
}

/**
 * C4 contract: when validation passes, emit a TERMINAL 'goLive' proposal
 * (checkpoint) instead of going live automatically. The session stays in
 * 'validating'; approving the proposal (decideProposal) or the literal
 * "go live" text command advances validating → live.
 */
export async function emitGoLiveProposal(
  session: OnboardingSession,
  report: ValidationReport,
): Promise<CopilotReply[]> {
  let proposal = session.proposals.find((p) => p.kind === "goLive" && p.status === "pending");
  if (!proposal) {
    proposal = addProposal(session, {
      kind: "goLive",
      summary: `All ${report.checks.length} validation check(s) passed — go live`,
      payload: { checks: report.checks, validatedAt: new Date().toISOString() },
    });
  }
  const text =
    "🎉 All validation checks passed! One last step: approve go-live to switch your " +
    "WhatsApp assistant on for customers (or reply \"go live\").";
  appendTranscript(session, "agent", text);
  return [{ type: "text", text }, cardFor(proposal.id, session)];
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
      replies.push(...(await emitGoLiveProposal(session, report)));
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

// ─── Literal "go live" command (C4 contract) ─────────────────────────────────

const LIVE_REPLY =
  "🎉 You're LIVE! Your customers can now message your business on WhatsApp.";

/**
 * Shared go-live advance used by BOTH the literal "go live" command and the
 * goLive proposal approval path. Requires the tenant-side validation to have
 * passed (enforced again inside the goLive tool — checkpoint).
 */
export async function advanceToLive(session: OnboardingSession): Promise<CopilotReply[]> {
  await executeCopilotTool("goLive", {}, session); // throws when validation hasn't passed
  const pending = session.proposals.find((p) => p.kind === "goLive" && p.status === "pending");
  if (pending) pending.status = "approved";
  await transition(session, "live");
  appendTranscript(session, "agent", LIVE_REPLY);
  return [{ type: "text", text: LIVE_REPLY }];
}

/**
 * C4 contract: literal "go live" (case-insensitive) in postMessage.
 * state=validating + checks passed → advance to live; otherwise reply
 * explaining exactly what's missing.
 */
async function handleGoLiveCommand(session: OnboardingSession): Promise<CopilotReply[]> {
  if (session.state === "live") {
    const r: CopilotReply = { type: "text", text: "You're already live! 🎉" };
    appendTranscript(session, "agent", r.text);
    return [r];
  }
  if (session.state === "validating") {
    try {
      return await advanceToLive(session);
    } catch (e: any) {
      const r: CopilotReply = {
        type: "text",
        text: `Not yet — ${e?.message ?? "validation has not passed"}.`,
      };
      appendTranscript(session, "agent", r.text);
      return [r];
    }
  }
  const missing =
    session.state === "intake"
      ? "we haven't finished intake — tell me about your business first."
      : session.state === "proposing" || session.state === "approving"
        ? `there are ${session.proposals.filter((p) => p.status === "pending").length} proposal(s) waiting for your approval — approve them first.`
        : session.state === "configuring"
          ? "validation hasn't passed yet — fix the failing checks above and I'll re-run them."
          : `this session is ${session.state} — start a new session to onboard.`;
  const r: CopilotReply = { type: "text", text: `Not ready to go live: ${missing}` };
  appendTranscript(session, "agent", r.text);
  return [r];
}

// ─── Entry point ─────────────────────────────────────────────────────────────

/**
 * Run one conversation turn. Mutates the session in-memory; the caller
 * (index.ts) persists and audits.
 */
export async function runAgentTurn(session: OnboardingSession, text: string): Promise<CopilotReply[]> {
  // C4: literal "go live" is a command in any state.
  if (text.trim().toLowerCase() === "go live") {
    return handleGoLiveCommand(session);
  }
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
