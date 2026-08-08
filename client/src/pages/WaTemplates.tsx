/**
 * WaTemplates — WhatsApp ops page (route /wa-templates).
 *
 * Tab "Templates": Meta message-template library backed by the waTemplates
 * router — cached list (name/category/language/status/syncedAt), force
 * status-sync, and a create dialog that submits UTILITY/MARKETING templates
 * to Meta for approval. Requires a WhatsApp Business Account ID on the tenant
 * (tenant.getWhatsAppConfig) — without it we render a setup hint instead.
 *
 * Tab "Message Log": delivery-status view over whatsappNotifications
 * .getNotificationHistory with ✓/✓✓/⚠/✖ status glyphs from the
 * whatsapp_notification_log status + statusTimestamps columns.
 */
import { useMemo, useState } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { trpc } from "@/lib/trpc";
import { useActiveTenant } from "@/contexts/TenantContext";
import {
  extractTemplateParams, notifStatusGlyph, previewTemplateBody, receiptTimestamp, waTemplateStatusBadge,
} from "@/lib/waOps";
import { toast } from "sonner";
import { Link } from "wouter";
import {
  AlertTriangle, CheckCheck, ChevronLeft, ChevronRight, FileCode, History, Loader2, MessageSquare,
  Plus, RefreshCw, Settings2,
} from "lucide-react";

const LOG_PAGE_SIZE = 15;

// ─── Templates tab ───────────────────────────────────────────────────────────

function TemplatesTab({ tenantId }: { tenantId: string }) {
  const utils = trpc.useUtils();
  const { data: waConfig, isLoading: waConfigLoading } = trpc.tenant.getWhatsAppConfig.useQuery({ tenantId });
  const { data, isLoading } = trpc.waTemplates.list.useQuery({ tenantId });
  const [createOpen, setCreateOpen] = useState(false);

  const statusSync = trpc.waTemplates.statusSync.useMutation({
    onSuccess: (r) => {
      toast.success(`Synced ${r.count} template${r.count === 1 ? "" : "s"} from Meta`);
      utils.waTemplates.list.invalidate({ tenantId });
    },
    onError: (e) => toast.error(e.message),
  });

  const wabaMissing = !waConfigLoading && waConfig && !waConfig.wabaId;

  if (waConfigLoading || isLoading) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground py-12 justify-center">
        <Loader2 className="w-5 h-5 animate-spin" /> Loading templates…
      </div>
    );
  }

  if (wabaMissing) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-4 py-14 text-center">
          <div className="h-14 w-14 rounded-full bg-muted flex items-center justify-center">
            <AlertTriangle className="h-7 w-7 text-amber-400" />
          </div>
          <div>
            <p className="font-medium">WhatsApp Business Account not configured</p>
            <p className="text-sm text-muted-foreground mt-1 max-w-md">
              Message templates are managed through the tenant's Meta WhatsApp Business Account
              (WABA). Add a WABA ID and access token before creating or syncing templates.
            </p>
          </div>
          <Link href="/setup">
            <Button variant="outline" className="gap-2">
              <Settings2 className="w-4 h-4" /> Open WhatsApp setup
            </Button>
          </Link>
        </CardContent>
      </Card>
    );
  }

  const templates = data?.templates ?? [];

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3">
        <div>
          <CardTitle className="text-base flex items-center gap-2">
            <FileCode className="w-4 h-4" /> Meta message templates
          </CardTitle>
          <CardDescription>
            {data?.syncedAt
              ? `Last synced ${new Date(data.syncedAt).toLocaleString()}`
              : "Never synced from Meta yet"}
            {data?.syncError && (
              <span className="block text-red-400 mt-1">Sync error: {data.syncError}</span>
            )}
          </CardDescription>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            disabled={statusSync.isPending}
            onClick={() => statusSync.mutate({ tenantId })}
          >
            {statusSync.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            Sync status
          </Button>
          <Button size="sm" className="gap-1.5" onClick={() => setCreateOpen(true)}>
            <Plus className="w-3.5 h-3.5" /> New template
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {templates.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-12 text-center">
            <div className="h-12 w-12 rounded-full bg-muted flex items-center justify-center">
              <FileCode className="h-6 w-6 text-muted-foreground" />
            </div>
            <div>
              <p className="text-sm font-medium">No templates cached yet</p>
              <p className="text-xs text-muted-foreground mt-1">
                Click “Sync status” to pull your existing Meta templates, or create a new one.
              </p>
            </div>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Language</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Synced at</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {templates.map((t) => {
                const badge = waTemplateStatusBadge(t.status);
                return (
                  <TableRow key={`${t.name}:${t.language}`}>
                    <TableCell className="font-mono text-sm">{t.name}</TableCell>
                    <TableCell>{t.category || "—"}</TableCell>
                    <TableCell>{t.language || "—"}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className={badge.className}>{badge.label}</Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {data?.syncedAt ? new Date(data.syncedAt).toLocaleString() : "—"}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
      <CreateTemplateDialog
        tenantId={tenantId}
        open={createOpen}
        onClose={() => setCreateOpen(false)}
      />
    </Card>
  );
}

function CreateTemplateDialog({ tenantId, open, onClose }: { tenantId: string; open: boolean; onClose: () => void }) {
  const utils = trpc.useUtils();
  const [name, setName] = useState("");
  const [category, setCategory] = useState<"UTILITY" | "MARKETING">("UTILITY");
  const [language, setLanguage] = useState("en_US");
  const [body, setBody] = useState("");

  const params = useMemo(() => extractTemplateParams(body), [body]);

  const create = trpc.waTemplates.create.useMutation({
    onSuccess: (r) => {
      toast.success(`Template submitted to Meta (status: ${r.status})`);
      utils.waTemplates.list.invalidate({ tenantId });
      setName(""); setCategory("UTILITY"); setLanguage("en_US"); setBody("");
      onClose();
    },
    onError: (e) => toast.error(e.message),
  });

  const nameValid = /^[a-z0-9_]+$/.test(name.trim());
  const canSubmit = nameValid && body.trim().length > 0 && !create.isPending;

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Create WhatsApp template</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5 col-span-2">
              <Label>Name</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value.toLowerCase())}
                placeholder="order_confirmation_v2"
              />
              {name && !nameValid && (
                <p className="text-xs text-red-400">Lowercase letters, digits and underscores only.</p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label>Category</Label>
              <Select value={category} onValueChange={(v) => setCategory(v as typeof category)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="UTILITY">Utility</SelectItem>
                  <SelectItem value="MARKETING">Marketing</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Language</Label>
              <Input value={language} onChange={(e) => setLanguage(e.target.value)} placeholder="en_US" />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Body</Label>
            <Textarea
              rows={5}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder={"Hi {{1}}, your order {{2}} has been confirmed."}
            />
            <p className="text-xs text-muted-foreground">
              Use numbered placeholders like <code className="font-mono">{"{{1}}"}</code>,{" "}
              <code className="font-mono">{"{{2}}"}</code> for dynamic values.
              {params.length > 0 && (
                <span className="ml-1">
                  Detected: {params.map((n) => `{{${n}}}`).join(", ")}
                </span>
              )}
            </p>
          </div>
          {body.trim() && (
            <div className="space-y-1.5">
              <Label className="text-muted-foreground">Preview</Label>
              <div className="rounded-lg border bg-muted/40 p-3 text-sm whitespace-pre-wrap">
                {previewTemplateBody(body)}
              </div>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => create.mutate({ tenantId, name: name.trim(), category, language, body: body.trim() })} disabled={!canSubmit}>
            {create.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Submit for approval"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Message Log tab ─────────────────────────────────────────────────────────

function StatusGlyph({ log }: { log: {
  status: string;
  statusTimestamps?: unknown;
  errorText?: string | null;
  failReason?: string | null;
  attempts?: number | null;
} }) {
  const glyph = notifStatusGlyph(log.status);
  const deliveredAt = receiptTimestamp(log.statusTimestamps, "delivered");
  const readAt = receiptTimestamp(log.statusTimestamps, "read");
  const error = log.errorText || log.failReason;

  const tooltipLines: string[] = [];
  if (deliveredAt) tooltipLines.push(`Delivered ${new Date(deliveredAt).toLocaleString()}`);
  if (readAt) tooltipLines.push(`Read ${new Date(readAt).toLocaleString()}`);
  if (log.status === "failed" && error) tooltipLines.push(error);
  if (log.status === "dead") tooltipLines.push(`Retries exhausted after ${log.attempts ?? 0} attempt${(log.attempts ?? 0) === 1 ? "" : "s"}`);

  const content = (
    <span className={`inline-flex items-center gap-1 font-mono text-sm ${glyph.className}`}>
      {log.status === "delivered" || log.status === "read" ? (
        <CheckCheck className={`w-4 h-4 ${log.status === "read" ? "text-sky-500" : "text-muted-foreground"}`} />
      ) : (
        <span>{glyph.glyph}</span>
      )}
      <span className="text-xs font-sans">{glyph.label}</span>
    </span>
  );

  if (tooltipLines.length === 0) return content;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{content}</TooltipTrigger>
      <TooltipContent className="max-w-xs">
        {tooltipLines.map((l, i) => (
          <p key={i} className="text-xs whitespace-pre-wrap break-words">{l}</p>
        ))}
      </TooltipContent>
    </Tooltip>
  );
}

function MessageLogTab() {
  const [page, setPage] = useState(0);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [search, setSearch] = useState("");

  const { data, isLoading } = trpc.whatsappNotifications.getNotificationHistory.useQuery({
    limit: LOG_PAGE_SIZE,
    offset: page * LOG_PAGE_SIZE,
    search: search || undefined,
    status: statusFilter === "all" ? undefined : statusFilter,
  });
  const logs = data?.logs ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <History className="w-4 h-4" /> Message delivery log
        </CardTitle>
        <CardDescription>
          Delivery receipts for WhatsApp notifications — ✓ sent, ✓✓ delivered, ✓✓ read, ⚠ failed, ✖ dead.
        </CardDescription>
        <div className="flex flex-wrap gap-2 pt-1">
          <Input
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(0); }}
            placeholder="Search type, phone or WAMID…"
            className="h-8 w-64 text-xs"
          />
          <Select value={statusFilter} onValueChange={(v) => { setStatusFilter(v); setPage(0); }}>
            <SelectTrigger className="h-8 w-36 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {["pending", "sent", "delivered", "read", "failed", "simulated", "dead"].map((s) => (
                <SelectItem key={s} value={s} className="capitalize">{s}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center justify-center py-10">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : logs.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-10 text-center">
            <div className="h-12 w-12 rounded-full bg-muted flex items-center justify-center">
              <MessageSquare className="h-6 w-6 text-muted-foreground" />
            </div>
            <p className="text-sm font-medium">No messages found</p>
            <p className="text-xs text-muted-foreground">Outbound WhatsApp notifications will appear here once sent.</p>
          </div>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Type</TableHead>
                  <TableHead>Phone</TableHead>
                  <TableHead>Template</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Attempts</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {logs.map((log) => (
                  <TableRow key={log.id}>
                    <TableCell className="text-sm">{log.notifType}</TableCell>
                    <TableCell className="font-mono text-xs">{log.phone}</TableCell>
                    <TableCell className="font-mono text-xs">{log.templateName ?? "—"}</TableCell>
                    <TableCell><StatusGlyph log={log} /></TableCell>
                    <TableCell className="text-sm text-muted-foreground">{log.attempts ?? 0}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {new Date(log.createdAt).toLocaleString()}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <div className="flex items-center justify-between pt-3">
              <p className="text-xs text-muted-foreground">Page {page + 1}</p>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0} className="h-7 px-2">
                  <ChevronLeft className="h-3.5 w-3.5" />
                </Button>
                <Button variant="outline" size="sm" onClick={() => setPage((p) => p + 1)} disabled={logs.length < LOG_PAGE_SIZE} className="h-7 px-2">
                  <ChevronRight className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function WaTemplates() {
  const { activeTenantId } = useActiveTenant();
  const tenantId = activeTenantId;

  return (
    <DashboardLayout>
      <div className="p-6 space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <MessageSquare className="w-6 h-6 text-primary" />
            WhatsApp Templates
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Meta message-template library and outbound message delivery status for the active tenant.
          </p>
        </div>
        <Tabs defaultValue="templates">
          <TabsList>
            <TabsTrigger value="templates" className="gap-1.5"><FileCode className="w-3.5 h-3.5" /> Templates</TabsTrigger>
            <TabsTrigger value="message-log" className="gap-1.5"><History className="w-3.5 h-3.5" /> Message Log</TabsTrigger>
          </TabsList>
          <TabsContent value="templates" className="mt-4">
            <TemplatesTab tenantId={tenantId} />
          </TabsContent>
          <TabsContent value="message-log" className="mt-4">
            <MessageLogTab />
          </TabsContent>
        </Tabs>
      </div>
    </DashboardLayout>
  );
}
