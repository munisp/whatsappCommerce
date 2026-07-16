import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { trpc } from "@/lib/trpc";
import { formatDistanceToNow, format } from "date-fns";
import { MessageSquare, Bot, User, ArrowDownLeft, ArrowUpRight, Send, CheckCircle, AlertTriangle } from "lucide-react";
import { useState, useRef, useEffect } from "react";
import { toast } from "sonner";

type ConversationRow = {
  id: string;
  customerPhone?: string | null;
  customerName?: string | null;
  status: string;
  channel: string;
  messageCount: number;
  updatedAt: Date | string;
};

interface Props {
  open: boolean;
  onClose: () => void;
  conversation: ConversationRow | null;
  tenantId: string;
  onStatusChange?: () => void;
}

export default function ConversationTimeline({ open, onClose, conversation, tenantId, onStatusChange }: Props) {
  const [replyText, setReplyText] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const utils = trpc.useUtils();

  const { data: messages, isLoading, refetch } = trpc.conversation.getMessages.useQuery(
    { tenantId, customerPhone: conversation?.customerPhone ?? undefined, limit: 60 },
    { enabled: open && !!conversation && !!tenantId }
  );

  const sendMutation = trpc.conversation.sendMessage.useMutation({
    onSuccess: (result) => {
      if (result.sent) {
        setReplyText("");
        refetch();
        toast.success("Message sent");
      } else {
        toast.error(result.error ?? "Failed to send message");
      }
    },
    onError: (e) => toast.error(e.message),
  });

  const updateStatusMutation = trpc.conversation.updateStatus.useMutation({
    onSuccess: () => {
      utils.conversation.list.invalidate();
      onStatusChange?.();
      toast.success("Status updated");
    },
    onError: (e) => toast.error(e.message),
  });

  // Scroll to bottom when messages load
  useEffect(() => {
    if (messages && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages]);

  const handleSend = () => {
    if (!replyText.trim() || !conversation?.customerPhone) return;
    sendMutation.mutate({ tenantId, toPhone: conversation.customerPhone, body: replyText.trim() });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleSend();
  };

  const isResolved = conversation?.status === "resolved";
  const isEscalated = conversation?.status === "human_active";

  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()}>
      <SheetContent className="w-full sm:max-w-lg bg-slate-900 border-slate-700 flex flex-col p-0">
        {/* Header */}
        <SheetHeader className="px-5 pt-5 pb-3 border-b border-slate-700">
          <SheetTitle className="text-white flex items-center gap-2">
            <MessageSquare className="h-4 w-4 text-primary" />
            Message Timeline
          </SheetTitle>
          {conversation && (
            <div className="flex flex-wrap gap-2 mt-1">
              <Badge variant="outline" className="text-xs text-slate-300 border-slate-600">
                {conversation.customerName ?? "Unknown Customer"}
              </Badge>
              {conversation.customerPhone && (
                <Badge variant="outline" className="text-xs font-mono text-slate-400 border-slate-700">
                  {conversation.customerPhone}
                </Badge>
              )}
              <Badge variant="outline" className="text-xs text-slate-400 border-slate-700 capitalize">
                {conversation.channel}
              </Badge>
              <Badge variant="outline" className={`text-xs border capitalize ${
                isResolved ? "bg-green-500/20 text-green-400 border-green-500/30"
                : isEscalated ? "bg-purple-500/20 text-purple-400 border-purple-500/30"
                : "text-slate-400 border-slate-700"
              }`}>
                {conversation.status.replace("_", " ")}
              </Badge>
            </div>
          )}
          {/* Resolve / Escalate action buttons */}
          {conversation && (
            <div className="flex gap-2 mt-2">
              <Button
                size="sm"
                variant="outline"
                className={`h-7 text-xs gap-1 ${isResolved ? "bg-green-500/20 text-green-400 border-green-500/30" : "border-slate-600 text-slate-300 hover:bg-green-500/10 hover:text-green-400"}`}
                disabled={isResolved || updateStatusMutation.isPending}
                onClick={() => updateStatusMutation.mutate({ conversationId: conversation.id, status: "resolved" })}
              >
                <CheckCircle className="h-3 w-3" />
                {isResolved ? "Resolved" : "Resolve"}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className={`h-7 text-xs gap-1 ${isEscalated ? "bg-purple-500/20 text-purple-400 border-purple-500/30" : "border-slate-600 text-slate-300 hover:bg-purple-500/10 hover:text-purple-400"}`}
                disabled={isEscalated || updateStatusMutation.isPending}
                onClick={() => updateStatusMutation.mutate({ conversationId: conversation.id, status: "human_active" })}
              >
                <AlertTriangle className="h-3 w-3" />
                {isEscalated ? "Escalated" : "Escalate"}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs gap-1 border-slate-600 text-slate-300 hover:bg-blue-500/10 hover:text-blue-400"
                disabled={updateStatusMutation.isPending}
                onClick={() => updateStatusMutation.mutate({ conversationId: conversation.id, status: "open" })}
              >
                Reopen
              </Button>
            </div>
          )}
        </SheetHeader>

        {/* Message list */}
        <ScrollArea className="flex-1 px-4 py-3">
          {isLoading ? (
            <div className="space-y-3">
              {[...Array(5)].map((_, i) => (
                <div key={i} className={`flex gap-2 ${i % 2 === 0 ? "" : "flex-row-reverse"}`}>
                  <Skeleton className="h-8 w-8 rounded-full flex-shrink-0 bg-slate-700" />
                  <Skeleton className="h-12 w-56 rounded-lg bg-slate-700" />
                </div>
              ))}
            </div>
          ) : !messages || messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-slate-500">
              <MessageSquare className="h-10 w-10 mb-3 opacity-30" />
              <p className="text-sm">No messages found for this conversation.</p>
              <p className="text-xs mt-1 text-slate-600">Messages appear here once the customer sends a WhatsApp message.</p>
            </div>
          ) : (
            <div className="space-y-3 pb-2">
              {[...messages].reverse().map((msg) => {
                const isOutbound = msg.direction === "outbound";
                return (
                  <div key={msg.id} className={`flex gap-2 ${isOutbound ? "flex-row-reverse" : ""}`}>
                    <div className={`flex-shrink-0 h-7 w-7 rounded-full flex items-center justify-center text-xs ${
                      isOutbound ? "bg-primary/20 text-primary" : "bg-slate-700 text-slate-300"
                    }`}>
                      {isOutbound ? <Bot className="h-3.5 w-3.5" /> : <User className="h-3.5 w-3.5" />}
                    </div>
                    <div className={`max-w-[75%] rounded-xl px-3 py-2 text-sm ${
                      isOutbound
                        ? "bg-primary/15 text-primary-foreground border border-primary/20 rounded-tr-none"
                        : "bg-slate-800 text-slate-200 border border-slate-700 rounded-tl-none"
                    }`}>
                      <p className="leading-relaxed whitespace-pre-wrap break-words">{msg.body}</p>
                      <div className={`flex items-center gap-1 mt-1 text-xs opacity-60 ${isOutbound ? "justify-end" : ""}`}>
                        {isOutbound ? <ArrowUpRight className="h-2.5 w-2.5" /> : <ArrowDownLeft className="h-2.5 w-2.5" />}
                        <span>{format(new Date(msg.createdAt), "HH:mm")}</span>
                        <span className="text-slate-500">·</span>
                        <span>{formatDistanceToNow(new Date(msg.createdAt), { addSuffix: true })}</span>
                      </div>
                    </div>
                  </div>
                );
              })}
              <div ref={bottomRef} />
            </div>
          )}
        </ScrollArea>

        {/* Reply input */}
        <div className="border-t border-slate-700 px-4 py-3">
          {!conversation?.customerPhone ? (
            <p className="text-xs text-slate-500 text-center py-2">No phone number — cannot send reply.</p>
          ) : (
            <>
              <Textarea
                placeholder="Type a reply… (Ctrl+Enter to send)"
                className="bg-slate-800 border-slate-700 text-slate-200 placeholder:text-slate-500 resize-none text-sm min-h-[72px]"
                value={replyText}
                onChange={(e) => setReplyText(e.target.value)}
                onKeyDown={handleKeyDown}
                disabled={sendMutation.isPending}
              />
              <div className="flex justify-between items-center mt-2">
                <span className="text-xs text-slate-500">{replyText.length}/4096</span>
                <Button
                  size="sm"
                  className="gap-1.5"
                  disabled={!replyText.trim() || sendMutation.isPending}
                  onClick={handleSend}
                >
                  <Send className="h-3.5 w-3.5" />
                  {sendMutation.isPending ? "Sending…" : "Send"}
                </Button>
              </div>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
