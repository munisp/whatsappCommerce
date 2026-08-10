/**
 * waOnboarding.ts — WhatsApp conversational onboarding intake (wave 9 / C3).
 *
 * A prospective tenant messages the PLATFORM's own WhatsApp number and the
 * onboarding copilot (w9 / C1, server/services/onboardingCopilot) onboards
 * them end-to-end in chat. The Meta webhook (server/_core/index.ts) routes
 * any message whose `metadata.phone_number_id` matches
 * ONBOARDING_PHONE_NUMBER_ID here BEFORE tenant resolution — the sender has
 * no tenant row yet.
 *
 * Credentials: outbound sends use the platform onboarding number's own creds
 * (ONBOARDING_WA_TOKEN + ONBOARDING_PHONE_NUMBER_ID), NOT tenant creds and
 * NOT the shared WAC_WHATSAPP_* fallback. Unset creds → log + no-op
 * (simulation), so an unconfigured deploy is fully inert.
 *
 * Wire protocol for proposal-card buttons: C1 action ids (`approve:<pid>`,
 * `edit:<pid>`) are sent to Meta as `onb_approve:<pid>` / `onb_edit:<pid>`
 * so inbound button replies are unambiguous. Meta allows at most 3 reply
 * buttons per message — cards with more actions fall back to a numbered
 * text list.
 *
 * Fail-safe contract: handleInbound NEVER throws. Any copilot/transport
 * failure is logged and answered with a friendly "type restart" message so
 * the webhook always completes its 200 ack path.
 */

import {
  buildInteractivePayload,
  chunkWhatsAppText,
  normalizeWaPhone,
  WA_BUTTONS_MAX,
} from "./waSender";
import { isTranscriptionConfigured, transcribeAudio } from "./transcribe";

// ── w9 C1 copilot contract (structural) ─────────────────────────────────────
// These interfaces mirror the API exported by
// server/services/onboardingCopilot/index.ts (wave 9 / C1). They are declared
// locally so tests can inject a DB/LLM-free copilot; loadCopilot assigns the
// REAL module to OnboardingCopilotApi so any contract drift fails tsc.

export type OnboardingSessionState =
  | "intake"
  | "proposing"
  | "approving"
  | "configuring"
  | "validating"
  | "live"
  | "failed"
  | "abandoned";

export interface OnboardingSession {
  id: string;
  channel: "admin" | "whatsapp" | string;
  state: OnboardingSessionState | string;
  phone?: string | null;
  tenantId?: string | null;
}

export interface CopilotReplyAction {
  id: string;
  label: string;
}

export interface CopilotReply {
  type: "text" | "card";
  text: string;
  actions?: CopilotReplyAction[];
}

export interface OnboardingCopilotApi {
  startSession(args: {
    channel: "admin" | "whatsapp";
    tenantId?: string;
    phone?: string;
  }): Promise<{ sessionId: string; greeting: string }>;
  postMessage(args: {
    sessionId: string;
    text: string;
  }): Promise<{ replies: CopilotReply[]; state: string }>;
  decideProposal(args: {
    sessionId: string;
    proposalId: string;
    approve: boolean;
    editedPayload?: unknown;
  }): Promise<{ ok: boolean; replies: CopilotReply[] }>;
  getSession(sessionId: string): Promise<OnboardingSession | null>;
  findActiveSessionByPhone(phone: string): Promise<OnboardingSession | null>;
}

let copilotOverride: OnboardingCopilotApi | null = null;

/**
 * Dependency-injection hook for tests (the real w9 C1 module is resolved
 * lazily when this is null — keeps unit tests DB/LLM-free).
 */
export function setOnboardingCopilot(api: OnboardingCopilotApi | null): void {
  copilotOverride = api;
}

async function loadCopilot(): Promise<OnboardingCopilotApi> {
  if (copilotOverride) return copilotOverride;
  try {
    const mod = await import("./onboardingCopilot");
    // Compile-time compatibility check: the real w9 C1 module must satisfy the
    // structural contract above (a drift breaks tsc, not production).
    const api: OnboardingCopilotApi = mod;
    return api;
  } catch (e: any) {
    throw new Error(
      `[waOnboarding] onboarding copilot core unavailable: ${e?.message ?? e}`,
    );
  }
}

// ── Platform onboarding-number credentials ──────────────────────────────────

export interface OnboardingWaCredentials {
  phoneNumberId: string;
  accessToken: string;
}

/**
 * Resolve the platform onboarding number's creds from env. Read at call time
 * (same convention as waSender env fallbacks) so test stubbing works.
 * Returns null when unconfigured — callers log + no-op (simulation).
 */
export function resolveOnboardingWaCredentials(): OnboardingWaCredentials | null {
  const phoneNumberId = (process.env.ONBOARDING_PHONE_NUMBER_ID ?? "").trim();
  const accessToken = (process.env.ONBOARDING_WA_TOKEN ?? "").trim();
  if (!phoneNumberId || !accessToken) return null;
  return { phoneNumberId, accessToken };
}

/**
 * Webhook routing predicate: true only when ONBOARDING_PHONE_NUMBER_ID is
 * configured AND the inbound payload's metadata.phone_number_id matches it.
 * Unset env → always false → the normal tenant dispatch path is untouched.
 */
export function isOnboardingIntakeNumber(phoneNumberId: string | null | undefined): boolean {
  const configured = (process.env.ONBOARDING_PHONE_NUMBER_ID ?? "").trim();
  return configured.length > 0 && !!phoneNumberId && phoneNumberId.trim() === configured;
}

// ── Outbound senders (platform onboarding number) ───────────────────────────

const GRAPH_API_BASE = "https://graph.facebook.com/v21.0";

interface OnboardingSendResult {
  sent: boolean;
  simulated: boolean;
}

/**
 * Single-payload delivery through the onboarding number's creds. Never
 * throws: unconfigured creds → simulation no-op; network/API errors → log.
 */
async function postOnboardingMessage(
  toPhone: string,
  payload: Record<string, unknown>,
): Promise<OnboardingSendResult> {
  const to = normalizeWaPhone(toPhone);
  const creds = resolveOnboardingWaCredentials();
  if (!creds) {
    console.info(
      `[waOnboarding] send skipped (ONBOARDING_WA_TOKEN / ONBOARDING_PHONE_NUMBER_ID unset) → *${to.slice(-4)}`,
    );
    return { sent: false, simulated: true };
  }
  try {
    const res = await fetch(`${GRAPH_API_BASE}/${creds.phoneNumberId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${creds.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        ...payload,
      }),
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      console.error(`[waOnboarding] send failed (${res.status}): ${errBody.slice(0, 300)}`);
      return { sent: false, simulated: false };
    }
    return { sent: true, simulated: false };
  } catch (e: any) {
    console.error("[waOnboarding] send network error:", e?.message);
    return { sent: false, simulated: false };
  }
}

/** Send a text message from the platform onboarding number (chunked). */
export async function sendOnboardingText(
  toPhone: string,
  body: string,
): Promise<OnboardingSendResult> {
  const chunks = chunkWhatsAppText(body);
  let last: OnboardingSendResult = { sent: false, simulated: false };
  for (const chunk of chunks) {
    last = await postOnboardingMessage(toPhone, {
      type: "text",
      text: { preview_url: true, body: chunk },
    });
  }
  return last;
}

/** Prefix every copilot action id with `onb_` for the Meta wire format. */
export const ONB_WIRE_PREFIX = "onb_";

export function toWireActionId(actionId: string): string {
  return actionId.startsWith(ONB_WIRE_PREFIX) ? actionId : `${ONB_WIRE_PREFIX}${actionId}`;
}

/**
 * Send a proposal card as an interactive button message (≤ WA_BUTTONS_MAX
 * actions — the Meta hard limit). Caller handles the >3 fallback.
 */
export async function sendOnboardingButtons(
  toPhone: string,
  body: string,
  actions: CopilotReplyAction[],
): Promise<OnboardingSendResult> {
  const buttons = actions.slice(0, WA_BUTTONS_MAX).map((a) => ({
    id: toWireActionId(a.id),
    title: a.label,
  }));
  const interactive = buildInteractivePayload({
    bodyText: body,
    action: { type: "button", buttons },
  });
  return postOnboardingMessage(toPhone, { type: "interactive", interactive });
}

/** Numbered-list text fallback for cards with more than 3 actions. */
export function renderNumberedActionList(body: string, actions: CopilotReplyAction[]): string {
  const lines = actions.map((a, i) => `${i + 1}. ${a.label}`);
  return (
    `${body}\n\n${lines.join("\n")}\n\n` +
    `Reply with what you'd like to do (e.g. "approve" or describe your changes).`
  );
}

/**
 * Parse an inbound button/list reply id back into a copilot decision.
 * Accepts only `onb_approve:<proposalId>` / `onb_edit:<proposalId>` with a
 * non-empty proposalId; anything else (stale platform buttons, tenant menu
 * ids, malformed ids) returns null.
 */
export function parseOnboardingActionId(
  raw: string | null | undefined,
): { kind: "approve" | "edit"; proposalId: string } | null {
  if (!raw) return null;
  const id = raw.trim();
  if (!id.startsWith(ONB_WIRE_PREFIX)) return null;
  const rest = id.slice(ONB_WIRE_PREFIX.length);
  const sep = rest.indexOf(":");
  if (sep <= 0) return null;
  const kind = rest.slice(0, sep);
  const proposalId = rest.slice(sep + 1).trim();
  if ((kind !== "approve" && kind !== "edit") || proposalId.length === 0) return null;
  return { kind, proposalId };
}

// ── Voice notes ─────────────────────────────────────────────────────────────

/**
 * Download + transcribe an inbound voice note using the onboarding number's
 * creds and the repo's pluggable transcriber. Fail-soft: returns null when
 * transcription is not configured or any step fails (caller replies with a
 * polite "please type" message).
 */
async function transcribeOnboardingVoiceNote(
  mediaId: string,
  mimeType: string | null | undefined,
): Promise<string | null> {
  if (!isTranscriptionConfigured()) return null;
  const creds = resolveOnboardingWaCredentials();
  if (!creds) return null;
  const meta = await fetch(`${GRAPH_API_BASE}/${mediaId}`, {
    headers: { Authorization: `Bearer ${creds.accessToken}` },
    signal: AbortSignal.timeout(12000),
  })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  const url = typeof meta?.url === "string" ? meta.url : null;
  if (!url) return null;
  const bin = await fetch(url, {
    headers: { Authorization: `Bearer ${creds.accessToken}` },
    signal: AbortSignal.timeout(30000),
  })
    .then((r) => (r.ok ? r.arrayBuffer() : null))
    .catch(() => null);
  if (!bin) return null;
  const result = await transcribeAudio({
    audio: Buffer.from(bin),
    mimeType: mimeType ?? (typeof meta?.mime_type === "string" ? meta.mime_type : "audio/ogg"),
  });
  return result.text;
}

// ── Inbound orchestration ───────────────────────────────────────────────────

export type InboundOutcomeKind =
  | "greeting"
  | "message"
  | "approve"
  | "edit_prompt"
  | "edit_applied"
  | "restart"
  | "voice_note"
  | "voice_unavailable"
  | "unsupported"
  | "malformed_action"
  | "error";

export interface InboundOutcome {
  handled: boolean;
  outcome: InboundOutcomeKind;
}

/** "restart" / "start over" abandons the current session at any point. */
export const RESTART_PATTERN = /^\s*(restart|start over)\s*$/i;

const FAILSAFE_MESSAGE =
  "Something went wrong on my end — sorry about that. Type *restart* to try again. 🙏";

const EDIT_PROMPT_MESSAGE =
  "Sure — reply with your changes in one message and I'll rework the proposal.";

const MALFORMED_ACTION_MESSAGE =
  "Sorry, that button didn't work (it may have expired). Tell me what you'd like to do, or type *restart* to begin again.";

const VOICE_UNAVAILABLE_MESSAGE =
  "I couldn't process that voice note — could you type it out instead? ✍️";

const UNSUPPORTED_MESSAGE =
  "I can only read text and voice notes for now — tell me about your business in words. 🙂";

/**
 * Proposals awaiting a free-text edit, keyed by normalized sender phone.
 * In-memory is sufficient: the webhook runs in a single process and a lost
 * entry degrades gracefully (the text is treated as a normal message).
 * Exported for tests.
 */
export const pendingEditProposals = new Map<string, string>();

function appUrl(): string {
  return (process.env.APP_URL ?? "http://localhost:3000").replace(/\/+$/, "");
}

/** Terminal-state follow-up message, or null for non-terminal states. */
export function terminalStateMessage(state: string | null | undefined): string | null {
  if (state === "live") {
    return (
      `🎉 Congratulations — your store is live!\n\n` +
      `Next steps:\n` +
      `1. Connect your own WhatsApp number via embedded signup: ${appUrl()}/settings/whatsapp\n` +
      `2. Manage everything from your admin portal: ${appUrl()}\n\n` +
      `Welcome aboard! 🚀`
    );
  }
  if (state === "failed") {
    return (
      `I'm sorry — the setup hit a problem and couldn't complete. The details above explain what went wrong.\n\n` +
      `Type *restart* and we'll try again together. 🙏`
    );
  }
  return null;
}

/** Deliver a batch of copilot replies (text bubbles + proposal cards). */
async function deliverCopilotReplies(toPhone: string, replies: CopilotReply[] | undefined): Promise<void> {
  for (const reply of replies ?? []) {
    if (!reply || typeof reply.text !== "string" || reply.text.trim().length === 0) continue;
    const actions = reply.type === "card" ? (reply.actions ?? []) : [];
    if (actions.length > 0 && actions.length <= WA_BUTTONS_MAX) {
      await sendOnboardingButtons(toPhone, reply.text, actions);
    } else if (actions.length > WA_BUTTONS_MAX) {
      await sendOnboardingText(toPhone, renderNumberedActionList(reply.text, actions));
    } else {
      await sendOnboardingText(toPhone, reply.text);
    }
  }
}

/** After a decision/message, surface the terminal-state follow-up if any. */
async function deliverTerminalFollowUp(toPhone: string, state: string | null | undefined): Promise<void> {
  const msg = terminalStateMessage(state);
  if (msg) await sendOnboardingText(toPhone, msg);
}

/** Start a fresh onboarding session and send the greeting. */
async function startFreshSession(toPhone: string, copilot: OnboardingCopilotApi): Promise<void> {
  const { greeting } = await copilot.startSession({ channel: "whatsapp", phone: toPhone });
  if (greeting?.trim()) await sendOnboardingText(toPhone, greeting);
}

async function processInbound(message: any, senderPhone: string): Promise<InboundOutcome> {
  const copilot = await loadCopilot();
  const phone = normalizeWaPhone(senderPhone ?? "");
  if (!phone) {
    console.warn("[waOnboarding] inbound message without a sender phone — ignored");
    return { handled: false, outcome: "error" };
  }

  // ── Interactive button/list replies (proposal decisions) ──────────────────
  if (message?.type === "interactive") {
    const reply = message.interactive?.button_reply ?? message.interactive?.list_reply ?? null;
    const parsed = parseOnboardingActionId(reply?.id ?? reply?.title);
    if (!parsed) {
      console.warn(`[waOnboarding] unrecognized interactive reply id: ${reply?.id ?? "(none)"}`);
      await sendOnboardingText(phone, MALFORMED_ACTION_MESSAGE);
      return { handled: true, outcome: "malformed_action" };
    }
    const session = await copilot.findActiveSessionByPhone(phone);
    if (!session) {
      // Stale button from an abandoned/expired session — begin fresh.
      await startFreshSession(phone, copilot);
      return { handled: true, outcome: "greeting" };
    }
    if (parsed.kind === "edit") {
      pendingEditProposals.set(phone, parsed.proposalId);
      await sendOnboardingText(phone, EDIT_PROMPT_MESSAGE);
      return { handled: true, outcome: "edit_prompt" };
    }
    const decision = await copilot.decideProposal({
      sessionId: session.id,
      proposalId: parsed.proposalId,
      approve: true,
    });
    await deliverCopilotReplies(phone, decision.replies);
    const after = await copilot.getSession(session.id).catch(() => null);
    await deliverTerminalFollowUp(phone, after?.state);
    return { handled: true, outcome: "approve" };
  }

  // ── Voice notes → transcription → same text pipeline ──────────────────────
  let text: string | null = null;
  if (message?.type === "text") {
    text = message.text?.body ?? "";
  } else if (message?.type === "audio" && message.audio?.id) {
    const transcript = await transcribeOnboardingVoiceNote(message.audio.id, message.audio?.mime_type);
    if (!transcript) {
      await sendOnboardingText(phone, VOICE_UNAVAILABLE_MESSAGE);
      return { handled: true, outcome: "voice_unavailable" };
    }
    text = transcript;
    // Fall through to the text pipeline with outcome recorded below.
    const outcome = await processText(phone, text, copilot);
    return { handled: outcome.handled, outcome: outcome.outcome === "message" ? "voice_note" : outcome.outcome };
  } else {
    await sendOnboardingText(phone, UNSUPPORTED_MESSAGE);
    return { handled: true, outcome: "unsupported" };
  }
  return processText(phone, text ?? "", copilot);
}

async function processText(
  phone: string,
  text: string,
  copilot: OnboardingCopilotApi,
): Promise<InboundOutcome> {
  // ── Restart intent — abandon the current session, begin fresh ────────────
  if (RESTART_PATTERN.test(text)) {
    // The C1 contract exposes no explicit abandon(); starting a fresh session
    // for the same phone supersedes (abandons) the prior active session.
    await startFreshSession(phone, copilot);
    pendingEditProposals.delete(phone);
    return { handled: true, outcome: "restart" };
  }

  const session = await copilot.findActiveSessionByPhone(phone);

  // ── Pending free-text edit: this message describes the desired changes ────
  // The real C1 decideProposal treats approve:false as REJECT and validates
  // editedPayload as a STRUCTURED payload (zod) — it does not reinterpret
  // free text. So the WhatsApp edit flow is: reject the stale proposal (C1's
  // own reject reply invites a re-draft), then feed the user's free-text
  // changes into postMessage so the agent drafts a revised proposal.
  const pendingProposal = pendingEditProposals.get(phone);
  if (pendingProposal && session) {
    pendingEditProposals.delete(phone);
    // Reject is best-effort: a stale/already-decided proposal must not eat
    // the user's message — postMessage below still runs either way.
    const reject = await copilot
      .decideProposal({ sessionId: session.id, proposalId: pendingProposal, approve: false })
      .catch((e: any) => {
        console.warn(`[waOnboarding] edit-reject of proposal ${pendingProposal} failed:`, e?.message);
        return null;
      });
    if (reject) await deliverCopilotReplies(phone, reject.replies);
    const { replies, state } = await copilot.postMessage({ sessionId: session.id, text });
    await deliverCopilotReplies(phone, replies);
    await deliverTerminalFollowUp(phone, state);
    return { handled: true, outcome: "edit_applied" };
  }
  // Stale pending edit with no live session — drop it and start over.
  if (pendingProposal) pendingEditProposals.delete(phone);

  // ── Unknown sender → new session + greeting ──────────────────────────────
  if (!session) {
    await startFreshSession(phone, copilot);
    return { handled: true, outcome: "greeting" };
  }

  // ── Resume mid-session ────────────────────────────────────────────────────
  const { replies, state } = await copilot.postMessage({ sessionId: session.id, text });
  await deliverCopilotReplies(phone, replies);
  await deliverTerminalFollowUp(phone, state);
  return { handled: true, outcome: "message" };
}

/**
 * Entry point for the Meta webhook branch. NEVER throws — the webhook ack
 * (200) has already been sent and must never be jeopardized.
 */
export async function handleInbound(message: any, senderPhone: string): Promise<InboundOutcome> {
  try {
    return await processInbound(message, senderPhone);
  } catch (e: any) {
    console.error("[waOnboarding] inbound processing failed:", e?.message ?? e);
    await sendOnboardingText(normalizeWaPhone(senderPhone ?? "") || senderPhone, FAILSAFE_MESSAGE).catch(
      () => undefined,
    );
    return { handled: true, outcome: "error" };
  }
}
