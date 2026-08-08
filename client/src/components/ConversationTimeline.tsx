import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle,
} from "@/components/ui/sheet";
import { toast } from "sonner";
import {
  Phone, MessageSquare, Clock, AlertTriangle, RefreshCw, Bot, User, Send,
} from "lucide-react";

type Conversation = {
  id: string;
  customerName: string;
  customerPhone: string;
  lastMessage: string;
  lastMessageAt: Date | string;
  status: string;
  aiConfidence?: number | null;
  intent?: string | null;
  messageCount: number;
};

const STATUS_COLORS: Record<string, string> = {
  bot_active: "bg-green-500/20 text-green-400 border-green-500/30",
  open: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  escalated: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
  resolved: "bg-slate-500/20 text-slate-400 border-slate-500/30",
  closed: "bg-slate-500/20 text-slate-400 border-slate-500/30",
};

export default function ConversationTimeline({
  conversation,
  open,
  onClose,
  tenantId,
}: {
  conversation: Conversation | null;
  open: boolean;
  onClose: () => void;
  tenantId: string;
}) {
  const [messageText, setMessageText] = useState("");

  // NOTE: the server filters by phone AFTER applying the limit, so a small
  // limit can return zero rows even when the conversation has messages.
  // Request a large window to avoid false "No messages found" states.
  const { data: messages, isLoading, refetch } = trpc.conversation.getMessages.useQuery(
    { tenantId, customerPhone: conversation?.customerPhone ?? undefined, limit: 500 },
    { enabled: open && !!conversation && !!tenantId }
  );

  const sendMessageMutation = trpc.conversation.sendMessage.useMutation({
    onSuccess: () => {
      toast.success("Message sent");
      setMessageText("");
      refetch();
    },
    onError: (err) => toast.error(err.message),
  });

  if (!conversation) return null;

  const statusClass = STATUS_COLORS[conversation.status] ?? STATUS_COLORS.open;

  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()}>
      <SheetContent className="w-full sm:max-w-xl bg-slate-900 border-slate-700 text-slate-100 overflow-y-auto">
        <SheetHeader className="pb-4 border-b border-slate-700">
          <SheetTitle className="text-slate-100 flex items-center gap-2">
            <div className="w-8 h-8 rounded-full bg-green-600 flex items-center justify-center text-white text-sm font-bold">
              {conversation.customerName.charAt(0).toUpperCase()}
            </div>
            <div>
              <div className="font-semibold">{conversation.customerName}</div>
              <div className="text-xs text-slate-400 flex items-center gap-1">
                <Phone className="h-3 w-3" />{conversation.customerPhone}
              </div>
            </div>
            <Badge className={`ml-auto text-xs border ${statusClass}`}>
              {conversation.status.replace("_", " ")}
            </Badge>
          </SheetTitle>
        </SheetHeader>

        {/* Meta row */}
        <div className="flex gap-4 py-3 text-xs text-slate-400 border-b border-slate-700">
          {conversation.intent && (
            <span className="flex items-center gap-1">
              <Bot className="h-3 w-3" /> Intent: <span className="text-slate-200">{conversation.intent}</span>
            </span>
          )}
          {conversation.aiConfidence != null && (
            <span>Confidence: <span className="text-slate-200">{Math.round(conversation.aiConfidence * 100)}%</span></span>
          )}
          <span className="flex items-center gap-1">
            <MessageSquare className="h-3 w-3" /> {conversation.messageCount} msgs
          </span>
          <span className="flex items-center gap-1">
            <Clock className="h-3 w-3" />
            {new Date(conversation.lastMessageAt).toLocaleString()}
          </span>
        </div>

        {/* Escalation warning */}
        {conversation.status === "escalated" && (
          <div className="flex items-start gap-2 bg-yellow-500/10 border border-yellow-500/20 rounded-lg p-3 my-3">
            <AlertTriangle className="h-4 w-4 text-yellow-400 mt-0.5 shrink-0" />
            <p className="text-xs text-yellow-300">
              This conversation was escalated from the AI bot. An operator should respond directly.
            </p>
          </div>
        )}

        {/* Messages */}
        <div className="py-4 space-y-3">
          {isLoading ? (
            <div className="space-y-3">
              {[...Array(4)].map((_, i) => (
                <div key={i} className={`flex ${i % 2 === 0 ? "justify-start" : "justify-end"}`}>
                  <Skeleton className={`h-14 ${i % 2 === 0 ? "w-3/4" : "w-2/3"} bg-slate-700`} />
                </div>
              ))}
            </div>
          ) : !messages || messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-slate-500">
              <MessageSquare className="h-10 w-10 mb-3 opacity-30" />
              {(conversation?.messageCount ?? 0) > 0 ? (
                <>
                  <p className="text-sm">This conversation has {conversation?.messageCount} message{conversation?.messageCount === 1 ? "" : "s"}, but they could not be loaded.</p>
                  <p className="text-xs mt-1 text-slate-600">The message history for this channel may not be synced yet.</p>
                  <Button variant="outline" size="sm" className="mt-3 text-xs border-slate-600 text-slate-300" onClick={() => refetch()}>
                    Retry
                  </Button>
                </>
              ) : (
                <>
                  <p className="text-sm">No messages found for this conversation.</p>
                  <p className="text-xs mt-1 text-slate-600">Messages appear here once the customer sends a WhatsApp message.</p>
                </>
              )}
            </div>
          ) : (
            [...messages].reverse().map((msg) => (
              <div
                key={msg.id}
                className={`flex gap-2 ${msg.direction === "outbound" ? "justify-end" : "justify-start"}`}
              >
                {msg.direction === "inbound" && (
                  <div className="w-6 h-6 rounded-full bg-slate-600 flex items-center justify-center shrink-0 mt-1">
                    <User className="h-3 w-3 text-slate-300" />
                  </div>
                )}
                <div
                  className={`max-w-[80%] rounded-2xl px-4 py-2.5 text-sm ${
                    msg.direction === "outbound"
                      ? "bg-green-600 text-white rounded-tr-sm"
                      : "bg-slate-700 text-slate-100 rounded-tl-sm"
                  }`}
                >
                  <p>{msg.content}</p>
                  <p className={`text-[10px] mt-1 ${msg.direction === "outbound" ? "text-green-200" : "text-slate-400"}`}>
                    {new Date(msg.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    {msg.direction === "outbound" && msg.status && (
                      <span className="ml-1">
                        {msg.status === "read" ? "✓✓" : msg.status === "delivered" ? "✓✓" : "✓"}
                      </span>
                    )}
                  </p>
                </div>
                {msg.direction === "outbound" && (
                  <div className="w-6 h-6 rounded-full bg-green-700 flex items-center justify-center shrink-0 mt-1">
                    <Bot className="h-3 w-3 text-white" />
                  </div>
                )}
              </div>
            ))
          )}
        </div>

        {/* Reply input */}
        <div className="border-t border-slate-700 pt-4 mt-auto">
          <div className="flex gap-2">
            <textarea
              value={messageText}
              onChange={(e) => setMessageText(e.target.value)}
              placeholder="Type a reply…"
              rows={2}
              className="flex-1 bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 outline-none focus:ring-1 focus:ring-green-500 resize-none"
            />
            <Button
              size="icon"
              className="bg-green-600 hover:bg-green-700 self-end"
              disabled={!messageText.trim() || sendMessageMutation.isPending}
              onClick={() =>
                sendMessageMutation.mutate({
                  tenantId,
                  customerPhone: conversation.customerPhone,
                  content: messageText,
                })
              }
            >
              <Send className="h-4 w-4" />
            </Button>
          </div>
          <p className="text-[10px] text-slate-500 mt-1.5">Replies are sent via WhatsApp Business API</p>
        </div>
      </SheetContent>
    </Sheet>
  );
}
