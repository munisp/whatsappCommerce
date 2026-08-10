/**
 * copilot.ts — access layer for the wave-9 `onboardingCopilot` tRPC router
 * (C1 backend). The router is NOT yet part of AppRouter in this branch, so
 * every call goes through a deliberately loose `(trpc as any)` bridge — the
 * same pattern wave-8 used in b2b.ts before its routers landed. At runtime
 * the tRPC proxy builds the path "onboardingCopilot.<proc>" dynamically, so
 * this compiles today and works unchanged once the backend merges; the final
 * rebase onto main can swap these to fully-typed calls.
 *
 * Contract (C1):
 *   startSession({ channel: "admin" })            → { sessionId, greeting }
 *   postMessage({ sessionId, text })              → { replies: CopilotReply[], state }
 *   decideProposal({ sessionId, proposalId, approve, editedPayload? })
 *   getSession({ sessionId })                     → CopilotSessionDetail
 *   listSessions({ channel? })                    → CopilotSessionSummary[]
 */
import { trpc } from "@/lib/trpc";
import type { MutationOpts, MutationResult, QueryResult } from "@/lib/b2b";
import type {
  CopilotProposal,
  CopilotReply,
  CopilotSessionDetail,
  CopilotSessionSummary,
  TranscriptMessage,
  ValidationCheck,
} from "@/lib/copilotLogic";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const router = () => (trpc as any).onboardingCopilot;

// ─── Raw backend shapes (superjson; Dates may arrive as strings) ────────────

interface RawSessionDetail {
  id: string;
  sessionId?: string;
  state: string;
  transcript?: unknown;
  proposals?: unknown;
  checks?: unknown;
}

function iso(v: unknown): string | null {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString();
  return typeof v === "string" ? v : null;
}

function normalizeTranscript(raw: unknown): TranscriptMessage[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((m) => m && typeof m === "object")
    .map((m) => {
      const r = m as Record<string, unknown>;
      const role = r.role === "user" || r.role === "system" ? r.role : "agent";
      return {
        id: typeof r.id === "string" ? r.id : undefined,
        role,
        text: typeof r.text === "string" ? r.text : String(r.text ?? ""),
        at: iso(r.at ?? r.createdAt),
        proposalId: typeof r.proposalId === "string" ? r.proposalId : null,
      };
    });
}

function normalizeProposals(raw: unknown): CopilotProposal[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((p) => p && typeof p === "object")
    .map((p, i) => {
      const r = p as Record<string, unknown>;
      return {
        id: typeof r.id === "string" ? r.id : `proposal-${i + 1}`,
        kind: typeof r.kind === "string" ? r.kind : "waMenu",
        summary: typeof r.summary === "string" ? r.summary : "",
        payload: r.payload,
        status: typeof r.status === "string" ? r.status : "pending",
        createdAt: iso(r.createdAt),
      };
    });
}

function normalizeChecks(raw: unknown): ValidationCheck[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw
    .filter((c) => c && typeof c === "object")
    .map((c) => {
      const r = c as Record<string, unknown>;
      return {
        name: String(r.name ?? "Check"),
        ok: Boolean(r.ok),
        detail: r.detail != null ? String(r.detail) : null,
      };
    });
}

function normalizeSession(raw: RawSessionDetail): CopilotSessionDetail {
  return {
    id: raw.id ?? raw.sessionId ?? "",
    state: raw.state ?? "intake",
    transcript: normalizeTranscript(raw.transcript),
    proposals: normalizeProposals(raw.proposals),
    checks: normalizeChecks(raw.checks),
  };
}

function normalizeSessionSummary(raw: unknown): CopilotSessionSummary[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((s) => s && typeof s === "object")
    .map((s) => {
      const r = s as Record<string, unknown>;
      return {
        id: String(r.id ?? r.sessionId ?? ""),
        state: String(r.state ?? "intake"),
        title: typeof r.title === "string" ? r.title : null,
        createdAt: iso(r.createdAt),
        updatedAt: iso(r.updatedAt),
      };
    })
    .filter((s) => s.id);
}

export interface StartSessionOutcome {
  sessionId: string;
  greeting: string;
}

export interface PostMessageOutcome {
  replies: CopilotReply[];
  state: string;
}

function normalizeReplies(raw: unknown): CopilotReply[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((r) => r && typeof r === "object")
    .map((r) => {
      const x = r as Record<string, unknown>;
      const actions = Array.isArray(x.actions)
        ? x.actions
            .filter((a) => a && typeof a === "object")
            .map((a) => {
              const y = a as Record<string, unknown>;
              return { id: String(y.id ?? ""), label: String(y.label ?? y.id ?? "") };
            })
            .filter((a) => a.id)
        : undefined;
      return {
        type: x.type === "card" ? ("card" as const) : ("text" as const),
        text: typeof x.text === "string" ? x.text : String(x.text ?? ""),
        actions,
        proposalId: typeof x.proposalId === "string" ? x.proposalId : null,
      };
    });
}

// ─── Hooks ───────────────────────────────────────────────────────────────────

/** All copilot sessions for the resume banner (channel=admin). */
export function useCopilotSessions(opts?: { enabled?: boolean }): QueryResult<CopilotSessionSummary[]> {
  return router().listSessions.useQuery(
    { channel: "admin" },
    { enabled: opts?.enabled !== false, select: (rows: unknown) => normalizeSessionSummary(rows) },
  ) as QueryResult<CopilotSessionSummary[]>;
}

/** Session detail (transcript + proposals + checks). Polls while `poll` is true. */
export function useCopilotSession(
  sessionId: string | null,
  opts?: { poll?: boolean },
): QueryResult<CopilotSessionDetail> {
  return router().getSession.useQuery(
    { sessionId: sessionId ?? "" },
    {
      enabled: !!sessionId,
      select: (raw: RawSessionDetail) => normalizeSession(raw),
      refetchInterval: opts?.poll ? 3000 : false,
    },
  ) as QueryResult<CopilotSessionDetail>;
}

export function useStartCopilotSession(
  opts?: MutationOpts<StartSessionOutcome>,
): MutationResult<{ channel: "admin" }, StartSessionOutcome> {
  const m = router().startSession.useMutation({
    onSuccess: (r: { sessionId?: string; id?: string; greeting?: string }) =>
      opts?.onSuccess?.({
        sessionId: String(r.sessionId ?? r.id ?? ""),
        greeting: typeof r.greeting === "string" ? r.greeting : "",
      }),
    onError: opts?.onError,
  });
  return m as MutationResult<{ channel: "admin" }, StartSessionOutcome>;
}

export function usePostCopilotMessage(
  opts?: MutationOpts<PostMessageOutcome>,
): MutationResult<{ sessionId: string; text: string }, PostMessageOutcome> {
  const m = router().postMessage.useMutation({
    onSuccess: (r: { replies?: unknown; state?: string }) =>
      opts?.onSuccess?.({
        replies: normalizeReplies(r.replies),
        state: String(r.state ?? ""),
      }),
    onError: opts?.onError,
  });
  return m as MutationResult<{ sessionId: string; text: string }, PostMessageOutcome>;
}

export interface DecideProposalInput {
  sessionId: string;
  proposalId: string;
  approve: boolean;
  editedPayload?: Record<string, unknown>;
}

export function useDecideProposal(
  opts?: MutationOpts<unknown>,
): MutationResult<DecideProposalInput, unknown> {
  return router().decideProposal.useMutation(opts) as MutationResult<DecideProposalInput, unknown>;
}

/** Invalidate cached copilot queries (after mutations). */
export function useInvalidateCopilot(): (sessionId?: string) => void {
  const utils = trpc.useUtils();
  return (sessionId?: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const c = (utils as any).onboardingCopilot;
    if (!c) return;
    if (sessionId) c.getSession.invalidate({ sessionId });
    c.listSessions.invalidate();
  };
}
