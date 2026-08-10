/**
 * OnboardingCopilot — wave-9 chat-based onboarding experience in the admin
 * portal (route /onboarding-copilot). Talks to the C1 tRPC router
 * `onboardingCopilot.*` through the loose bridge in client/src/lib/copilot.ts.
 *
 * Layout: chat thread (left) with in-thread proposal cards; a proposals
 * rail, validation checklist and go-live / success panel (right). A resume
 * banner appears when listSessions returns a non-terminal session. Edit UX
 * for proposals: JSON editor with natural-language fallback (see
 * assembleEditedPayload in copilotLogic.ts).
 */
import { useEffect, useMemo, useState } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import {
  ArrowRight, Bot, CheckCircle2, History, Loader2, MessageSquarePlus, Rocket, Send,
} from "lucide-react";
import { ChatThread } from "@/components/copilot/ChatThread";
import { ProposalCard } from "@/components/copilot/ProposalCard";
import { StateBadge } from "@/components/copilot/StateBadge";
import { ValidationChecklist } from "@/components/copilot/ValidationChecklist";
import {
  useCopilotSession,
  useCopilotSessions,
  useDecideProposal,
  useInvalidateCopilot,
  usePostCopilotMessage,
  useStartCopilotSession,
  type DecideProposalInput,
} from "@/lib/copilot";
import {
  canGoLive,
  copilotStateMeta,
  extractValidationChecks,
  findResumableSession,
  liveNextSteps,
  mergeTranscript,
  repairGuidance,
  sortProposalsPendingFirst,
  type ChatMessage,
} from "@/lib/copilotLogic";

const VALIDATION_STATES = new Set(["validating", "live", "failed"]);

export default function OnboardingCopilot() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [optimistic, setOptimistic] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const invalidate = useInvalidateCopilot();

  const sessions = useCopilotSessions();
  const resumable = useMemo(
    () => (sessionId ? null : findResumableSession(sessions.data ?? [])),
    [sessions.data, sessionId],
  );

  // Poll while the session is in a non-terminal state (default true until the
  // first fetch tells us otherwise).
  const [polling, setPolling] = useState(true);
  const session = useCopilotSession(sessionId, { poll: polling });
  useEffect(() => {
    if (!sessionId) return;
    const state = session.data?.state;
    setPolling(state ? copilotStateMeta(state).active : true);
  }, [sessionId, session.data?.state]);

  const detail = session.data;
  const state = detail?.state ?? "intake";

  const checks = useMemo(() => extractValidationChecks(detail), [detail]);
  const guidance = useMemo(() => repairGuidance(detail?.transcript ?? []), [detail]);
  const proposals = useMemo(() => sortProposalsPendingFirst(detail?.proposals ?? []), [detail]);
  const proposalById = useMemo(() => new Map(proposals.map((p) => [p.id, p])), [proposals]);
  const referencedIds = useMemo(
    () =>
      new Set(
        [...(detail?.transcript ?? []), ...optimistic]
          .map((m) => m.proposalId)
          .filter((id): id is string => !!id),
      ),
    [detail, optimistic],
  );
  const railProposals = proposals.filter((p) => !referencedIds.has(p.id));
  const messages = useMemo(
    () => mergeTranscript(detail?.transcript ?? [], optimistic),
    [detail, optimistic],
  );

  const start = useStartCopilotSession({
    onSuccess: (r) => {
      if (!r.sessionId) {
        toast.error("Copilot did not return a session id");
        return;
      }
      setSessionId(r.sessionId);
      setOptimistic(r.greeting ? [{ key: "greeting", role: "agent", text: r.greeting }] : []);
      invalidate();
    },
    onError: (e) => toast.error(`Could not start session: ${e.message}`),
  });

  const post = usePostCopilotMessage({
    onSuccess: (r) => {
      setOptimistic((prev) => [
        ...prev,
        ...r.replies.map((reply, i) => ({
          key: `reply-${Date.now()}-${i}`,
          role: "agent" as const,
          text: reply.text,
          proposalId: reply.proposalId ?? null,
        })),
      ]);
      if (sessionId) invalidate(sessionId);
    },
    onError: (e) => toast.error(`Message failed: ${e.message}`),
  });

  const decide = useDecideProposal({
    onSuccess: () => {
      toast.success("Decision recorded");
      if (sessionId) invalidate(sessionId);
    },
    onError: (e) => toast.error(`Decision failed: ${e.message}`),
  });

  const send = () => {
    const text = draft.trim();
    if (!text || !sessionId || post.isPending) return;
    setOptimistic((prev) => [...prev, { key: `user-${Date.now()}`, role: "user", text }]);
    setDraft("");
    post.mutate({ sessionId, text });
  };

  const onDecide = (input: Omit<DecideProposalInput, "sessionId">) => {
    if (!sessionId) return;
    decide.mutate({ sessionId, ...input });
  };

  /**
   * Go-live: C1 models the final step as the last pending proposal (approve
   * it). If none is pending we fall back to an explicit "go live" chat
   * command — adapt to a dedicated API on the backend rebase if one lands.
   */
  const goLive = () => {
    if (!sessionId) return;
    const finalPending = proposals.find((p) => p.status === "pending");
    if (finalPending) {
      decide.mutate({ sessionId, proposalId: finalPending.id, approve: true });
    } else {
      setOptimistic((prev) => [...prev, { key: `user-${Date.now()}`, role: "user", text: "go live" }]);
      post.mutate({ sessionId, text: "go live" });
    }
  };

  const resetToLauncher = () => {
    setSessionId(null);
    setOptimistic([]);
    setDraft("");
    invalidate();
  };

  return (
    <DashboardLayout>
      <div className="container mx-auto max-w-6xl space-y-4 p-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <Bot className="h-6 w-6 text-muted-foreground" />
              Onboarding Copilot
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Chat-driven setup: the copilot interviews you, proposes a WhatsApp menu, brand kit,
              use cases and integrations, then validates and takes the store live.
            </p>
          </div>
          {detail && <StateBadge state={state} />}
        </div>

        {/* Resume banner */}
        {resumable && (
          <Card className="border-amber-500/30">
            <CardContent className="flex items-center justify-between gap-3 p-4">
              <div className="flex items-center gap-2 text-sm">
                <History className="h-4 w-4 text-amber-400" />
                <span>
                  An onboarding session is in progress
                  {resumable.title ? ` — ${resumable.title}` : ""} (
                  {copilotStateMeta(String(resumable.state)).label.toLowerCase()}).
                </span>
              </div>
              <Button size="sm" variant="outline" onClick={() => { setOptimistic([]); setSessionId(resumable.id); }}>
                Resume onboarding
                <ArrowRight className="ml-1 h-3.5 w-3.5" />
              </Button>
            </CardContent>
          </Card>
        )}

        {/* Launcher */}
        {!sessionId && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Start a new onboarding</CardTitle>
              <CardDescription>
                The copilot will ask a few questions about the business, then draft everything for
                your approval before touching live configuration.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {sessions.isLoading ? (
                <Skeleton className="h-9 w-44" />
              ) : (
                <Button onClick={() => start.mutate({ channel: "admin" })} disabled={start.isPending}>
                  {start.isPending ? (
                    <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                  ) : (
                    <MessageSquarePlus className="mr-1.5 h-4 w-4" />
                  )}
                  Start onboarding session
                </Button>
              )}
            </CardContent>
          </Card>
        )}

        {/* Session workspace */}
        {sessionId && (
          <div className="grid gap-4 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardContent className="p-4">
                {session.isLoading && !detail ? (
                  <div className="space-y-3">
                    <Skeleton className="h-10 w-2/3" />
                    <Skeleton className="h-10 w-1/2 ml-auto" />
                    <Skeleton className="h-10 w-2/3" />
                  </div>
                ) : session.error ? (
                  <div className="flex h-64 flex-col items-center justify-center gap-2 text-sm">
                    <p className="text-muted-foreground">Could not load the session: {session.error.message}</p>
                    <Button size="sm" variant="outline" onClick={resetToLauncher}>Back to start</Button>
                  </div>
                ) : (
                  <ChatThread
                    messages={messages}
                    typing={post.isPending}
                    renderProposal={(proposalId) => {
                      const p = proposalById.get(proposalId);
                      return p ? (
                        <ProposalCard proposal={p} pending={decide.isPending} onDecide={onDecide} />
                      ) : null;
                    }}
                  />
                )}
              </CardContent>
              {state !== "live" && state !== "abandoned" && (
                <div className="border-t p-3 flex gap-2">
                  <Input
                    value={draft}
                    placeholder={state === "failed" ? "Reply to the repair guidance…" : "Message the copilot…"}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        send();
                      }
                    }}
                    disabled={post.isPending}
                  />
                  <Button onClick={send} disabled={post.isPending || !draft.trim()} size="icon" aria-label="Send">
                    {post.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                  </Button>
                </div>
              )}
            </Card>

            <div className="space-y-4">
              {state === "live" ? (
                <Card className="border-emerald-500/30">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base flex items-center gap-2">
                      <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                      Store is live
                    </CardTitle>
                    <CardDescription>Onboarding completed. Recommended next steps:</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <ul className="space-y-1.5 text-sm">
                      {liveNextSteps().map((s) => (
                        <li key={s} className="flex items-start gap-2">
                          <ArrowRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                          <span>{s}</span>
                        </li>
                      ))}
                    </ul>
                    <Button className="mt-3" size="sm" variant="outline" onClick={resetToLauncher}>
                      Start another onboarding
                    </Button>
                  </CardContent>
                </Card>
              ) : (
                <>
                  {VALIDATION_STATES.has(state) && (
                    <ValidationChecklist checks={checks} guidance={guidance} />
                  )}
                  {canGoLive(state, checks) && (
                    <Button className="w-full" onClick={goLive} disabled={decide.isPending || post.isPending}>
                      {decide.isPending ? (
                        <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                      ) : (
                        <Rocket className="mr-1.5 h-4 w-4" />
                      )}
                      Go live
                    </Button>
                  )}
                </>
              )}

              {railProposals.length > 0 && state !== "live" && (
                <div className="space-y-3">
                  <p className="text-xs font-medium text-muted-foreground">
                    Proposals ({railProposals.filter((p) => p.status === "pending").length} awaiting decision)
                  </p>
                  {railProposals.map((p) => (
                    <ProposalCard key={p.id} proposal={p} pending={decide.isPending} onDecide={onDecide} />
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
