// === W65 conversational ===
/**
 * OnboardingChatPanel — R2 chat-first web onboarding, embedded in both the
 * admin TenantOnboardingWizard and the tenant-portal OnboardingWizard as the
 * "Chat" mode (the classic form stays as the "Review & edit" mode).
 *
 * Talks to the onboardingChat tRPC facade, which runs the SAME copilot
 * agent/tools as WhatsApp onboarding (server/services/onboardingCopilot) —
 * no duplicated business logic; the DB-backed onboarding_sessions row is the
 * session store. Answers render as confirmable proposal cards; the copilot's
 * goLive checkpoint submits through the EXISTING tenant creation path.
 */
import { useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Loader2, RotateCcw, Send, CheckCircle2, XCircle } from "lucide-react";
import { toast } from "sonner";
import { ChatThread } from "@/components/copilot/ChatThread";
import type { ChatMessage } from "@/lib/copilotLogic";

interface Proposal {
  id: string;
  kind: string;
  summary: string;
  payload: unknown;
  status: "pending" | "approved" | "edited" | "rejected";
}

interface Snapshot {
  sessionId: string;
  state: string;
  tenantId: string | null;
  transcript: { role: "user" | "agent" | "system"; text: string; ts: string }[];
  proposals: Proposal[];
  terminal: boolean;
  greeting?: string | null;
}

export function OnboardingChatPanel({ onSwitchToForm }: { onSwitchToForm?: () => void }) {
  const [session, setSession] = useState<Snapshot | null>(null);
  const [text, setText] = useState("");
  const utils = trpc.useUtils();

  const start = trpc.onboardingChat.start.useMutation({
    onSuccess: (s) => setSession(s as Snapshot),
    onError: (e) => toast.error(e.message),
  });
  const step = trpc.onboardingChat.step.useMutation({
    onSuccess: (s) => { setSession(s as Snapshot); setText(""); },
    onError: (e) => toast.error(e.message),
  });
  const decide = trpc.onboardingChat.decide.useMutation({
    onSuccess: (s) => { setSession(s as Snapshot); toast.success("Decision recorded"); },
    onError: (e) => toast.error(e.message),
  });
  const reset = trpc.onboardingChat.reset.useMutation({
    onSuccess: (s) => setSession(s as unknown as Snapshot),
    onError: (e) => toast.error(e.message),
  });

  const messages: ChatMessage[] = useMemo(() => {
    if (!session) return [];
    const msgs = session.transcript.map((t, i) => ({
      key: `${i}-${t.ts}`,
      role: t.role,
      text: t.text,
    }));
    if (session.greeting) msgs.push({ key: "greeting", role: "agent" as const, text: session.greeting });
    return msgs;
  }, [session]);

  const send = () => {
    if (!session || !text.trim() || step.isPending) return;
    step.mutate({ sessionId: session.sessionId, text: text.trim() });
  };

  if (!session) {
    return (
      <Card data-testid="onboarding-chat-start">
        <CardHeader>
          <CardTitle>Chat-first onboarding</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Answer a few questions in chat — the copilot drafts your menu, branding and
            integrations as confirmable cards, then you review &amp; go live through the
            standard tenant creation path.
          </p>
          <Button onClick={() => start.mutate({})} disabled={start.isPending}>
            {start.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Start chatting"}
          </Button>
        </CardContent>
      </Card>
    );
  }

  const pending = session.proposals.filter((p) => p.status === "pending");

  return (
    <div className="space-y-4" data-testid="onboarding-chat-panel">
      <div className="flex items-center justify-between">
        <Badge variant="secondary">state: {session.state}</Badge>
        <div className="flex gap-2">
          {onSwitchToForm && (
            <Button variant="outline" size="sm" onClick={onSwitchToForm}>
              Review &amp; edit (form)
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => reset.mutate({ sessionId: session.sessionId })}
            disabled={reset.isPending}
          >
            <RotateCcw className="mr-1 h-3 w-3" /> Start over
          </Button>
        </div>
      </div>

      <Card>
        <CardContent className="pt-4">
          <ChatThread messages={messages} typing={step.isPending} />
        </CardContent>
      </Card>

      {pending.length > 0 && (
        <div className="space-y-2" data-testid="onboarding-chat-proposals">
          {pending.map((p) => (
            <Card key={p.id}>
              <CardContent className="flex items-center justify-between gap-3 pt-4">
                <div>
                  <Badge className="mr-2">{p.kind}</Badge>
                  <span className="text-sm">{p.summary}</span>
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button
                    size="sm"
                    onClick={() => decide.mutate({ sessionId: session.sessionId, proposalId: p.id, approve: true })}
                    disabled={decide.isPending}
                  >
                    <CheckCircle2 className="mr-1 h-3 w-3" /> Confirm
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => decide.mutate({ sessionId: session.sessionId, proposalId: p.id, approve: false })}
                    disabled={decide.isPending}
                  >
                    <XCircle className="mr-1 h-3 w-3" /> Reject
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {session.terminal && session.state === "live" && (
        <Card className="border-green-500">
          <CardContent className="pt-4 text-sm">
            🎉 Tenant is live{session.tenantId ? ` (${session.tenantId})` : ""} — created through the standard path.
          </CardContent>
        </Card>
      )}

      {!session.terminal && (
        <div className="flex gap-2">
          <Input
            placeholder="Type your answer…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && send()}
          />
          <Button onClick={send} disabled={step.isPending || !text.trim()}>
            {step.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </Button>
        </div>
      )}
    </div>
  );
}

export default OnboardingChatPanel;
