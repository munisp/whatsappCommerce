import { trpc } from "@/lib/trpc";
import {
  CircleDollarSign, Lock, PackageCheck, Send, CheckCircle, RotateCcw,
  Truck, Package, Navigation, AlertTriangle, CheckCircle2, Info, Loader2,
  Paperclip, FileText, StickyNote, ChevronDown, ChevronUp, Plus, Upload, X
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { useState, useRef } from "react";
import { useAuth } from "@/_core/hooks/useAuth";

type TimelineVariant = "default" | "success" | "warning" | "error" | "info";
type TimelineEventType = "escrow_state" | "logistics" | "dispute";

interface TimelineEvent {
  id: string;
  timestamp: Date;
  type: TimelineEventType;
  state?: string;
  title: string;
  description: string;
  icon: string;
  variant: TimelineVariant;
}

const ICON_MAP: Record<string, React.ElementType> = {
  "circle-dollar-sign": CircleDollarSign,
  "lock": Lock,
  "package-check": PackageCheck,
  "send": Send,
  "check-circle": CheckCircle,
  "rotate-ccw": RotateCcw,
  "truck": Truck,
  "package": Package,
  "navigation": Navigation,
  "alert-triangle": AlertTriangle,
  "check-circle-2": CheckCircle2,
};

const VARIANT_STYLES: Record<TimelineVariant, { dot: string; icon: string; badge: string }> = {
  default: { dot: "bg-muted-foreground/40 border-muted-foreground/20", icon: "text-muted-foreground", badge: "bg-muted text-muted-foreground" },
  info: { dot: "bg-blue-500/20 border-blue-500/40", icon: "text-blue-400", badge: "bg-blue-500/10 text-blue-400" },
  success: { dot: "bg-emerald-500/20 border-emerald-500/40", icon: "text-emerald-400", badge: "bg-emerald-500/10 text-emerald-400" },
  warning: { dot: "bg-orange-500/20 border-orange-500/40", icon: "text-orange-400", badge: "bg-orange-500/10 text-orange-400" },
  error: { dot: "bg-red-500/20 border-red-500/40", icon: "text-red-400", badge: "bg-red-500/10 text-red-400" },
};

const TYPE_LABELS: Record<TimelineEventType, string> = {
  escrow_state: "Escrow",
  logistics: "Logistics",
  dispute: "Dispute",
};

function formatDateTime(date: Date): string {
  return new Date(date).toLocaleString(undefined, {
    month: "short", day: "numeric", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

// ─── Per-event attachment panel ───────────────────────────────────────────────
function AttachmentPanel({ escrowId, eventId, uploadedBy }: { escrowId: string; eventId: string; uploadedBy: string }) {
  const [open, setOpen] = useState(false);
  const [noteText, setNoteText] = useState("");
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const utils = trpc.useUtils();

  const { data: attachments, isLoading } = trpc.timelineAttachment.list.useQuery(
    { escrowId, eventId },
    { enabled: open }
  );

  const addAttachment = trpc.timelineAttachment.add.useMutation({
    onSuccess: () => {
      utils.timelineAttachment.list.invalidate({ escrowId, eventId });
      setNoteText("");
      toast.success("Attachment added.");
    },
    onError: (e) => toast.error(e.message),
  });

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) { toast.error("File must be under 10 MB"); return; }
    setUploading(true);
    try {
      const buffer = await file.arrayBuffer();
      const base64 = btoa(String.fromCharCode(...Array.from(new Uint8Array(buffer))));
      await addAttachment.mutateAsync({
        escrowId, eventId, attachmentType: "document",
        fileBase64: base64, filename: file.name, mimeType: file.type,
        uploadedBy,
      });
    } catch (e: any) {
      toast.error(e.message ?? "Upload failed");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function handleAddNote() {
    if (!noteText.trim()) return;
    await addAttachment.mutateAsync({
      escrowId, eventId, attachmentType: "note",
      note: noteText.trim(), uploadedBy,
    });
  }

  const count = attachments?.length ?? 0;

  return (
    <div className="mt-2">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        <Paperclip className="h-3 w-3" />
        {count > 0 ? `${count} attachment${count !== 1 ? "s" : ""}` : "Add attachment"}
        {open ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
      </button>

      {open && (
        <div className="mt-2 ml-0 border rounded-lg p-3 bg-muted/30 space-y-3">
          {/* Existing attachments */}
          {isLoading ? (
            <p className="text-xs text-muted-foreground">Loading…</p>
          ) : (attachments ?? []).length > 0 ? (
            <div className="space-y-1.5">
              {(attachments ?? []).map((att) => (
                <div key={att.id} className="flex items-start gap-2 text-xs">
                  {att.attachmentType === "document" ? (
                    <FileText className="h-3.5 w-3.5 text-blue-400 shrink-0 mt-0.5" />
                  ) : (
                    <StickyNote className="h-3.5 w-3.5 text-yellow-500 shrink-0 mt-0.5" />
                  )}
                  <div className="flex-1 min-w-0">
                    {att.attachmentType === "document" && att.fileUrl ? (
                      <a href={att.fileUrl} target="_blank" rel="noopener noreferrer"
                        className="text-blue-400 hover:underline truncate block">
                        {att.filename ?? "Document"}
                      </a>
                    ) : (
                      <p className="text-foreground/80 whitespace-pre-wrap">{att.note}</p>
                    )}
                    <p className="text-muted-foreground/50 mt-0.5">
                      {att.uploadedBy} · {formatDateTime(att.createdAt)}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">No attachments yet.</p>
          )}

          {/* Add note */}
          <div className="space-y-1.5">
            <Textarea
              value={noteText}
              onChange={(e) => setNoteText(e.target.value)}
              placeholder="Add a note (e.g. delivery confirmed by customer call)…"
              className="text-xs min-h-[60px] resize-none"
            />
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" className="text-xs h-7"
                onClick={handleAddNote}
                disabled={!noteText.trim() || addAttachment.isPending}>
                <Plus className="h-3 w-3 mr-1" />
                Add Note
              </Button>
              <Button size="sm" variant="outline" className="text-xs h-7"
                onClick={() => fileRef.current?.click()}
                disabled={uploading}>
                <Upload className="h-3 w-3 mr-1" />
                {uploading ? "Uploading…" : "Upload Document"}
              </Button>
              <input ref={fileRef} type="file" className="hidden"
                accept=".pdf,.jpg,.jpeg,.png,.doc,.docx"
                onChange={handleFileUpload} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────
interface EscrowTimelineProps {
  escrowId: string;
  className?: string;
}

export default function EscrowTimeline({ escrowId, className }: EscrowTimelineProps) {
  const { user } = useAuth();
  const { data: events, isLoading, error } = trpc.escrow.getTimeline.useQuery({ escrowId });

  if (isLoading) {
    return (
      <div className={cn("flex items-center justify-center py-10", className)}>
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error || !events) {
    return (
      <div className={cn("text-sm text-muted-foreground py-6 text-center", className)}>
        Could not load timeline.
      </div>
    );
  }

  if (events.length === 0) {
    return (
      <div className={cn("text-sm text-muted-foreground py-6 text-center", className)}>
        No timeline events yet.
      </div>
    );
  }

  const uploadedBy = user?.name ?? user?.openId ?? "merchant";

  return (
    <div className={cn("relative", className)}>
      {/* Vertical line */}
      <div className="absolute left-5 top-6 bottom-6 w-px bg-border" />

      <ol className="space-y-0">
        {events.map((event) => {
          const Icon = ICON_MAP[event.icon] ?? Info;
          const styles = VARIANT_STYLES[event.variant];

          return (
            <li key={event.id} className="relative flex gap-4 pb-6 last:pb-0">
              {/* Dot + icon */}
              <div className={cn(
                "relative z-10 flex h-10 w-10 shrink-0 items-center justify-center rounded-full border-2",
                styles.dot
              )}>
                <Icon className={cn("h-4 w-4", styles.icon)} />
              </div>

              {/* Content */}
              <div className="flex-1 min-w-0 pt-1.5">
                <div className="flex flex-wrap items-center gap-2 mb-1">
                  <span className="text-sm font-medium text-foreground">{event.title}</span>
                  <span className={cn("text-[10px] font-medium px-1.5 py-0.5 rounded-full", styles.badge)}>
                    {TYPE_LABELS[event.type]}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground leading-relaxed">{event.description}</p>
                <p className="text-[11px] text-muted-foreground/50 mt-1.5">
                  {formatDateTime(event.timestamp)}
                </p>
                {/* Attachment panel per event */}
                <AttachmentPanel
                  escrowId={escrowId}
                  eventId={event.id}
                  uploadedBy={uploadedBy}
                />
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
