import { useState, useRef } from "react";
import { useRoute } from "wouter";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import {
  Upload,
  FileText,
  CheckCircle2,
  AlertCircle,
  Clock,
  ShieldCheck,
  Image as ImageIcon,
  X,
} from "lucide-react";
import { Sparkles, Eye, AlertTriangle, ChevronDown, ChevronUp } from "lucide-react";
import { trpc } from "@/lib/trpc";

interface ScanResult {
  isReadable: boolean;
  clarityScore: number;
  clarityIssues: string[];
  documentType: string;
  extractedText: string;
  keyFields: Record<string, string>;
  confidence: number;
  summary: string;
}

function AiScanPanel({ result, onDismiss }: { result: ScanResult; onDismiss: () => void }) {
  const [showText, setShowText] = useState(false);
  const scoreColor = result.clarityScore >= 70 ? "text-green-600" : result.clarityScore >= 40 ? "text-amber-600" : "text-red-600";
  const scoreBg = result.clarityScore >= 70 ? "bg-green-50 border-green-200" : result.clarityScore >= 40 ? "bg-amber-50 border-amber-200" : "bg-red-50 border-red-200";
  return (
    <div className={`border rounded-lg p-4 space-y-3 ${scoreBg}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-primary shrink-0" />
          <span className="text-sm font-medium">AI Scan Result</span>
        </div>
        <button type="button" onClick={onDismiss} className="text-muted-foreground hover:text-foreground"><X className="h-4 w-4" /></button>
      </div>
      <div className="flex items-center gap-3">
        <div className={`text-2xl font-bold ${scoreColor}`}>{result.clarityScore}<span className="text-sm font-normal">/100</span></div>
        <div>
          <p className="text-xs font-medium">Image Clarity</p>
          <p className="text-xs text-muted-foreground capitalize">{result.documentType.replace(/_/g, " ")}</p>
        </div>
        {!result.isReadable && (
          <div className="ml-auto flex items-center gap-1 text-red-600 text-xs font-medium">
            <AlertTriangle className="h-3.5 w-3.5" />Low quality
          </div>
        )}
      </div>
      {result.clarityIssues.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {result.clarityIssues.map((issue) => (
            <span key={issue} className="text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded-full capitalize">{issue}</span>
          ))}
        </div>
      )}
      <p className="text-sm text-muted-foreground">{result.summary}</p>
      {Object.entries(result.keyFields).some(([, v]) => v) && (
        <div className="grid grid-cols-2 gap-2 text-xs">
          {Object.entries(result.keyFields).filter(([, v]) => v).map(([k, v]) => (
            <div key={k}>
              <p className="text-muted-foreground capitalize">{k.replace(/([A-Z])/g, " $1").trim()}</p>
              <p className="font-medium truncate">{v}</p>
            </div>
          ))}
        </div>
      )}
      {result.extractedText && (
        <div>
          <button type="button" onClick={() => setShowText((p) => !p)} className="flex items-center gap-1 text-xs text-primary hover:underline">
            <Eye className="h-3 w-3" />
            {showText ? "Hide" : "Show"} extracted text
            {showText ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          </button>
          {showText && (
            <pre className="mt-2 text-xs bg-background border rounded p-2 whitespace-pre-wrap max-h-32 overflow-y-auto">{result.extractedText}</pre>
          )}
        </div>
      )}
      {!result.isReadable && (
        <p className="text-xs text-amber-700 font-medium">⚠ This image may be hard to read. Consider uploading a clearer photo before submitting.</p>
      )}
    </div>
  );
}

// ─── Types ────────────────────────────────────────────────────────────────────
interface PortalData {
  valid: boolean;
  expired?: boolean;
  dispute?: {
    id: string;
    orderId: string | null;
    amount: string;
    currency: string;
    status: string;
    raisedAt: string;
    buyerName: string | null;
  };
  existingSubmissions?: Array<{
    id: string;
    filename: string | null;
    note: string | null;
    submittedAt: string;
    hasFile: boolean;
  }>;
}

// ─── Status badge ─────────────────────────────────────────────────────────────
function DisputeStatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; className: string }> = {
    open: { label: "Open", className: "bg-red-100 text-red-700 border-red-200" },
    under_review: { label: "Under Review", className: "bg-amber-100 text-amber-700 border-amber-200" },
    resolved_merchant: { label: "Resolved (Merchant)", className: "bg-green-100 text-green-700 border-green-200" },
    resolved_buyer: { label: "Resolved (Buyer)", className: "bg-blue-100 text-blue-700 border-blue-200" },
    escalated: { label: "Escalated", className: "bg-purple-100 text-purple-700 border-purple-200" },
  };
  const cfg = map[status] ?? { label: status, className: "" };
  return <Badge variant="outline" className={cfg.className}>{cfg.label}</Badge>;
}

// ─── Main page ────────────────────────────────────────────────────────────────
export default function EvidencePortal() {
  const [, params] = useRoute("/evidence/:token");
  const token = params?.token ?? "";

  const [portalData, setPortalData] = useState<PortalData | null>(null);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [note, setNote] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [scanning, setScanning] = useState(false);
  const scanMutation = trpc.receiptScan.scanImage.useMutation();

  // Load portal data on mount
  const loadPortal = async () => {
    if (loaded || !token) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/evidence/${token}`);
      const data = await res.json();
      setPortalData(data);
    } catch {
      setPortalData({ valid: false });
    } finally {
      setLoading(false);
      setLoaded(true);
    }
  };

  // Auto-load on first render
  if (!loaded && !loading && token) {
    loadPortal();
  }

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const allowedTypes = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
    if (!allowedTypes.includes(file.type)) {
      toast.error("Only JPG, PNG, WebP, and PDF files are accepted");
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      toast.error("File must be under 10 MB");
      return;
    }
    setSelectedFile(file);
    setScanResult(null);
    if (file.type.startsWith("image/")) {
      setScanning(true);
      const reader = new FileReader();
      reader.onload = async (ev) => {
        const dataUrl = ev.target?.result as string;
        const base64 = dataUrl.split(",")[1];
        try {
          const result = await scanMutation.mutateAsync({
            imageBase64: base64,
            mimeType: file.type as "image/jpeg" | "image/png" | "image/webp",
          });
          setScanResult(result as ScanResult);
        } catch { /* scan failed silently */ }
        finally { setScanning(false); }
      };
      reader.readAsDataURL(file);
    }
  };

  const handleSubmit = async () => {
    if (!note.trim() && !selectedFile) {
      toast.error("Please add a note or upload a file as evidence");
      return;
    }
    setSubmitting(true);
    try {
      if (selectedFile) {
        // Upload file as raw binary
        const arrayBuffer = await selectedFile.arrayBuffer();
        const res = await fetch(`/api/evidence/${token}/submit`, {
          method: "POST",
          headers: {
            "Content-Type": selectedFile.type,
            "X-Filename": selectedFile.name,
            "X-Note": note,
          },
          body: arrayBuffer,
        });
        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error ?? "Upload failed");
        }
      } else {
        // Text-only submission
        const res = await fetch(`/api/evidence/${token}/submit-json`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ note }),
        });
        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error ?? "Submission failed");
        }
      }
      setSubmitted(true);
      toast.success("Evidence submitted successfully");
    } catch (err: any) {
      toast.error(err.message ?? "Submission failed. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  // ── Loading state ────────────────────────────────────────────────────────────
  if (loading || !loaded) {
    return (
      <div className="min-h-screen bg-muted/30 flex items-center justify-center">
        <div className="text-center space-y-3">
          <div className="h-8 w-8 border-2 border-primary border-t-transparent rounded-full animate-spin mx-auto" />
          <p className="text-sm text-muted-foreground">Loading dispute portal…</p>
        </div>
      </div>
    );
  }

  // ── Invalid / expired ────────────────────────────────────────────────────────
  if (!portalData?.valid) {
    return (
      <div className="min-h-screen bg-muted/30 flex items-center justify-center px-4">
        <div className="max-w-md w-full bg-background border rounded-xl p-8 text-center shadow-sm">
          <AlertCircle className="h-12 w-12 text-destructive mx-auto mb-4" />
          <h1 className="text-xl font-semibold mb-2">
            {portalData?.expired ? "This link has expired" : "Invalid link"}
          </h1>
          <p className="text-muted-foreground text-sm">
            {portalData?.expired
              ? "This evidence submission link has expired. Please contact the merchant for a new link."
              : "This link is invalid or has already been used. Please contact the merchant for assistance."}
          </p>
        </div>
      </div>
    );
  }

  // ── Submitted confirmation ────────────────────────────────────────────────────
  if (submitted) {
    return (
      <div className="min-h-screen bg-muted/30 flex items-center justify-center px-4">
        <div className="max-w-md w-full bg-background border rounded-xl p-8 text-center shadow-sm">
          <CheckCircle2 className="h-12 w-12 text-green-500 mx-auto mb-4" />
          <h1 className="text-xl font-semibold mb-2">Evidence submitted</h1>
          <p className="text-muted-foreground text-sm">
            Your evidence has been received and will be reviewed by the dispute resolution team. You will be contacted if further information is needed.
          </p>
          <div className="mt-6 bg-muted/50 rounded-lg p-4 text-sm text-left space-y-1">
            <p className="font-medium">What happens next?</p>
            <ul className="text-muted-foreground space-y-1 list-disc list-inside">
              <li>The merchant and platform team will review your evidence</li>
              <li>A decision will be made within 3–5 business days</li>
              <li>You will be notified of the outcome</li>
            </ul>
          </div>
        </div>
      </div>
    );
  }

  const dispute = portalData.dispute!;

  return (
    <div className="min-h-screen bg-muted/30 py-8 px-4">
      <div className="max-w-lg mx-auto space-y-6">
        {/* Header */}
        <div className="text-center">
          <div className="flex items-center justify-center gap-2 mb-2">
            <ShieldCheck className="h-6 w-6 text-primary" />
            <span className="font-semibold text-lg">Dispute Evidence Portal</span>
          </div>
          <p className="text-sm text-muted-foreground">
            Submit your evidence for this order dispute. Your submission is secure and will be reviewed by the platform team.
          </p>
        </div>

        {/* Dispute info card */}
        <div className="bg-background border rounded-xl p-5 shadow-sm space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">Dispute Details</h2>
            <DisputeStatusBadge status={dispute.status} />
          </div>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <p className="text-muted-foreground text-xs">Order ID</p>
              <p className="font-medium">{dispute.orderId ?? "—"}</p>
            </div>
            <div>
              <p className="text-muted-foreground text-xs">Amount in Dispute</p>
              <p className="font-medium">{dispute.currency} {Number(dispute.amount).toLocaleString()}</p>
            </div>
            <div>
              <p className="text-muted-foreground text-xs">Raised On</p>
              <p className="font-medium">{new Date(dispute.raisedAt).toLocaleDateString()}</p>
            </div>
            {dispute.buyerName && (
              <div>
                <p className="text-muted-foreground text-xs">Submitted By</p>
                <p className="font-medium">{dispute.buyerName}</p>
              </div>
            )}
          </div>
        </div>

        {/* Existing submissions */}
        {portalData.existingSubmissions && portalData.existingSubmissions.length > 0 && (
          <div className="bg-background border rounded-xl p-5 shadow-sm">
            <h3 className="font-medium mb-3 text-sm">Previously Submitted Evidence</h3>
            <div className="space-y-2">
              {portalData.existingSubmissions.map((sub) => (
                <div key={sub.id} className="flex items-center gap-3 text-sm p-2 bg-muted/50 rounded-lg">
                  {sub.hasFile ? <FileText className="h-4 w-4 text-blue-500 shrink-0" /> : <Clock className="h-4 w-4 text-muted-foreground shrink-0" />}
                  <div className="flex-1 min-w-0">
                    <p className="font-medium truncate">{sub.filename ?? "Note only"}</p>
                    {sub.note && <p className="text-muted-foreground text-xs truncate">{sub.note}</p>}
                  </div>
                  <span className="text-xs text-muted-foreground shrink-0">{new Date(sub.submittedAt).toLocaleDateString()}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Submission form */}
        <div className="bg-background border rounded-xl p-5 shadow-sm space-y-4">
          <h3 className="font-semibold">Submit Your Evidence</h3>

          {/* File upload */}
          <div>
            <label className="text-sm font-medium mb-2 block">Upload Document or Photo (optional)</label>
            <div
              className="border-2 border-dashed rounded-lg p-6 text-center cursor-pointer hover:border-primary/50 transition-colors"
              onClick={() => fileInputRef.current?.click()}
            >
              {selectedFile ? (
                <div className="flex items-center justify-center gap-3">
                  {selectedFile.type.startsWith("image/") ? (
                    <ImageIcon className="h-5 w-5 text-blue-500" />
                  ) : (
                    <FileText className="h-5 w-5 text-blue-500" />
                  )}
                  <span className="text-sm font-medium">{selectedFile.name}</span>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); setSelectedFile(null); }}
                    className="text-muted-foreground hover:text-destructive"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              ) : (
                <div className="space-y-1">
                  <Upload className="h-8 w-8 text-muted-foreground mx-auto" />
                  <p className="text-sm text-muted-foreground">Click to upload a photo or PDF</p>
                  <p className="text-xs text-muted-foreground">JPG, PNG, WebP, PDF — max 10 MB</p>
                </div>
              )}
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,application/pdf"
              onChange={handleFileChange}
              className="hidden"
            />
            {scanning && (
              <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                <div className="h-3 w-3 border border-primary border-t-transparent rounded-full animate-spin" />
                <Sparkles className="h-3 w-3 text-primary" />
                Scanning image with AI…
              </div>
            )}
            {scanResult && !scanning && (
              <div className="mt-3"><AiScanPanel result={scanResult} onDismiss={() => setScanResult(null)} /></div>
            )}
            {/* Retry scan button */}
            {scanResult && !scanning && selectedFile && selectedFile.type.startsWith("image/") && (
              <button
                type="button"
                className="mt-2 text-xs text-primary underline underline-offset-2 hover:text-primary/80 flex items-center gap-1"
                onClick={async () => {
                  setScanResult(null);
                  setScanning(true);
                  const reader = new FileReader();
                  reader.onload = async (ev) => {
                    const dataUrl = ev.target?.result as string;
                    const base64 = dataUrl.split(",")[1];
                    try {
                      const result = await scanMutation.mutateAsync({
                        imageBase64: base64,
                        mimeType: selectedFile.type as "image/jpeg" | "image/png" | "image/webp",
                      });
                      setScanResult(result as ScanResult);
                    } catch { toast.error("Retry scan failed"); }
                    finally { setScanning(false); }
                  };
                  reader.readAsDataURL(selectedFile);
                }}
              >
                <Sparkles className="h-3 w-3" />
                Retry AI Scan
              </button>
            )}
          </div>

          {/* Note */}
          <div>
            <label className="text-sm font-medium mb-2 block">Written Statement (optional)</label>
            <Textarea
              placeholder="Describe what happened, provide order details, or explain why you are disputing this transaction..."
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={4}
              maxLength={2000}
            />
            <p className="text-xs text-muted-foreground mt-1 text-right">{note.length}/2000</p>
          </div>

          <Button
            onClick={handleSubmit}
            disabled={submitting || (!note.trim() && !selectedFile)}
            className="w-full"
          >
            {submitting ? (
              <><div className="h-4 w-4 border-2 border-white border-t-transparent rounded-full animate-spin mr-2" />Submitting…</>
            ) : (
              <><Upload className="h-4 w-4 mr-2" />Submit Evidence</>
            )}
          </Button>
        </div>

        {/* Trust footer */}
        <div className="text-center text-xs text-muted-foreground space-y-1 pb-4">
          <div className="flex items-center justify-center gap-1">
            <ShieldCheck className="h-3.5 w-3.5" />
            <span>Secured by WhatsApp Commerce Platform</span>
          </div>
          <p>Your submission is encrypted and stored securely. It will only be used for dispute resolution.</p>
        </div>
      </div>
    </div>
  );
}
