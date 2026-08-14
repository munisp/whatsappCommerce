/**
 * onboardingCopilot/index.ts — public service API for the agentic onboarding
 * copilot. Routers (admin channel) and the WhatsApp inbound path (C3) code
 * against EXACTLY these functions — no SQL.
 *
 * Checkpoint invariant: proposals are created by the agent freely, but only a
 * human decision (decideProposal → 'approved' | 'edited') unlocks
 * applyProposal / pushProfile / goLive. Enforcement lives in the service
 * layer (tools.ts / session.ts), never in the LLM prompt.
 */
import { z } from "zod";
import { parseWaMenuConfig, waUseCaseSchema, WA_USE_CASE_IDS } from "../../../shared/waMenu";
import { INTEGRATION_PROVIDERS } from "../../../shared/tenantConfig";
import { writeAuditLog } from "../../routers/audit";
import {
  appendTranscript,
  createSessionRow,
  findActiveSessionRowByPhone,
  findProposal,
  listSessionRows,
  loadSession,
  saveSession,
  supersedeActiveSessionsForPhone,
  type CopilotChannel,
  type CopilotReply,
  type OnboardingSession,
} from "./session";
import { advanceToLive, runAgentTurn, runConfigurationPhase } from "./agent";
import { sessionLanguage, t, isCopilotLanguage, type CopilotLanguage } from "./language";

export {
  COPILOT_LANGUAGES,
  DEFAULT_COPILOT_LANGUAGE,
  LANGUAGE_NAMES,
  COPILOT_TEXT_PACKS,
  detectMessageLanguage,
  parseExplicitLanguageChoice,
  resolveTurnLanguage,
  sessionLanguage,
  isCopilotLanguage,
  t,
  type CopilotLanguage,
  type CopilotTextPack,
  type LanguageDetection,
} from "./language";

export {
  COPILOT_STATES,
  COPILOT_CHANNELS,
  TERMINAL_STATES,
  MAX_REPAIR_ROUNDS,
  type CopilotState,
  type CopilotChannel,
  type CopilotReply,
  type CopilotAction,
  type TranscriptEntry,
  type Proposal,
  type ProposalKind,
  type ProposalStatus,
  type IntakeFacts,
  type OnboardingSession,
} from "./session";
export { repairQuestionFor, runRepairRound } from "./repair";
export { executeCopilotTool, COPILOT_TOOL_NAMES } from "./tools";
export { runAgentTurn } from "./agent";

// ─── Edited-payload validation (never persist invalid) ──────────────────────

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "must be a hex color like #8A5A2B");

const editedBrandingSchema = z.object({
  logoSvgDataUri: z.string().max(200000).optional(),
  logoUrl: z.string().url().nullable().optional(),
  primaryColor: hexColor,
  secondaryColor: hexColor.optional(),
  tagline: z.string().max(120).optional(),
  waProfileAbout: z.string().max(139).optional(),
});

const editedUseCasesSchema = z.union([
  z.object({ ranked: z.array(z.enum(WA_USE_CASE_IDS)).min(1).max(WA_USE_CASE_IDS.length) }),
  z.object({ useCases: z.array(waUseCaseSchema).min(1) }),
]);

const editedIntegrationsSchema = z.object({
  providers: z
    .array(z.object({ provider: z.enum(INTEGRATION_PROVIDERS), reason: z.string().max(300) }))
    .min(1)
    .max(3),
});

function validateEditedPayload(kind: string, payload: unknown): unknown {
  if (kind === "waMenu") return parseWaMenuConfig(payload); // throws ZodError
  if (kind === "branding") return editedBrandingSchema.parse(payload);
  if (kind === "useCases") return editedUseCasesSchema.parse(payload);
  if (kind === "integrations") return editedIntegrationsSchema.parse(payload);
  if (kind === "goLive") throw new Error("goLive proposals cannot be edited — approve or reject them");
  throw new Error(`Unknown proposal kind "${kind}"`);
}

// ─── Service API ─────────────────────────────────────────────────────────────

export async function startSession(args: {
  channel: CopilotChannel;
  tenantId?: string;
  phone?: string;
  /** Wave 15 (F5): caller-known language (sticky locale / menu selection). */
  language?: CopilotLanguage;
}): Promise<{ sessionId: string; greeting: string }> {
  // C3 contract ("restart" = startSession again for the same phone): supersede
  // any prior ACTIVE whatsapp session for this phone so
  // findActiveSessionByPhone only ever returns the fresh one.
  if (args.channel === "whatsapp" && args.phone) {
    const superseded = await supersedeActiveSessionsForPhone(args.phone);
    for (const id of superseded) {
      await writeAuditLog({
        actorId: `copilot:${id}`,
        actorRole: "system",
        action: "onboarding_copilot.session_superseded",
        entityType: "onboarding_session",
        entityId: id,
        summary: `session superseded by a new session for phone ${args.phone}`,
      });
    }
  }
  const session = await createSessionRow({
    channel: args.channel,
    tenantId: args.tenantId ?? null,
    phone: args.phone ?? null,
  });
  if (isCopilotLanguage(args.language)) {
    session.intake.language = args.language;
  }
  const greeting = t(sessionLanguage(session), "greeting");
  appendTranscript(session, "agent", greeting);
  await saveSession(session);
  await writeAuditLog({
    actorId: `copilot:${session.id}`,
    actorRole: "system",
    action: "onboarding_copilot.session_start",
    entityType: "onboarding_session",
    entityId: session.id,
    tenantId: session.tenantId ?? undefined,
    summary: `session started on ${args.channel} channel`,
    after: { channel: args.channel, phone: args.phone ?? null, language: sessionLanguage(session) },
  });
  return { sessionId: session.id, greeting };
}

export async function postMessage(args: {
  sessionId: string;
  text: string;
}): Promise<{ replies: CopilotReply[]; state: string }> {
  const session = await loadSession(args.sessionId);
  if (!session) throw new Error(`Onboarding session "${args.sessionId}" not found`);

  // C3 contract — IDEMPOTENT postMessage: Meta redeliveries can invoke
  // postMessage repeatedly with the same text (C3's webhook branch skips
  // webhook dedupe for the platform number). An exact repeat of the most
  // recently processed inbound text is a no-op: no transcript append, no
  // state transition, no duplicate proposals.
  const lastInbound = session.intake.lastInbound as { text?: string; ts?: string } | undefined;
  if (lastInbound?.text === args.text) {
    return { replies: [], state: session.state };
  }
  session.intake.lastInbound = { text: args.text, ts: new Date().toISOString() };

  appendTranscript(session, "user", args.text);
  const replies = await runAgentTurn(session, args.text);
  await saveSession(session);
  return { replies, state: session.state };
}

export async function decideProposal(args: {
  sessionId: string;
  proposalId: string;
  approve: boolean;
  editedPayload?: unknown;
}): Promise<{ ok: boolean; replies: CopilotReply[] }> {
  const session = await loadSession(args.sessionId);
  if (!session) throw new Error(`Onboarding session "${args.sessionId}" not found`);
  const proposal = findProposal(session, args.proposalId);
  if (!proposal) throw new Error(`Unknown proposal "${args.proposalId}"`);
  if (proposal.status !== "pending") {
    throw new Error(`Proposal "${args.proposalId}" is already ${proposal.status}`);
  }

  const lang = sessionLanguage(session);
  const replies: CopilotReply[] = [];
  if (!args.approve) {
    proposal.status = "rejected";
    const text = t(lang, "decideDiscarded", { kind: proposal.kind });
    appendTranscript(session, "agent", text);
    replies.push({ type: "text", text });
  } else if (args.editedPayload !== undefined) {
    // 'edited' carries the caller-supplied payload — validated before storing.
    proposal.payload = validateEditedPayload(proposal.kind, args.editedPayload);
    proposal.status = "edited";
    const text = t(lang, "decideEdited", { kind: proposal.kind });
    appendTranscript(session, "agent", text);
    replies.push({ type: "text", text });
  } else {
    proposal.status = "approved";
    const text = t(lang, "decideApproved", { kind: proposal.kind });
    appendTranscript(session, "agent", text);
    replies.push({ type: "text", text });
  }

  await writeAuditLog({
    actorId: `copilot:${session.id}`,
    actorRole: "system",
    action: "onboarding_copilot.decision",
    entityType: "onboarding_session",
    entityId: session.id,
    tenantId: session.tenantId ?? undefined,
    summary: `proposal ${proposal.id} (${proposal.kind}) → ${proposal.status}`,
    after: { proposalId: proposal.id, kind: proposal.kind, status: proposal.status },
  });

  // C4 contract: approving the terminal goLive proposal advances
  // validating → live (goLive checkpoint re-verified in the service layer).
  if (proposal.kind === "goLive") {
    if (proposal.status === "approved") {
      try {
        replies.push(...(await advanceToLive(session)));
      } catch (e: any) {
        const text = t(lang, "couldNotGoLive", { error: String(e?.message ?? e) });
        appendTranscript(session, "agent", text);
        replies.push({ type: "text", text });
      }
    }
    await saveSession(session);
    return { ok: true, replies };
  }

  // When every proposal is decided and at least one was approved/edited,
  // run the configuration phase (apply → validate → goLive proposal/repair).
  if (
    session.proposals.length > 0 &&
    session.proposals.every((p) => p.status !== "pending") &&
    session.proposals.some((p) => p.status === "approved" || p.status === "edited")
  ) {
    const phaseReplies = await runConfigurationPhase(session);
    replies.push(...phaseReplies);
  }

  await saveSession(session);
  return { ok: true, replies };
}

export async function getSession(sessionId: string): Promise<OnboardingSession | null> {
  return loadSession(sessionId);
}

export async function findActiveSessionByPhone(phone: string): Promise<OnboardingSession | null> {
  return findActiveSessionRowByPhone(phone);
}

export async function listSessions(filter?: { tenantId?: string }): Promise<OnboardingSession[]> {
  return listSessionRows(filter);
}
