import { useRoute, Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ArrowLeft, CheckCircle2, Clock, XCircle, Info,
  ShoppingCart, CreditCard, Package, Building2, Users,
  MessageSquare, Truck, RefreshCw,
  Reply, Eye, EyeOff, Image, FileText, Mic, User2,
} from "lucide-react";
import { Sparkles, Paperclip, X as XIcon, Send, UploadCloud, BellOff } from "lucide-react";
import { toast } from "sonner";
import { useCallback, useRef, useState } from "react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const STATUS_COLORS: Record<string, string> = {
  pending: "bg-yellow-500/10 text-yellow-600 border-yellow-500/20",
  confirmed: "bg-blue-500/10 text-blue-600 border-blue-500/20",
  processing: "bg-purple-500/10 text-purple-600 border-purple-500/20",
  shipped: "bg-indigo-500/10 text-indigo-600 border-indigo-500/20",
  delivered: "bg-green-500/10 text-green-600 border-green-500/20",
  cancelled: "bg-red-500/10 text-red-600 border-red-500/20",
  refunded: "bg-gray-500/10 text-gray-600 border-gray-500/20",
};

const PAYMENT_STATUS_COLORS: Record<string, string> = {
  unpaid: "bg-red-500/10 text-red-600 border-red-500/20",
  paid: "bg-green-500/10 text-green-600 border-green-500/20",
  partial: "bg-yellow-500/10 text-yellow-600 border-yellow-500/20",
  refunded: "bg-gray-500/10 text-gray-600 border-gray-500/20",
};

function TimelineIcon({ status, system }: { status: string; system: string }) {
  const cls = "w-5 h-5";
  if (status === "failed") return <XCircle className={`${cls} text-red-500`} />;
  if (status === "pending") return <Clock className={`${cls} text-yellow-500`} />;
  if (system === "WhatsApp Platform") return <MessageSquare className={`${cls} text-green-500`} />;
  if (system === "Payment Gateway") return <CreditCard className={`${cls} text-blue-500`} />;
  if (system === "Medusa Commerce") return <Package className={`${cls} text-purple-500`} />;
  if (system === "Odoo ERP") return <Building2 className={`${cls} text-orange-500`} />;
  if (system === "Twenty CRM") return <Users className={`${cls} text-cyan-500`} />;
  return <CheckCircle2 className={`${cls} text-green-500`} />;
}

function TimelineDot({ status }: { status: string }) {
  const colors: Record<string, string> = {
    success: "bg-green-500 ring-green-500/20",
    pending: "bg-yellow-500 ring-yellow-500/20",
    failed: "bg-red-500 ring-red-500/20",
    info: "bg-blue-500 ring-blue-500/20",
  };
  return (
    <div className={`w-3 h-3 rounded-full ring-4 ${colors[status] ?? colors.info} flex-shrink-0`} />
  );
}

function IntegrationBadge({ label, active, color }: { label: string; active: boolean; color: string }) {
  return (
    <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-xs font-medium ${
      active ? color : "bg-muted/40 text-muted-foreground border-border"
    }`}>
      <div className={`w-1.5 h-1.5 rounded-full ${active ? "bg-current" : "bg-muted-foreground/40"}`} />
      {label}
    </div>
  );
}


// ── WhatsApp Notification Status Panel ───────────────────────────────────────
const WA_STATUS_CONFIG: Record<string, { label: string; className: string }> = {
  pending:   { label: "Pending",   className: "text-yellow-600 bg-yellow-50 border-yellow-200" },
  sent:      { label: "Sent",      className: "text-blue-600 bg-blue-50 border-blue-200" },
  delivered: { label: "Delivered", className: "text-green-600 bg-green-50 border-green-200" },
  read:      { label: "Read",      className: "text-purple-600 bg-purple-50 border-purple-200" },
  failed:    { label: "Failed",    className: "text-red-600 bg-red-50 border-red-200" },
  simulated: { label: "Simulated", className: "text-gray-600 bg-gray-50 border-gray-200" },
};
const WA_TYPE_LABELS: Record<string, string> = {
  order_confirmation: "Order Confirmed",
  order_shipped:      "Order Shipped",
  order_delivered:    "Order Delivered",
  order_cancelled:    "Order Cancelled",
};
function WhatsAppNotifPanel({ orderId }: { orderId: string }) {
  const utils = trpc.useUtils();
  const resendMutation = trpc.whatsappNotifications.resendNotification.useMutation({
    onSuccess: (result) => {
      toast.success(result.success ? "Notification resent successfully" : "Resend queued (simulation mode)");
      utils.whatsappNotifications.getOrderNotifStatus.invalidate({ orderId });
    },
    onError: (err) => toast.error(`Resend failed: ${err.message}`),
  });
  const [resendingId, setResendingId] = useState<string | null>(null);
  const { data, isLoading } = trpc.whatsappNotifications.getOrderNotifStatus.useQuery(
    { orderId },
    { enabled: !!orderId }
  );
  const logs = data?.logs ?? [];
  if (isLoading) return null;
  if (logs.length === 0) return null;
  return (
    <div className="rounded-xl border bg-card overflow-hidden">
      <div className="px-5 py-3 border-b bg-green-500/5 flex items-center gap-2">
        <MessageSquare className="w-4 h-4 text-green-600" />
        <span className="text-sm font-medium">WhatsApp Notifications</span>
        <Badge variant="outline" className="ml-auto text-xs text-green-600 border-green-200 bg-green-50">
          {logs.length} sent
        </Badge>
      </div>
      <div className="p-4 space-y-2">
        {logs.map((log) => {
          const status = (log.status ?? "pending") as string;
          const cfg = WA_STATUS_CONFIG[status] ?? WA_STATUS_CONFIG.pending;
          const typeLabel = WA_TYPE_LABELS[log.notifType] ?? log.notifType;
          return (
            <div key={log.id} className="flex items-center gap-3 p-3 rounded-lg border bg-background">
              <MessageSquare className="h-4 w-4 text-green-600 shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium">{typeLabel}</span>
                  <Badge variant="outline" className={`text-xs shrink-0 ${cfg.className}`}>
                    {cfg.label}
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground mt-0.5 font-mono">
                  {log.phone?.replace(/(\+\d{3})\d+(\d{4})/, "$1****$2")}
                </p>
                <div className="flex items-center gap-3 mt-0.5">
                  {log.sentAt && (
                    <span className="text-xs text-muted-foreground/60">
                      Sent {new Date(log.sentAt).toLocaleString()}
                    </span>
                  )}
                  {log.deliveredAt && (
                    <span className="text-xs text-green-600/70">
                      · Delivered {new Date(log.deliveredAt).toLocaleString()}
                    </span>
                  )}
                  {log.readAt && (
                    <span className="text-xs text-purple-600/70">
                      · Read {new Date(log.readAt).toLocaleString()}
                    </span>
                  )}
                </div>
                {log.failReason && (
                  <p className="text-xs text-red-600 mt-0.5">Error: {log.failReason}</p>
                )}
                {log.wamid && (
                  <p className="text-[10px] text-muted-foreground/40 font-mono mt-0.5">
                    WAMID: {log.wamid}
                  </p>
                )}
              </div>
              {status === "failed" && (
                <Button
                  variant="outline"
                  size="sm"
                  className="shrink-0 h-7 text-xs gap-1 border-red-200 text-red-600 hover:bg-red-50"
                  disabled={resendingId === log.id || resendMutation.isPending}
                  onClick={() => {
                    setResendingId(log.id);
                    resendMutation.mutate(
                      { logId: log.id },
                      { onSettled: () => setResendingId(null) }
                    );
                  }}
                >
                  <RefreshCw className={`w-3 h-3 ${resendingId === log.id ? "animate-spin" : ""}`} />
                  Resend
                </Button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Customer Replies Panel ────────────────────────────────────────────────────
const MSG_TYPE_ICON: Record<string, React.ElementType> = {
  text: MessageSquare,
  image: Image,
  document: FileText,
  audio: Mic,
  video: Package,
};

function CustomerRepliesPanel({ orderId }: { orderId: string }) {
  const utils = trpc.useUtils();
  const { data, isLoading } = trpc.whatsappNotifications.getCustomerReplies.useQuery(
    { orderId },
    { refetchInterval: 30_000 }
  );
  const markRead = trpc.whatsappNotifications.markReplyRead.useMutation({
    onSuccess: () => utils.whatsappNotifications.getCustomerReplies.invalidate({ orderId }),
  });

  const replies = data?.replies ?? [];
  // Lightbox state for image previews
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  // Send reply state
  const [replyText, setReplyText] = useState("");
  const sendReply = trpc.whatsappNotifications.sendAdminReply.useMutation({
    onSuccess: (result) => {
      if (result.simulated) {
        toast.info("Reply simulated — no WhatsApp credentials configured");
      } else {
        toast.success("Reply sent via WhatsApp");
      }
      setReplyText("");
    },
    onError: (err) => toast.error(`Send failed: ${err.message}`),
  });
  const customerPhone = replies[0]?.fromPhone ?? null;

  // AI suggestion state
  const [isSuggesting, setIsSuggesting] = useState(false);
  const suggestReply = trpc.whatsappNotifications.suggestReply.useMutation({
    onSuccess: (result) => {
      setReplyText(result.suggestion);
      setIsSuggesting(false);
      toast.success("AI suggestion ready — review and send");
    },
    onError: (err) => {
      setIsSuggesting(false);
      toast.error(`AI suggestion failed: ${err.message}`);
    },
  });

  // File attachment state
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [attachment, setAttachment] = useState<{
    file: File;
    previewUrl: string | null;
    base64: string;
  } | null>(null);
  const sendAttachment = trpc.whatsappNotifications.sendAttachment.useMutation({
    onSuccess: (result) => {
      if (result.simulated) {
        toast.info("Attachment simulated — no WhatsApp credentials configured");
      } else {
        toast.success("Attachment sent via WhatsApp");
      }
      setAttachment(null);
      setReplyText("");
    },
    onError: (err) => toast.error(`Attachment send failed: ${err.message}`),
  });

  const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf"] as const;
  type AllowedMime = typeof ALLOWED_TYPES[number];

  function handleFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!ALLOWED_TYPES.includes(file.type as AllowedMime)) {
      toast.error("Only JPEG, PNG, WebP, GIF, and PDF files are supported");
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      toast.error("File must be under 10 MB");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const base64 = result.split(",")[1] ?? "";
      const previewUrl = file.type.startsWith("image/") ? result : null;
      setAttachment({ file, previewUrl, base64 });
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  }

  function handleSendAttachment() {
    if (!attachment || !customerPhone) return;
    sendAttachment.mutate({
      phone: customerPhone,
      orderId,
      fileBase64: attachment.base64,
      fileName: attachment.file.name,
      mimeType: attachment.file.type as AllowedMime,
      caption: replyText.trim() || undefined,
    });
  }

  // Mark as unread mutation
  const markUnread = trpc.whatsappNotifications.markReplyUnread.useMutation({
    onSuccess: () => {
      utils.whatsappNotifications.getCustomerReplies.invalidate({ orderId });
      toast.info("Marked as unread");
    },
    onError: (err) => toast.error(`Failed: ${err.message}`),
  });

  // Tone selector state for AI suggestions
  const [selectedTone, setSelectedTone] = useState<"professional" | "friendly" | "empathetic" | "concise">("professional");
  const TONE_LABELS: Record<string, string> = {
    professional: "Professional",
    friendly: "Friendly",
    empathetic: "Empathetic",
    concise: "Concise",
  };

  // Drag-and-drop state
  const [isDragOver, setIsDragOver] = useState(false);
  const dropZoneRef = useRef<HTMLDivElement>(null);

  const processDroppedFile = useCallback((file: File) => {
    const ALLOWED = ["image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf"] as const;
    type AllowedMime = typeof ALLOWED[number];
    if (!ALLOWED.includes(file.type as AllowedMime)) {
      toast.error("Only JPEG, PNG, WebP, GIF, and PDF files are supported");
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      toast.error("File must be under 10 MB");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const base64 = result.split(",")[1] ?? "";
      const previewUrl = file.type.startsWith("image/") ? result : null;
      setAttachment({ file, previewUrl, base64 });
      toast.success(`${file.name} attached — ready to send`);
    };
    reader.readAsDataURL(file);
  }, []);

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  }
  function handleDragLeave(e: React.DragEvent) {
    // Only clear if leaving the drop zone itself (not a child)
    if (!dropZoneRef.current?.contains(e.relatedTarget as Node)) {
      setIsDragOver(false);
    }
  }
  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) processDroppedFile(file);
  }

  if (!isLoading && replies.length === 0) return null;
  const unreadCount = replies.filter((r) => !r.read).length;

  return (
    <Card className="mt-6">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-lg bg-green-50 border border-green-200 flex items-center justify-center">
            <Reply className="h-5 w-5 text-green-600" />
          </div>
          <div className="flex-1">
            <CardTitle className="text-base flex items-center gap-2">
              Customer Replies
              {unreadCount > 0 && (
                <span className="inline-flex items-center justify-center h-5 min-w-[20px] px-1 rounded-full bg-green-600 text-white text-[10px] font-bold">
                  {unreadCount}
                </span>
              )}
            </CardTitle>
            <CardDescription>
              WhatsApp messages received from the customer for this order
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-2">
            {[1, 2].map((i) => (
              <div key={i} className="h-14 rounded-lg bg-muted animate-pulse" />
            ))}
          </div>
        ) : (
          <ScrollArea className="max-h-[360px]">
            <div className="space-y-2 pr-2">
              {replies.map((reply) => {
                const MsgIcon = MSG_TYPE_ICON[reply.messageType ?? "text"] ?? MessageSquare;
                return (
                  <div
                    key={reply.id}
                    className={`flex items-start gap-3 p-3 rounded-lg border transition-colors ${
                      reply.read
                        ? "bg-card border-border"
                        : "bg-green-50/50 border-green-200"
                    }`}
                  >
                    <div className="h-8 w-8 rounded-full bg-muted flex items-center justify-center shrink-0">
                      <User2 className="h-4 w-4 text-muted-foreground" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-1.5">
                          <MsgIcon className="h-3.5 w-3.5 text-muted-foreground" />
                          <p className="text-xs text-muted-foreground font-mono">
                            {reply.fromPhone?.replace(/(\+\d{3})\d+(\d{4})/, "$1****$2")}
                          </p>
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                          <p className="text-[10px] text-muted-foreground/60">
                            {new Date(reply.createdAt).toLocaleString()}
                          </p>
                          {/* Mark as read button */}
                          {!reply.read && (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-6 w-6"
                              title="Mark as read"
                              onClick={() => markRead.mutate({ replyId: reply.id })}
                              disabled={markRead.isPending}
                            >
                              <Eye className="h-3 w-3 text-green-600" />
                            </Button>
                          )}
                          {/* Mark as unread button — only visible on read messages */}
                          {reply.read && (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-6 w-6"
                              title="Mark as unread (follow up later)"
                              onClick={() => markUnread.mutate({ replyId: reply.id })}
                              disabled={markUnread.isPending}
                            >
                              <BellOff className="h-3 w-3 text-muted-foreground hover:text-orange-500" />
                            </Button>
                          )}
                        </div>
                      </div>
                      {reply.body && (
                        <p className="text-sm mt-1 break-words">{reply.body}</p>
                      )}
                      {/* Image thumbnail with lightbox */}
                      {reply.messageType === "image" && reply.mediaUrl && (
                        <button
                          type="button"
                          className="mt-2 block"
                          onClick={() => setLightboxUrl(reply.mediaUrl!)}
                          title="Click to enlarge"
                        >
                          <img
                            src={reply.mediaUrl}
                            alt="Customer image"
                            className="max-h-32 max-w-[240px] rounded border border-border object-contain cursor-zoom-in hover:opacity-90 transition-opacity"
                          />

                        </button>
                      )}
                      {/* Inline audio player for voice notes */}
                      {reply.messageType === "audio" && reply.mediaUrl && (
                        <div className="mt-2">
                          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                          <audio controls src={reply.mediaUrl} className="w-full max-w-xs h-8" />
                        </div>
                      )}
                      {/* Fallback placeholder for other media types without a URL */}
                      {reply.messageType !== "text" && !reply.body &&
                        !(reply.messageType === "image" && reply.mediaUrl) &&
                        !(reply.messageType === "audio" && reply.mediaUrl) && (
                        <p className="text-sm mt-1 text-muted-foreground italic">
                          [{reply.messageType} message]
                        </p>
                      )}
                      {reply.contextWamid && (
                        <p className="text-[10px] text-muted-foreground/50 mt-1 font-mono">
                          ↩ Reply to WAMID: {reply.contextWamid.slice(0, 20)}…
                        </p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </ScrollArea>
        )}
        {/* Send Reply section — also serves as drag-and-drop zone */}
        {customerPhone && (
          <div
            ref={dropZoneRef}
            className={`mt-4 pt-4 border-t space-y-2 relative transition-colors rounded-lg ${
              isDragOver ? "bg-green-50/60 ring-2 ring-green-400 ring-dashed" : ""
            }`}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
            {/* Drop overlay */}
            {isDragOver && (
              <div className="absolute inset-0 flex flex-col items-center justify-center z-10 rounded-lg pointer-events-none">
                <UploadCloud className="h-8 w-8 text-green-500 mb-1" />
                <p className="text-sm font-medium text-green-700">Drop to attach file</p>
              </div>
            )}
            <p className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
              <Reply className="h-3.5 w-3.5" />
              Reply to customer via WhatsApp
            </p>
            {/* Attachment preview */}
            {attachment && (
              <div className="flex items-center gap-2 p-2 rounded-lg bg-muted/50 border border-border">
                {attachment.previewUrl ? (
                  <img
                    src={attachment.previewUrl}
                    alt="Attachment preview"
                    className="h-12 w-12 rounded object-cover border border-border"
                  />
                ) : (
                  <div className="h-12 w-12 rounded bg-muted flex items-center justify-center border border-border">
                    <FileText className="h-6 w-6 text-muted-foreground" />
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium truncate">{attachment.file.name}</p>
                  <p className="text-[10px] text-muted-foreground">
                    {(attachment.file.size / 1024).toFixed(0)} KB · {attachment.file.type}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setAttachment(null)}
                  className="p-1 rounded hover:bg-muted transition-colors"
                  title="Remove attachment"
                >
                  <XIcon className="h-3.5 w-3.5 text-muted-foreground" />
                </button>
              </div>
            )}
            {/* Typing indicator while AI is generating */}
            {isSuggesting ? (
              <div className="flex items-center gap-3 px-3 py-3 rounded-md border border-purple-200 bg-purple-50/50 min-h-[64px]">
                <div className="flex items-center gap-1 shrink-0">
                  <Sparkles className="h-3.5 w-3.5 text-purple-400 animate-pulse" />
                </div>
                <div className="flex items-center gap-1.5">
                  <span
                    className="inline-block h-2 w-2 rounded-full bg-purple-400"
                    style={{ animation: "aiDot 1.2s ease-in-out infinite", animationDelay: "0ms" }}
                  />
                  <span
                    className="inline-block h-2 w-2 rounded-full bg-purple-400"
                    style={{ animation: "aiDot 1.2s ease-in-out infinite", animationDelay: "200ms" }}
                  />
                  <span
                    className="inline-block h-2 w-2 rounded-full bg-purple-400"
                    style={{ animation: "aiDot 1.2s ease-in-out infinite", animationDelay: "400ms" }}
                  />
                </div>
                <p className="text-xs text-purple-500 font-medium">AI is composing a reply…</p>
              </div>
            ) : (
              <div className={replyText && !isSuggesting ? "animate-[fadeIn_0.3s_ease-out]" : ""}>
                <Textarea
                  placeholder={attachment ? "Add a caption (optional)…" : "Type your reply…"}
                  value={replyText}
                  onChange={(e) => setReplyText(e.target.value)}
                  rows={2}
                  className="resize-none text-sm"
                  disabled={sendReply.isPending || sendAttachment.isPending}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                      if (attachment) {
                        handleSendAttachment();
                      } else if (replyText.trim()) {
                        sendReply.mutate({ phone: customerPhone, message: replyText.trim(), orderId });
                      }
                    }
                  }}
                />
              </div>
            )}
            <div className="flex items-center justify-between">
              <p className="text-[10px] text-muted-foreground/60">Ctrl/⌘+Enter to send quickly</p>
              <div className="flex items-center gap-1.5">
                {/* AI Suggest split button: tone dropdown + suggest */}
                <div className="flex items-center rounded-md border border-input overflow-hidden h-7">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs gap-1.5 rounded-none border-0 px-2"
                    disabled={isSuggesting || suggestReply.isPending || replies.length === 0}
                    onClick={() => {
                      setIsSuggesting(true);
                      suggestReply.mutate({
                        orderId,
                        tone: selectedTone,
                        recentReplies: replies.slice(0, 10).map((r) => ({
                          messageType: r.messageType ?? "text",
                          body: r.body ?? null,
                          fromPhone: r.fromPhone ?? "",
                          createdAt: new Date(r.createdAt).toISOString(),
                        })),
                      });
                    }}
                    title={`Get AI-suggested reply (${TONE_LABELS[selectedTone]} tone)`}
                  >
                    <Sparkles className="h-3.5 w-3.5 text-purple-500" />
                    {isSuggesting ? "Thinking…" : `AI Suggest`}
                  </Button>
                  <div className="w-px h-4 bg-border" />
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 text-[10px] rounded-none border-0 px-1.5 text-muted-foreground"
                        disabled={isSuggesting || suggestReply.isPending}
                        title="Select tone"
                      >
                        {TONE_LABELS[selectedTone]}
                        <svg className="h-3 w-3 ml-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m6 9 6 6 6-6"/></svg>
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="min-w-[130px]">
                      {(["professional", "friendly", "empathetic", "concise"] as const).map((tone) => (
                        <DropdownMenuItem
                          key={tone}
                          onClick={() => setSelectedTone(tone)}
                          className={selectedTone === tone ? "font-medium text-purple-600" : ""}
                        >
                          {TONE_LABELS[tone]}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
                {/* Attach file button */}
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs gap-1.5"
                  disabled={sendAttachment.isPending}
                  onClick={() => fileInputRef.current?.click()}
                  title="Attach image or PDF"
                >
                  <Paperclip className="h-3.5 w-3.5" />
                  Attach
                </Button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp,image/gif,application/pdf"
                  className="hidden"
                  onChange={handleFileSelected}
                />
                {/* Send button */}
                {attachment ? (
                  <Button
                    size="sm"
                    className="h-7 text-xs gap-1.5 bg-green-600 hover:bg-green-700 text-white"
                    disabled={sendAttachment.isPending}
                    onClick={handleSendAttachment}
                  >
                    <Send className="h-3.5 w-3.5" />
                    {sendAttachment.isPending ? "Sending…" : "Send File"}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    className="h-7 text-xs gap-1.5 bg-green-600 hover:bg-green-700 text-white"
                    disabled={!replyText.trim() || sendReply.isPending}
                    onClick={() =>
                      sendReply.mutate({ phone: customerPhone, message: replyText.trim(), orderId })
                    }
                  >
                    <Reply className="h-3.5 w-3.5" />
                    {sendReply.isPending ? "Sending…" : "Send Reply"}
                  </Button>
                )}
              </div>
            </div>
          </div>
        )}
      </CardContent>
      {/* Image lightbox modal */}
      <Dialog open={!!lightboxUrl} onOpenChange={(open) => !open && setLightboxUrl(null)}>
        <DialogContent className="max-w-3xl p-2 bg-black/90 border-0">
          {lightboxUrl && (
            <img
              src={lightboxUrl}
              alt="Customer image"
              className="max-h-[80vh] w-auto mx-auto rounded object-contain"
            />
          )}
        </DialogContent>
      </Dialog>
    </Card>
  );
}

export default function OrderTimeline() {
  const [, params] = useRoute("/orders/:orderNumber");
  const orderNumber = params?.orderNumber ?? "";

  const { data, isLoading, error } = trpc.nlp.getOrderTimeline.useQuery(
    { orderNumber },
    { enabled: !!orderNumber }
  );

  if (isLoading) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-8 space-y-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-32 w-full rounded-xl" />
        <Skeleton className="h-48 w-full rounded-xl" />
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-8">
        <Link href="/orders">
          <Button variant="ghost" size="sm" className="mb-4">
            <ArrowLeft className="w-4 h-4 mr-2" /> Back to Orders
          </Button>
        </Link>
        <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-6 text-center">
          <XCircle className="w-8 h-8 text-red-500 mx-auto mb-2" />
          <p className="text-sm text-muted-foreground">
            {error?.message ?? "Order not found"}
          </p>
        </div>
      </div>
    );
  }

  const { order, items, payments, timeline, integrations } = data;

  return (
    <div className="max-w-3xl mx-auto px-4 py-8 space-y-6">
      {/* Back button */}
      <Link href="/orders">
        <Button variant="ghost" size="sm">
          <ArrowLeft className="w-4 h-4 mr-2" /> Back to Orders
        </Button>
      </Link>

      {/* Order header */}
      <div className="rounded-xl border bg-card p-6 space-y-4">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-xl font-semibold text-card-foreground">{order.orderNumber}</h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              Created {new Date(order.createdAt).toLocaleString()}
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant="outline" className={STATUS_COLORS[order.status] ?? ""}>
              {order.status.charAt(0).toUpperCase() + order.status.slice(1)}
            </Badge>
            <Badge variant="outline" className={PAYMENT_STATUS_COLORS[order.paymentStatus ?? "unpaid"] ?? ""}>
              {order.paymentStatus ?? "unpaid"}
            </Badge>
          </div>
        </div>
        <div className="flex items-center gap-6 text-sm">
          <div>
            <span className="text-muted-foreground">Total</span>
            <p className="font-semibold text-card-foreground">
              {order.currency} {Number(order.totalAmount).toLocaleString()}
            </p>
          </div>
          {order.erpOrderId && (
            <div>
              <span className="text-muted-foreground">Medusa ID</span>
              <p className="font-mono text-xs text-card-foreground">{order.erpOrderId}</p>
            </div>
          )}
          {!!order.shippingAddress && (
          <div>
            <span className="text-muted-foreground">Delivery</span>
            <p className="text-card-foreground text-xs">
              {String(
                typeof order.shippingAddress === "object" && order.shippingAddress !== null
                  ? ((order.shippingAddress as Record<string, unknown>).raw ?? JSON.stringify(order.shippingAddress))
                  : order.shippingAddress
              )}
            </p>
          </div>
        )}
        </div>

        {/* Integration badges */}
        <div className="flex items-center gap-2 flex-wrap pt-1">
          <span className="text-xs text-muted-foreground mr-1">Integrations:</span>
          <IntegrationBadge label="Medusa" active={integrations.hasMedusa} color="bg-purple-500/10 text-purple-600 border-purple-500/20" />
          <IntegrationBadge label="Odoo ERP" active={integrations.hasOdoo} color="bg-orange-500/10 text-orange-600 border-orange-500/20" />
          <IntegrationBadge label="Twenty CRM" active={integrations.hasTwenty} color="bg-cyan-500/10 text-cyan-600 border-cyan-500/20" />
        </div>
      </div>

      {/* Order items */}
      {items.length > 0 && (
        <div className="rounded-xl border bg-card overflow-hidden">
          <div className="px-5 py-3 border-b bg-muted/30 flex items-center gap-2">
            <ShoppingCart className="w-4 h-4 text-muted-foreground" />
            <span className="text-sm font-medium">Order Items</span>
          </div>
          <div className="divide-y">
            {items.map((item) => (
              <div key={item.id} className="px-5 py-3 flex items-center justify-between text-sm">
                <div>
                  <p className="font-medium text-card-foreground">{item.productName}</p>
                  <p className="text-muted-foreground text-xs">Qty: {item.quantity}</p>
                </div>
                <p className="font-medium text-card-foreground">
                  {item.currency} {(Number(item.unitPrice) * item.quantity).toLocaleString()}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Payments */}
      {payments.length > 0 && (
        <div className="rounded-xl border bg-card overflow-hidden">
          <div className="px-5 py-3 border-b bg-muted/30 flex items-center gap-2">
            <CreditCard className="w-4 h-4 text-muted-foreground" />
            <span className="text-sm font-medium">Payments</span>
          </div>
          <div className="divide-y">
            {payments.map((p) => (
              <div key={p.id} className="px-5 py-3 flex items-center justify-between text-sm">
                <div>
                  <p className="font-medium text-card-foreground">{p.provider}</p>
                  <p className="text-muted-foreground text-xs">
                    {p.providerTxId ?? p.providerRef ?? "—"} · {new Date(p.createdAt).toLocaleString()}
                  </p>
                </div>
                <div className="text-right">
                  <p className="font-medium text-card-foreground">{p.currency} {Number(p.amount).toLocaleString()}</p>
                  <Badge variant="outline" className={`text-xs ${
                    p.status === "success" ? "text-green-600 border-green-500/20"
                    : p.status === "failed" ? "text-red-600 border-red-500/20"
                    : "text-yellow-600 border-yellow-500/20"
                  }`}>
                    {p.status}
                  </Badge>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Timeline */}
      <div className="rounded-xl border bg-card overflow-hidden">
        <div className="px-5 py-3 border-b bg-muted/30 flex items-center gap-2">
          <Truck className="w-4 h-4 text-muted-foreground" />
          <span className="text-sm font-medium">Order Timeline</span>
        </div>
        <div className="p-5">
          {timeline.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">No timeline events yet.</p>
          ) : (
            <ol className="relative space-y-0">
              {timeline.map((event, idx) => (
                <li key={event.id} className="flex gap-4">
                  {/* Connector line + dot */}
                  <div className="flex flex-col items-center">
                    <TimelineDot status={event.status} />
                    {idx < timeline.length - 1 && (
                      <div className="w-px flex-1 bg-border my-1" />
                    )}
                  </div>
                  {/* Content */}
                  <div className="pb-6 min-w-0 flex-1">
                    <div className="flex items-start gap-2 flex-wrap">
                      <TimelineIcon status={event.status} system={event.system} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-medium text-card-foreground">{event.event}</span>
                          <Badge variant="outline" className="text-xs font-normal">
                            {event.system}
                          </Badge>
                        </div>
                        <p className="text-xs text-muted-foreground mt-0.5">{event.detail}</p>
                        <p className="text-xs text-muted-foreground/60 mt-0.5">
                          {new Date(event.timestamp).toLocaleString()}
                        </p>
                      </div>
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
      {/* WhatsApp Notification Status */}
      {order?.id && <WhatsAppNotifPanel orderId={order.id} />}
      {order?.id && <CustomerRepliesPanel orderId={order.id} />}
    </div>
  );
}
