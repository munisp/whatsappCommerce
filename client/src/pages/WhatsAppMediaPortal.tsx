import { useState, useRef } from "react";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { Upload, FileText, Image, Download, Search, RefreshCw, Eye, FileCheck } from "lucide-react";

const DOC_TYPE_LABELS: Record<string, string> = {
  purchase_order: "Purchase Order",
  invoice: "Invoice",
  receipt: "Receipt",
  delivery_note: "Delivery Note",
  contract: "Contract",
  image: "Image",
  spreadsheet: "Spreadsheet",
  other: "Other",
};

const DOC_TYPE_COLORS: Record<string, string> = {
  purchase_order: "bg-blue-100 text-blue-800",
  invoice: "bg-green-100 text-green-800",
  receipt: "bg-purple-100 text-purple-800",
  delivery_note: "bg-orange-100 text-orange-800",
  contract: "bg-red-100 text-red-800",
  image: "bg-pink-100 text-pink-800",
  spreadsheet: "bg-teal-100 text-teal-800",
  other: "bg-gray-100 text-gray-700",
};

function formatBytes(bytes: number | null | undefined): string {
  if (!bytes) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

export default function WhatsAppMediaPortal() {
  const { user } = useAuth();
  const [tenantId, setTenantId] = useState("");
  const [filterType, setFilterType] = useState("all");
  const [searchPhone, setSearchPhone] = useState("");
  const [uploading, setUploading] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data: tenants } = trpc.tenant.list.useQuery(undefined, { enabled: !!user });

  const { data: mediaFiles, refetch, isLoading } = trpc.whatsappMedia.list.useQuery(
    { tenantId, documentType: filterType === "all" ? undefined : filterType, limit: 100 },
    { enabled: !!tenantId }
  );

  const uploadMutation = trpc.whatsappMedia.upload.useMutation({
    onSuccess: (file) => {
      toast.success(`Uploaded: ${file.fileName} (detected as ${DOC_TYPE_LABELS[file.documentType] ?? file.documentType})`);
      refetch();
    },
    onError: (e) => toast.error(`Upload failed: ${e.message}`),
  });

  const downloadUrlQuery = trpc.whatsappMedia.getDownloadUrl.useQuery(
    { fileId: expandedId!, tenantId },
    { enabled: !!expandedId && !!tenantId }
  );

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !tenantId) { toast.error("Select a tenant first"); return; }
    if (file.size > 10 * 1024 * 1024) { toast.error("File too large (max 10 MB)"); return; }
    setUploading(true);
    try {
      const arrayBuf = await file.arrayBuffer();
      const uint8 = new Uint8Array(arrayBuf);
      let binary = "";
      for (let i = 0; i < uint8.length; i++) binary += String.fromCharCode(uint8[i]);
      const base64 = btoa(binary);
      await uploadMutation.mutateAsync({
        tenantId,
        fileName: file.name,
        mimeType: file.type || "application/octet-stream",
        fileBase64: base64,
        fileSize: file.size,
        waPhoneNumber: searchPhone || undefined,
      });
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  const filtered = mediaFiles?.filter(f =>
    !searchPhone || f.waPhoneNumber?.includes(searchPhone)
  ) ?? [];

  return (
    <div className="p-6 space-y-6 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">WhatsApp Media Portal</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Upload and manage purchase orders, invoices, receipts, and other documents shared via WhatsApp.
            AI automatically detects document type and extracts key fields.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => refetch()} disabled={!tenantId}>
            <RefreshCw className="h-4 w-4 mr-1" /> Refresh
          </Button>
          <Button
            size="sm"
            onClick={() => fileInputRef.current?.click()}
            disabled={!tenantId || uploading}
          >
            <Upload className="h-4 w-4 mr-1" />
            {uploading ? "Uploading…" : "Upload Document"}
          </Button>
          <input ref={fileInputRef} type="file" className="hidden"
            accept=".pdf,.jpg,.jpeg,.png,.webp,.xlsx,.xls,.csv,.docx,.doc"
            onChange={handleFileUpload}
          />
        </div>
      </div>

      {/* Filters */}
      <div className="flex gap-3 flex-wrap">
        <Select value={tenantId} onValueChange={setTenantId}>
          <SelectTrigger className="w-52">
            <SelectValue placeholder="Select tenant…" />
          </SelectTrigger>
          <SelectContent>
            {tenants?.map(t => (
              <SelectItem key={t.id} value={t.id}>{(t as any).businessName ?? t.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={filterType} onValueChange={setFilterType}>
          <SelectTrigger className="w-44">
            <SelectValue placeholder="Document type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All types</SelectItem>
            {Object.entries(DOC_TYPE_LABELS).map(([k, v]) => (
              <SelectItem key={k} value={k}>{v}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            className="pl-8 w-48"
            placeholder="Filter by phone…"
            value={searchPhone}
            onChange={e => setSearchPhone(e.target.value)}
          />
        </div>
      </div>

      {/* Low-connectivity notice */}
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 flex gap-2 items-start">
        <span className="text-base">📶</span>
        <div>
          <strong>Low-connectivity design:</strong> Documents are stored in S3 and accessible via short-lived download links.
          Buyers on 2G/EDGE can send documents via WhatsApp; the platform queues and processes them asynchronously.
          AI scan results are cached so re-downloads don't re-run the LLM.
        </div>
      </div>

      {/* File list */}
      {!tenantId ? (
        <div className="text-center py-16 text-muted-foreground">Select a tenant to view media files</div>
      ) : isLoading ? (
        <div className="text-center py-16 text-muted-foreground">Loading…</div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground">
          No documents found. Upload a purchase order, invoice, or receipt to get started.
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map(file => (
            <Card key={file.id} className="overflow-hidden">
              <CardContent className="p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-start gap-3 min-w-0">
                    <div className="mt-0.5 text-muted-foreground shrink-0">
                      {file.mimeType.startsWith("image/") ? <Image className="h-5 w-5" /> : <FileText className="h-5 w-5" />}
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium truncate">{file.fileName}</span>
                        <Badge className={`text-xs ${DOC_TYPE_COLORS[file.documentType] ?? DOC_TYPE_COLORS.other}`}>
                          {DOC_TYPE_LABELS[String(file.documentType)] ?? String(file.documentType)}
                        </Badge>
                        {Boolean(file.aiScanResult) && <Badge variant="outline" className="text-xs text-green-700 border-green-300"><FileCheck className="h-3 w-3 mr-1 inline" />AI Scanned</Badge>}
                      </div>
                      <div className="text-xs text-muted-foreground mt-1 flex gap-3 flex-wrap">
                        <span>{formatBytes(file.fileSize)}</span>
                        {file.waPhoneNumber && <span>📱 {file.waPhoneNumber}</span>}
                        {file.conversationId && <span>💬 {file.conversationId.slice(0, 8)}…</span>}
                        <span>{new Date(file.uploadedAt).toLocaleString()}</span>
                      </div>
                    </div>
                  </div>
                  <div className="flex gap-1 shrink-0">
                    <Button variant="ghost" size="sm" onClick={() => setExpandedId(expandedId === file.id ? null : file.id)}>
                      <Eye className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost" size="sm"
                      onClick={() => {
                        if (downloadUrlQuery.data?.url) {
                          window.open(downloadUrlQuery.data.url, "_blank");
                        } else {
                          setExpandedId(file.id);
                          toast.info("Generating download link…");
                        }
                      }}
                    >
                      <Download className="h-4 w-4" />
                    </Button>
                  </div>
                </div>

                {/* Expanded AI scan result */}
                {expandedId === file.id && Boolean(file.aiScanResult) && (
                  <div className="mt-3 pt-3 border-t">
                   <p className="text-xs font-semibold text-muted-foreground mb-2 uppercase tracking-wide">AI Extracted Fields</p>
                   <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                      {Object.entries(file.aiScanResult as Record<string, string | number | null>)
                       .filter(([k]) => k !== "items")
                       .map(([k, v]) => (
                         <div key={k} className="text-xs">
                           <span className="text-muted-foreground capitalize">{k.replace(/_/g, " ")}: </span>
                           <span className="font-medium">{v != null ? String(v) : "—"}</span>
                          </div>
                        ))}
                    </div>
                    {(file.aiScanResult as any).items?.length > 0 && (
                      <div className="mt-2">
                        <p className="text-xs font-semibold text-muted-foreground mb-1">Line Items</p>
                        <table className="text-xs w-full">
                          <thead><tr className="text-muted-foreground"><th className="text-left">Description</th><th className="text-right">Qty</th><th className="text-right">Unit Price</th></tr></thead>
                          <tbody>
                            {((file.aiScanResult as any).items as any[]).map((item: any, i: number) => (
                              <tr key={i}><td>{String(item.description ?? "")}</td><td className="text-right">{String(item.qty ?? "")}</td><td className="text-right">{String(item.unitPrice ?? "")}</td></tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                    {downloadUrlQuery.data?.url && expandedId === file.id && (
                      <div className="mt-2">
                        <Button size="sm" variant="outline" onClick={() => window.open(downloadUrlQuery.data!.url, "_blank")}>
                          <Download className="h-3 w-3 mr-1" /> Download File
                        </Button>
                      </div>
                    )}
                  </div>
                )}
                {expandedId === file.id && !file.aiScanResult && (
                  <div className="mt-3 pt-3 border-t text-xs text-muted-foreground">
                    No AI scan data available for this file.
                    {file.mimeType.startsWith("image/") && " (Only image files are auto-scanned.)"}
                    {downloadUrlQuery.data?.url && (
                      <div className="mt-2">
                        <Button size="sm" variant="outline" onClick={() => window.open(downloadUrlQuery.data!.url, "_blank")}>
                          <Download className="h-3 w-3 mr-1" /> Download File
                        </Button>
                      </div>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
