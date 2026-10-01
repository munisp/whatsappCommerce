// === W55 ui-c ===
// Human-handoff inbox for the W23/W45 escalation router (ORPHAN-BE-16):
// lists conversations flagged for a human (status human_active / pending /
// open via conversation.list), claim (escalate), reply in-thread through the
// tenant's channel credentials, release back to the bot, resolve.
import { useActiveTenant } from "@/contexts/TenantContext";
import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/lib/trpc";
import { formatDistanceToNow } from "date-fns";
import { Bot, CheckCircle2, HandMetal, MessageSquare, Send, UserCheck } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

const statusColors: Record<string, string> = {
  human_active: "bg-red-500/20 text-red-400 border-red-500/30",
  pending: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
  open: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  bot_active: "bg-purple-500/20 text-purple-400 border-purple-500/30",
  resolved: "bg-green-500/20 text-green-400 border-green-500/30",
};

export default function EscalationInbox() {
  const { activeTenantId: tenantId } = useActiveTenant();
  const [statusFilter, setStatusFilter] = useState<string>("human_active");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [replyBody, setReplyBody] = useState("");
  const utils = trpc.useUtils();

  const { data: convList, isLoading } = trpc.conversation.list.useQuery({
    tenantId,
    status: statusFilter === "all" ? undefined : statusFilter,
    limit: 100,
  });
  const { data: selected } = trpc.escalation.get.useQuery(
    { conversationId: selectedId ?? "" },
    { enabled: !!selectedId },
  );

  const invalidate = () => {
    utils.conversation.list.invalidate();
    if (selectedId) utils.escalation.get.invalidate({ conversationId: selectedId });
  };
  const opts = (label: string) => ({
    onSuccess: () => { toast.success(label); invalidate(); },
    onError: (e: any) => toast.error(e.message),
  });
  const claimMut = trpc.escalation.escalate.useMutation(opts("Conversation claimed — you are now the assigned agent"));
  const resolveMut = trpc.escalation.resolve.useMutation(opts("Conversation resolved"));
  const releaseMut = trpc.escalation.releaseToBot.useMutation(opts("Released back to the bot"));
  const replyMut = trpc.escalation.reply.useMutation({
    onSuccess: () => { toast.success("Reply sent"); setReplyBody(""); invalidate(); },
    onError: (e) => toast.error(e.message),
  });

  return (
    <DashboardLayout>
      <div className="p-6 space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Human Handoff Inbox</h1>
          <p className="text-muted-foreground mt-1">Conversations the bot handed to a human ("talk to an agent") — claim, reply, release or resolve</p>
        </div>

        <div className="flex items-center gap-3">
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-56 bg-card border-border">
              <SelectValue placeholder="Filter by status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="human_active">Awaiting human / with agent</SelectItem>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="open">Open (bot)</SelectItem>
              <SelectItem value="bot_active">Bot active</SelectItem>
              <SelectItem value="resolved">Resolved</SelectItem>
              <SelectItem value="all">All</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Card className="bg-card border-border">
            <CardHeader><CardTitle className="text-sm font-medium text-muted-foreground">Conversations</CardTitle></CardHeader>
            <CardContent className="p-0">
              {isLoading ? (
                <div className="text-center text-muted-foreground py-8">Loading...</div>
              ) : !convList?.length ? (
                <div className="text-center text-muted-foreground py-8 flex flex-col items-center gap-2">
                  <HandMetal className="w-8 h-8 opacity-40" />
                  No conversations in this state
                </div>
              ) : (
                <div className="divide-y divide-border">
                  {convList.map((c: any) => (
                    <button
                      key={c.id}
                      onClick={() => setSelectedId(c.id)}
                      className={`w-full text-left p-4 hover:bg-accent/30 transition-colors ${selectedId === c.id ? "bg-accent/40" : ""}`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium text-sm truncate">{c.customerName ?? c.customerPhone ?? c.id.slice(0, 8)}</span>
                        <Badge variant="outline" className={statusColors[c.status] ?? ""}>{String(c.status).replaceAll("_", " ")}</Badge>
                      </div>
                      <div className="text-xs text-muted-foreground mt-1 flex items-center gap-2">
                        <MessageSquare className="w-3 h-3" />
                        {c.messageCount ?? 0} messages · updated {formatDistanceToNow(new Date(c.updatedAt), { addSuffix: true })}
                        {c.escalatedAt && <span>· escalated {formatDistanceToNow(new Date(c.escalatedAt), { addSuffix: true })}</span>}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="bg-card border-border">
            <CardHeader><CardTitle className="text-sm font-medium text-muted-foreground">Agent console</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              {!selected ? (
                <p className="text-sm text-muted-foreground">Select a conversation to work on it.</p>
              ) : (
                <>
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="font-medium">{selected.channel === "telegram" ? "Telegram" : "WhatsApp"} conversation</p>
                      <p className="text-xs text-muted-foreground font-mono">{selected.id}</p>
                    </div>
                    <Badge variant="outline" className={statusColors[selected.status] ?? ""}>{selected.status.replaceAll("_", " ")}</Badge>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {selected.status !== "resolved" && selected.status !== "human_active" && (
                      <Button size="sm" className="gap-1" disabled={claimMut.isPending}
                        onClick={() => claimMut.mutate({ conversationId: selected.id })}>
                        <UserCheck className="w-3.5 h-3.5" /> Claim
                      </Button>
                    )}
                    {selected.status === "human_active" && (
                      <Button size="sm" variant="outline" className="gap-1" disabled={releaseMut.isPending}
                        onClick={() => releaseMut.mutate({ conversationId: selected.id })}>
                        <Bot className="w-3.5 h-3.5" /> Release to bot
                      </Button>
                    )}
                    {selected.status !== "resolved" && (
                      <Button size="sm" variant="outline" className="gap-1 text-green-400" disabled={resolveMut.isPending}
                        onClick={() => resolveMut.mutate({ conversationId: selected.id })}>
                        <CheckCircle2 className="w-3.5 h-3.5" /> Resolve
                      </Button>
                    )}
                  </div>
                  {selected.status !== "resolved" && (
                    <div className="space-y-2">
                      <Textarea
                        placeholder="Reply to the customer through the tenant channel..."
                        value={replyBody}
                        onChange={(e) => setReplyBody(e.target.value)}
                        maxLength={4096}
                        rows={4}
                      />
                      <Button size="sm" className="gap-1"
                        disabled={replyMut.isPending || !replyBody.trim()}
                        onClick={() => replyMut.mutate({ conversationId: selected.id, body: replyBody.trim() })}>
                        <Send className="w-3.5 h-3.5" /> Send reply
                      </Button>
                    </div>
                  )}
                </>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </DashboardLayout>
  );
}
