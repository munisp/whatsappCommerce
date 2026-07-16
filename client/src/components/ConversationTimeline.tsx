import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { trpc } from "@/lib/trpc";
import { formatDistanceToNow, format } from "date-fns";
import { MessageSquare, Bot, User, ArrowDownLeft, ArrowUpRight } from "lucide-react";

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
}

export default function ConversationTimeline({ open, onClose, conversation, tenantId }: Props) {
  const { data: messages, isLoading } = trpc.conversation.getMessages.useQuery(
    { tenantId, customerPhone: conversation?.customerPhone ?? undefined, limit: 60 },
    { enabled: open && !!conversation && !!tenantId }
  );

  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()}>
      <SheetContent className="w-full sm:max-w-lg bg-slate-900 border-slate-700 flex flex-col">
        <SheetHeader className="pb-3 border-b border-slate-700">
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
              <Badge variant="outline" className="text-xs text-slate-400 border-slate-700">
                {conversation.messageCount} msgs
              </Badge>
            </div>
          )}
        </SheetHeader>

        <ScrollArea className="flex-1 mt-4 pr-1">
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
            <div className="space-y-3 pb-4">
              {[...messages].reverse().map((msg) => {
                const isOutbound = msg.direction === "outbound";
                return (
                  <div key={msg.id} className={`flex gap-2 ${isOutbound ? "flex-row-reverse" : ""}`}>
                    {/* Avatar */}
                    <div className={`flex-shrink-0 h-7 w-7 rounded-full flex items-center justify-center text-xs ${
                      isOutbound ? "bg-primary/20 text-primary" : "bg-slate-700 text-slate-300"
                    }`}>
                      {isOutbound ? <Bot className="h-3.5 w-3.5" /> : <User className="h-3.5 w-3.5" />}
                    </div>
                    {/* Bubble */}
                    <div className={`max-w-[75%] rounded-xl px-3 py-2 text-sm ${
                      isOutbound
                        ? "bg-primary/15 text-primary-foreground border border-primary/20 rounded-tr-none"
                        : "bg-slate-800 text-slate-200 border border-slate-700 rounded-tl-none"
                    }`}>
                      <p className="leading-relaxed whitespace-pre-wrap break-words">{msg.body}</p>
                      <div className={`flex items-center gap-1 mt-1 text-xs opacity-60 ${isOutbound ? "justify-end" : ""}`}>
                        {isOutbound
                          ? <ArrowUpRight className="h-2.5 w-2.5" />
                          : <ArrowDownLeft className="h-2.5 w-2.5" />}
                        <span>{format(new Date(msg.createdAt), "HH:mm")}</span>
                        <span className="text-slate-500">·</span>
                        <span>{formatDistanceToNow(new Date(msg.createdAt), { addSuffix: true })}</span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
