/**
 * onboardingCopilot/session.ts — session persistence + shared types for the
 * agentic onboarding copilot.
 *
 * State machine (onboarding_sessions.state):
 *   intake → proposing → approving → configuring → validating → live
 *                                                 ↘ failed / abandoned
 *
 * - intake:      collecting structured business facts from free text
 * - proposing:   copilot is generating proposal cards (waMenu/branding/…)
 * - approving:   waiting on a HUMAN decision per proposal (checkpoint)
 * - configuring: approved proposals are being applied / fixes after repair
 * - validating:  live validation checks are running
 * - live:        tenant is live
 * - failed:      validation failed after MAX_REPAIR_ROUNDS repair rounds
 * - abandoned:   explicitly abandoned by the operator
 */
import { randomUUID } from "crypto";
import { and, eq } from "drizzle-orm";
import { getDb } from "../../db";
import { onboardingSessions } from "../../../drizzle/schema";

export const COPILOT_STATES = [
  "intake",
  "proposing",
  "approving",
  "configuring",
  "validating",
  "live",
  "failed",
  "abandoned",
] as const;
export type CopilotState = (typeof COPILOT_STATES)[number];

export const COPILOT_CHANNELS = ["admin", "whatsapp"] as const;
export type CopilotChannel = (typeof COPILOT_CHANNELS)[number];

/** Terminal states — an "active" session is any non-terminal one. */
export const TERMINAL_STATES: readonly CopilotState[] = ["live", "failed", "abandoned"];

/** Repair loop cap: after this many failed validation rounds → 'failed'. */
export const MAX_REPAIR_ROUNDS = 3;

export interface TranscriptEntry {
  role: "user" | "agent" | "system";
  text: string;
  ts: string;
}

// 'goLive' is the terminal checkpoint proposal: emitted when validation passes;
// approving it (or the literal "go live" command) advances validating → live.
export const PROPOSAL_KINDS = ["waMenu", "branding", "useCases", "integrations", "goLive"] as const;
export type ProposalKind = (typeof PROPOSAL_KINDS)[number];

export type ProposalStatus = "pending" | "approved" | "edited" | "rejected";

export interface Proposal {
  id: string;
  kind: ProposalKind;
  summary: string;
  payload: unknown;
  status: ProposalStatus;
}

/** Structured business facts extracted during intake. */
export interface IntakeFacts {
  businessName?: string;
  industry?: string;
  city?: string;
  delivery?: string;
  paymentPrefs?: string[];
  useCaseHints?: string[];
  [k: string]: unknown;
}

export interface SessionIntake {
  facts: IntakeFacts;
  /** Repair-loop bookkeeping (kept inside intake jsonb — schema-stable). */
  repairRounds?: number;
  lastFailureReasons?: string[];
  [k: string]: unknown;
}

export interface OnboardingSession {
  id: string;
  tenantId: string | null;
  channel: CopilotChannel;
  phone: string | null;
  state: CopilotState;
  transcript: TranscriptEntry[];
  proposals: Proposal[];
  intake: SessionIntake;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CopilotAction {
  id: string;
  label: string;
}

export interface CopilotReply {
  type: "text" | "card";
  text: string;
  actions?: CopilotAction[];
}

// ─── Row mapping ─────────────────────────────────────────────────────────────

type Row = typeof onboardingSessions.$inferSelect;

export function rowToSession(row: Row): OnboardingSession {
  const rawIntake = (row.intake ?? {}) as Record<string, unknown>;
  const { facts, ...rest } = rawIntake as { facts?: IntakeFacts } & Record<string, unknown>;
  return {
    id: row.id,
    tenantId: row.tenantId ?? null,
    channel: (COPILOT_CHANNELS as readonly string[]).includes(row.channel)
      ? (row.channel as CopilotChannel)
      : "admin",
    phone: row.phone ?? null,
    state: (COPILOT_STATES as readonly string[]).includes(row.state)
      ? (row.state as CopilotState)
      : "intake",
    transcript: Array.isArray(row.transcript) ? (row.transcript as TranscriptEntry[]) : [],
    proposals: Array.isArray(row.proposals) ? (row.proposals as Proposal[]) : [],
    intake: { ...rest, facts: facts ?? {} },
    error: row.error ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ─── Persistence ─────────────────────────────────────────────────────────────

export async function createSessionRow(args: {
  channel: CopilotChannel;
  tenantId?: string | null;
  phone?: string | null;
}): Promise<OnboardingSession> {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const [row] = await db
    .insert(onboardingSessions)
    .values({
      id: randomUUID(),
      channel: args.channel,
      tenantId: args.tenantId ?? null,
      phone: args.phone ?? null,
      state: "intake",
      transcript: [],
      proposals: [],
      intake: { facts: {} },
    })
    .returning();
  return rowToSession(row);
}

export async function loadSession(sessionId: string): Promise<OnboardingSession | null> {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const [row] = await db
    .select()
    .from(onboardingSessions)
    .where(eq(onboardingSessions.id, sessionId))
    .limit(1);
  return row ? rowToSession(row) : null;
}

/** Persist the mutable fields of a session back to its row. */
export async function saveSession(session: OnboardingSession): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  await db
    .update(onboardingSessions)
    .set({
      tenantId: session.tenantId,
      state: session.state,
      transcript: session.transcript,
      proposals: session.proposals,
      intake: session.intake,
      error: session.error,
      updatedAt: new Date(),
    })
    .where(eq(onboardingSessions.id, session.id));
}

/**
 * Resume lookup for the WhatsApp channel: latest non-terminal session for a
 * phone, or null. (State filtering is done in JS so it works everywhere.)
 */
export async function findActiveSessionRowByPhone(phone: string): Promise<OnboardingSession | null> {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const rows = await db
    .select()
    .from(onboardingSessions)
    .where(and(eq(onboardingSessions.channel, "whatsapp"), eq(onboardingSessions.phone, phone)));
  const active = rows
    .map(rowToSession)
    .filter((s) => !TERMINAL_STATES.includes(s.state))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  return active[0] ?? null;
}

/**
 * Supersede every non-terminal whatsapp session for a phone (C3 "restart" =
 * startSession again for the same phone). Returns the abandoned session ids.
 */
export async function supersedeActiveSessionsForPhone(phone: string): Promise<string[]> {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const rows = await db
    .select()
    .from(onboardingSessions)
    .where(and(eq(onboardingSessions.channel, "whatsapp"), eq(onboardingSessions.phone, phone)));
  const doomed = rows.filter((r) => !TERMINAL_STATES.includes(r.state as CopilotState));
  for (const r of doomed) {
    await db
      .update(onboardingSessions)
      .set({ state: "abandoned", updatedAt: new Date() })
      .where(eq(onboardingSessions.id, r.id));
  }
  return doomed.map((r) => r.id);
}

export async function listSessionRows(filter?: {
  tenantId?: string;
}): Promise<OnboardingSession[]> {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const rows = filter?.tenantId
    ? await db.select().from(onboardingSessions).where(eq(onboardingSessions.tenantId, filter.tenantId))
    : await db.select().from(onboardingSessions);
  return rows
    .map(rowToSession)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

// ─── Transcript / proposal helpers (pure) ────────────────────────────────────

export function appendTranscript(
  session: OnboardingSession,
  role: TranscriptEntry["role"],
  text: string,
): void {
  session.transcript.push({ role, text, ts: new Date().toISOString() });
}

export function addProposal(
  session: OnboardingSession,
  proposal: Omit<Proposal, "id" | "status"> & { id?: string },
): Proposal {
  const full: Proposal = {
    id: proposal.id ?? `p-${session.proposals.length + 1}-${Math.random().toString(36).slice(2, 8)}`,
    kind: proposal.kind,
    summary: proposal.summary,
    payload: proposal.payload,
    status: "pending",
  };
  session.proposals.push(full);
  return full;
}

export function findProposal(session: OnboardingSession, proposalId: string): Proposal | null {
  return session.proposals.find((p) => p.id === proposalId) ?? null;
}

// ─── Multilingual helper (wave 15) ───────────────────────────────────────────
// Localized copilot string for this session; English is byte-identical to the
// wave-9 strings. See language.ts.

export { t as copilotText, sessionLanguage } from "./language";

/**
 * CHECKPOINT INVARIANT — the single gate every mutating tool goes through.
 * A proposal may only be applied when a human has flipped it to 'approved',
 * or to 'edited' (which carries the caller-supplied payload already stored
 * on the row by decideProposal). Anything else throws.
 */
export function assertProposalApproved(proposal: Proposal | null, proposalId: string): Proposal {
  if (!proposal) {
    throw new Error(`Unknown proposal "${proposalId}"`);
  }
  if (proposal.status === "rejected") {
    throw new Error(`Proposal "${proposalId}" was rejected and cannot be applied`);
  }
  if (proposal.status !== "approved" && proposal.status !== "edited") {
    throw new Error(
      `Proposal "${proposalId}" has not been approved (status=${proposal.status}). ` +
        `A human must approve or edit it before it can be applied.`,
    );
  }
  return proposal;
}
