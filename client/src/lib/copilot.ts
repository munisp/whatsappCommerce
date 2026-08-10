/**
 * copilot.ts — typed access layer for the wave-9 `onboardingCopilot` tRPC
 * router (C1 backend, server/routers/onboardingCopilot.ts — real types in
 * AppRouter). Adapts backend shapes to the UI types in copilotLogic.ts:
 *
 *   startSession({ channel: "admin" })        → { sessionId, greeting }
 *   postMessage({ sessionId, text })          → { replies, state }
 *   approveProposal({ sessionId, proposalId, approve })   → { ok, replies }
 *   editProposal({ sessionId, proposalId, payload })      → { ok, replies }
 *   getSession({ sessionId })                 → OnboardingSession | null
 *   listSessions()                            → OnboardingSession[]
 *
 * Edit semantics (C1/C3 contract): edits are ONLY honored via editProposal
 * (approve:true implied, payload REPLACES the proposed one after zod
 * validation); approveProposal(approve:false) rejects and ignores payloads.
 *
 * Backend quirks normalized here:
 *  - TranscriptEntry uses `ts`; UI uses `at`.
 *  - Proposal cards arrive as agent transcript lines "summary\n\n{json}" —
 *    re-linked to their proposal and trimmed back to the summary line.
 *  - Card replies reference their proposal via action ids ("approve:<id>").
 */
import { trpc } from "@/lib/trpc";
import type { MutationOpts, MutationResult, QueryResult } from "@/lib/b2b";
import type {
  ChatMessage,
  CopilotProposal,
  CopilotReply,
  CopilotSessionDetail,
  CopilotSessionSummary,
  TranscriptMessage,
} from "@/lib/copilotLogic";

// ─── Backend shapes (superjson; Dates may arrive as Date or string) ─────────

interface BackendTranscriptEntry {
  role: "user" | "agent" | "system";
  text: string;
  ts?: string | Date;
}

interface BackendProposal {
  id: string;
  kind: string;
  summary: string;
  payload: unknown;
  status: string;
}

interface BackendSession {
  id: string;
  state: string;
  transcript?: BackendTranscriptEntry[];
  proposals?: BackendProposal[];
  createdAt?: string | Date;
  updatedAt?: string | Date;
}

interface BackendReply {
  type: "text" | "card";
  text: string;
  actions?: { id: string; label: string }[];
}

function iso(v: string | Date | null | undefined): string | null {
  if (!v) return null;
  return v instanceof Date ? v.toISOString() : v;
}

function normalizeProposals(raw: BackendProposal[] | undefined): CopilotProposal[] {
  return (raw ?? []).map((p, i) => ({
    id: p.id ?? `proposal-${i + 1}`,
    kind: p.kind ?? "waMenu",
    summary: p.summary ?? "",
    payload: p.payload,
    status: p.status ?? "pending",
    createdAt: null,
  }));
}

/**
 * The agent appends proposal cards to the transcript as
 * "summary\n\n<pretty JSON payload>". Re-link those lines to their proposal
 * (so the card renders in-thread) and trim the duplicated JSON body.
 */
function normalizeTranscript(
  raw: BackendTranscriptEntry[] | undefined,
  proposals: CopilotProposal[],
): TranscriptMessage[] {
  return (raw ?? []).map((m, i) => {
    const role = m.role === "user" || m.role === "system" ? m.role : "agent";
    let text = String(m.text ?? "");
    let proposalId: string | null = null;
    if (role === "agent") {
      const card = proposals.find((p) => p.summary && text.startsWith(`${p.summary}\n`));
      if (card) {
        proposalId = card.id;
        text = card.summary;
      }
    }
    return { id: `srv-${i}`, role, text, at: iso(m.ts), proposalId };
  });
}

function normalizeSession(raw: BackendSession | null): CopilotSessionDetail | null {
  if (!raw) return null;
  const proposals = normalizeProposals(raw.proposals);
  return {
    id: raw.id ?? "",
    state: raw.state ?? "intake",
    transcript: normalizeTranscript(raw.transcript, proposals),
    proposals,
    checks: undefined,
  };
}

function normalizeSummaries(raw: BackendSession[] | undefined): CopilotSessionSummary[] {
  return (raw ?? [])
    .map((s) => ({
      id: String(s.id ?? ""),
      state: String(s.state ?? "intake"),
      title: null,
      createdAt: iso(s.createdAt),
      updatedAt: iso(s.updatedAt),
    }))
    .filter((s) => s.id);
}

/** Card replies carry their proposal via action ids ("approve:<proposalId>"). */
function proposalIdFromActions(actions: { id: string }[] | undefined): string | null {
  const actionId = actions?.[0]?.id ?? "";
  const [, proposalId] = actionId.split(":");
  return proposalId || null;
}

function normalizeReplies(raw: BackendReply[] | undefined): CopilotReply[] {
  return (raw ?? []).map((r) => ({
    type: r.type === "card" ? "card" : "text",
    text: String(r.text ?? ""),
    actions: (r.actions ?? []).map((a) => ({ id: a.id, label: a.label })),
    proposalId: proposalIdFromActions(r.actions),
  }));
}

export interface StartSessionOutcome {
  sessionId: string;
  greeting: string;
}

export interface PostMessageOutcome {
  replies: CopilotReply[];
  state: string;
}

export interface DecideOutcome {
  ok: boolean;
  replies: CopilotReply[];
}

type QData<T> = QueryResult<T>;

// ─── Hooks ───────────────────────────────────────────────────────────────────

/** All copilot sessions (platform admin sees all; tenant admins their own). */
export function useCopilotSessions(opts?: { enabled?: boolean }): QData<CopilotSessionSummary[]> {
  return trpc.onboardingCopilot.listSessions.useQuery(undefined, {
    enabled: opts?.enabled !== false,
    select: (rows) => normalizeSummaries(rows as BackendSession[]),
  }) as QData<CopilotSessionSummary[]>;
}

/** Session detail (transcript + proposals). Polls while `poll` is true. */
export function useCopilotSession(
  sessionId: string | null,
  opts?: { poll?: boolean },
): QueryResult<CopilotSessionDetail | null> {
  return trpc.onboardingCopilot.getSession.useQuery(
    { sessionId: sessionId ?? "" },
    {
      enabled: !!sessionId,
      select: (raw) => normalizeSession(raw as BackendSession | null),
      refetchInterval: opts?.poll ? 3000 : false,
    },
  ) as QueryResult<CopilotSessionDetail | null>;
}

export function useStartCopilotSession(
  opts?: MutationOpts<StartSessionOutcome>,
): MutationResult<{ channel: "admin" }, StartSessionOutcome> {
  return trpc.onboardingCopilot.startSession.useMutation(opts) as MutationResult<
    { channel: "admin" },
    StartSessionOutcome
  >;
}

export function usePostCopilotMessage(
  opts?: MutationOpts<PostMessageOutcome>,
): MutationResult<{ sessionId: string; text: string }, PostMessageOutcome> {
  const m = trpc.onboardingCopilot.postMessage.useMutation({
    onSuccess: (r) =>
      opts?.onSuccess?.({
        replies: normalizeReplies(r.replies as BackendReply[]),
        state: String(r.state ?? ""),
      }),
    onError: opts?.onError,
  });
  return {
    ...m,
    mutateAsync: (v) =>
      m.mutateAsync(v).then((r) => ({
        replies: normalizeReplies(r.replies as BackendReply[]),
        state: String(r.state ?? ""),
      })),
  } as MutationResult<{ sessionId: string; text: string }, PostMessageOutcome>;
}

export interface ApproveProposalInput {
  sessionId: string;
  proposalId: string;
  approve: boolean;
}

export interface EditProposalInput {
  sessionId: string;
  proposalId: string;
  payload: Record<string, unknown>;
}

/** Approve or reject (no payload — reject means re-draft in chat). */
export function useApproveProposal(
  opts?: MutationOpts<DecideOutcome>,
): MutationResult<ApproveProposalInput, DecideOutcome> {
  const m = trpc.onboardingCopilot.approveProposal.useMutation({
    onSuccess: (r) =>
      opts?.onSuccess?.({ ok: r.ok, replies: normalizeReplies(r.replies as BackendReply[]) }),
    onError: opts?.onError,
  });
  return {
    ...m,
    mutateAsync: (v) =>
      m.mutateAsync(v).then((r) => ({ ok: r.ok, replies: normalizeReplies(r.replies as BackendReply[]) })),
  } as MutationResult<ApproveProposalInput, DecideOutcome>;
}

/** Approve with edits — the payload REPLACES the proposed one (zod-validated). */
export function useEditProposal(
  opts?: MutationOpts<DecideOutcome>,
): MutationResult<EditProposalInput, DecideOutcome> {
  const m = trpc.onboardingCopilot.editProposal.useMutation({
    onSuccess: (r) =>
      opts?.onSuccess?.({ ok: r.ok, replies: normalizeReplies(r.replies as BackendReply[]) }),
    onError: opts?.onError,
  });
  return {
    ...m,
    mutateAsync: (v) =>
      m.mutateAsync(v).then((r) => ({ ok: r.ok, replies: normalizeReplies(r.replies as BackendReply[]) })),
  } as MutationResult<EditProposalInput, DecideOutcome>;
}

/** Convert normalized replies into optimistic chat messages. */
export function repliesToChatMessages(replies: CopilotReply[], keyPrefix: string): ChatMessage[] {
  return replies.map((reply, i) => ({
    key: `${keyPrefix}-${Date.now()}-${i}`,
    role: "agent" as const,
    // Card text duplicates the payload JSON; the card itself renders below.
    text: reply.type === "card" ? (reply.text.split("\n")[0] ?? reply.text) : reply.text,
    proposalId: reply.proposalId ?? null,
  }));
}

/** Invalidate cached copilot queries (after mutations). */
export function useInvalidateCopilot(): (sessionId?: string) => void {
  const utils = trpc.useUtils();
  return (sessionId?: string) => {
    if (sessionId) void utils.onboardingCopilot.getSession.invalidate({ sessionId });
    void utils.onboardingCopilot.listSessions.invalidate();
  };
}
