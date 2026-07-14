import { useState } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import {
  GitBranch, Clock, CheckCircle2, Archive, Plus, RotateCcw,
  Upload, Eye, FileText, ChevronRight, History, Diff
} from "lucide-react";

const statusColors: Record<string, string> = {
  draft: "bg-amber-500/15 text-amber-400 border-amber-500/30",
  published: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  archived: "bg-slate-500/15 text-slate-400 border-slate-500/30",
};

const statusIcons: Record<string, React.ReactNode> = {
  draft: <Clock className="w-3 h-3" />,
  published: <CheckCircle2 className="w-3 h-3" />,
  archived: <Archive className="w-3 h-3" />,
};

export default function TemplateVersions() {
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [newVersionOpen, setNewVersionOpen] = useState(false);
  const [revertOpen, setRevertOpen] = useState<string | null>(null);
  const [newBody, setNewBody] = useState("");
  const [newSummary, setNewSummary] = useState("");
  const [previewText, setPreviewText] = useState("");
  const [historyTab, setHistoryTab] = useState<"versions" | "approval">("versions");

  const { data: approvalHistory } = trpc.template.getApprovalHistoryReal.useQuery(
    { templateId: selectedTemplateId ?? "" },
    { enabled: !!selectedTemplateId }
  );

  const { data: templatesData, isLoading: loadingTemplates } = trpc.template.list.useQuery({});
  const templates = templatesData?.templates ?? [];

  const { data: versionsData, isLoading: loadingVersions, refetch: refetchVersions } =
    trpc.templateVersions.list.useQuery(
      { templateId: selectedTemplateId ?? "" },
      { enabled: !!selectedTemplateId }
    );
  const versions = versionsData?.versions ?? [];

  const createVersion = trpc.templateVersions.create.useMutation({
    onSuccess: () => {
      toast.success("Draft version created");
      setNewVersionOpen(false);
      setNewBody("");
      setNewSummary("");
      refetchVersions();
    },
    onError: (e) => toast.error(e.message),
  });

  const publishVersion = trpc.templateVersions.publish.useMutation({
    onSuccess: () => {
      toast.success("Version published — template updated");
      refetchVersions();
    },
    onError: (e) => toast.error(e.message),
  });

  const revertVersion = trpc.templateVersions.revert.useMutation({
    onSuccess: () => {
      toast.success("Reverted — new draft created");
      setRevertOpen(null);
      refetchVersions();
    },
    onError: (e) => toast.error(e.message),
  });

  const archiveVersion = trpc.templateVersions.archive.useMutation({
    onSuccess: () => {
      toast.success("Version archived");
      refetchVersions();
    },
    onError: (e) => toast.error(e.message),
  });

  const selectedTemplate = templates.find(t => t.id === selectedTemplateId);

  const handleNewVersion = () => {
    if (!selectedTemplateId) return;
    createVersion.mutate({
      templateId: selectedTemplateId,
      bodyText: newBody || selectedTemplate?.bodyText || "",
      changeSummary: newSummary,
    });
  };

  return (
    <DashboardLayout>
      <div className="p-6 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
              <GitBranch className="w-6 h-6 text-primary" />
              Template Version Control
            </h1>
            <p className="text-muted-foreground mt-1">
              Manage draft and published versions of your WhatsApp message templates
            </p>
          </div>
        </div>

        <div className="grid grid-cols-12 gap-6">
          {/* Template List */}
          <div className="col-span-4">
            <Card className="border-border/50 bg-card/50">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
                  Templates ({templates.length})
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <ScrollArea className="h-[500px]">
                  {loadingTemplates ? (
                    <div className="p-4 space-y-2">
                      {[1, 2, 3].map(i => (
                        <div key={i} className="h-16 bg-muted/30 rounded-lg animate-pulse" />
                      ))}
                    </div>
                  ) : templates.length === 0 ? (
                    <div className="p-6 text-center text-muted-foreground">
                      <FileText className="w-8 h-8 mx-auto mb-2 opacity-40" />
                      <p className="text-sm">No templates yet</p>
                    </div>
                  ) : (
                    <div className="divide-y divide-border/30">
                      {templates.map(t => (
                        <button
                          key={t.id}
                          onClick={() => setSelectedTemplateId(t.id)}
                          className={`w-full text-left px-4 py-3 transition-colors hover:bg-muted/30 ${
                            selectedTemplateId === t.id ? "bg-primary/10 border-l-2 border-primary" : ""
                          }`}
                        >
                          <div className="flex items-center justify-between">
                            <span className="font-medium text-sm text-foreground">{t.name}</span>
                            <ChevronRight className="w-4 h-4 text-muted-foreground" />
                          </div>
                          <div className="flex items-center gap-2 mt-1">
                            <Badge variant="outline" className="text-xs capitalize">{t.category}</Badge>
                            <span className="text-xs text-muted-foreground">{t.language}</span>
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </ScrollArea>
              </CardContent>
            </Card>
          </div>

          {/* Version History Panel */}
          <div className="col-span-8">
            {!selectedTemplateId ? (
              <Card className="border-border/50 bg-card/50 h-[560px] flex items-center justify-center">
                <div className="text-center text-muted-foreground">
                  <History className="w-12 h-12 mx-auto mb-3 opacity-30" />
                  <p className="font-medium">Select a template</p>
                  <p className="text-sm mt-1">Choose a template from the left to view its version history</p>
                </div>
              </Card>
            ) : (
              <Card className="border-border/50 bg-card/50">
                <CardHeader className="pb-3 flex flex-row items-center justify-between">
                  <div>
                    <CardTitle className="text-base font-semibold">{selectedTemplate?.name}</CardTitle>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {versions.length} version{versions.length !== 1 ? "s" : ""}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    onClick={() => {
                      setNewBody(selectedTemplate?.bodyText ?? "");
                      setNewVersionOpen(true);
                    }}
                    className="gap-1.5"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    New Draft
                  </Button>
                </CardHeader>
                <Separator />
                <CardContent className="p-0">
                  {/* Tab switcher: Versions | Approval History */}
                  <div className="flex gap-1 p-3 border-b border-border/30">
                    <button
                      onClick={() => setHistoryTab("versions")}
                      className={`px-3 py-1 text-xs rounded-md transition-colors ${historyTab === "versions" ? "bg-primary/20 text-primary font-medium" : "text-muted-foreground hover:text-foreground"}`}
                    >
                      Version History
                    </button>
                    <button
                      onClick={() => setHistoryTab("approval")}
                      className={`px-3 py-1 text-xs rounded-md transition-colors ${historyTab === "approval" ? "bg-primary/20 text-primary font-medium" : "text-muted-foreground hover:text-foreground"}`}
                    >
                      Approval Timeline
                    </button>
                  </div>
                  <ScrollArea className="h-[420px]">
                    {historyTab === "approval" ? (
                      <div className="p-4">
                        {!approvalHistory || (approvalHistory as unknown[]).length === 0 ? (
                          <div className="text-center py-8 text-muted-foreground">
                            <p className="text-sm font-medium">No approval events yet</p>
                            <p className="text-xs mt-1">Submit this template to Meta to start the approval process</p>
                          </div>
                        ) : (
                          <div className="relative">
                            <div className="absolute left-3.5 top-0 bottom-0 w-px bg-border/50" />
                            <div className="space-y-4">
                              {(approvalHistory as Array<{ id: string; templateId: string; tenantId: string; fromStatus: string | null; toStatus: string; changedBy: string | null; reason: string | null; metaSubmissionId: string | null; createdAt: Date | string | number }>).map((evt, evtIdx) => {
                                const approvalColors: Record<string, string> = {
                                  draft: "bg-slate-500/20 border-slate-500/40 text-slate-400",
                                  submitted: "bg-blue-500/20 border-blue-500/40 text-blue-400",
                                  approved: "bg-emerald-500/20 border-emerald-500/40 text-emerald-400",
                                  rejected: "bg-red-500/20 border-red-500/40 text-red-400",
                                  paused: "bg-amber-500/20 border-amber-500/40 text-amber-400",
                                };
                                const evtStatus = evt.toStatus ?? "draft";
                                const color = approvalColors[evtStatus] ?? approvalColors.draft;
                                const textColor = color.split(" ")[2];
                                return (
                                  <div key={evtIdx} className="flex gap-3 pl-1">
                                    <div className={`w-6 h-6 rounded-full border flex items-center justify-center text-[10px] font-bold shrink-0 z-10 ${color}`}>
                                      {evtStatus.charAt(0).toUpperCase()}
                                    </div>
                                    <div className="flex-1 min-w-0 pb-2">
                                      <div className="flex items-center gap-2 flex-wrap">
                                        <span className={`text-xs font-semibold capitalize ${textColor}`}>{evtStatus}</span>
                                        <span className="text-xs text-muted-foreground">{new Date(evt.createdAt).toLocaleString()}</span>
                                      </div>
                                      {evt.metaSubmissionId && <p className="text-xs text-muted-foreground mt-0.5">Meta ID: {evt.metaSubmissionId}</p>}
                                      {evt.reason && <p className="text-xs text-foreground/70 mt-1 bg-muted/20 rounded px-2 py-1">{evt.reason}</p>}
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        )}
                      </div>
                    ) : (
                    <>
                    {loadingVersions ? (
                      <div className="p-4 space-y-3">
                        {[1, 2, 3].map(i => (
                          <div key={i} className="h-24 bg-muted/30 rounded-lg animate-pulse" />
                        ))}
                      </div>
                    ) : versions.length === 0 ? (
                      <div className="p-8 text-center text-muted-foreground">
                        <GitBranch className="w-10 h-10 mx-auto mb-3 opacity-30" />
                        <p className="font-medium">No versions yet</p>
                        <p className="text-sm mt-1">Create a draft to start tracking changes</p>
                        <Button
                          size="sm"
                          variant="outline"
                          className="mt-4"
                          onClick={() => {
                            setNewBody(selectedTemplate?.bodyText ?? "");
                            setNewVersionOpen(true);
                          }}
                        >
                          <Plus className="w-3.5 h-3.5 mr-1.5" />
                          Create First Version
                        </Button>
                      </div>
                    ) : (
                      <div className="divide-y divide-border/30">
                        {versions.map((v, idx) => (
                          <div key={v.id} className="p-4 hover:bg-muted/10 transition-colors">
                            <div className="flex items-start justify-between gap-3">
                              <div className="flex items-center gap-3">
                                <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold border ${
                                  v.status === "published" ? "bg-emerald-500/20 border-emerald-500/40 text-emerald-400" :
                                  v.status === "draft" ? "bg-amber-500/20 border-amber-500/40 text-amber-400" :
                                  "bg-slate-500/20 border-slate-500/40 text-slate-400"
                                }`}>
                                  v{v.version}
                                </div>
                                <div>
                                  <div className="flex items-center gap-2">
                                    <Badge
                                      variant="outline"
                                      className={`text-xs gap-1 ${statusColors[v.status] ?? ""}`}
                                    >
                                      {statusIcons[v.status]}
                                      {v.status}
                                    </Badge>
                                    {idx === 0 && <Badge variant="outline" className="text-xs text-primary border-primary/30">Latest</Badge>}
                                  </div>
                                  <p className="text-xs text-muted-foreground mt-1">
                                    {v.changeSummary ?? "No change summary"}
                                    {v.changedBy && <span className="ml-1 opacity-60">by {v.changedBy}</span>}
                                  </p>
                                  <p className="text-xs text-muted-foreground/60 mt-0.5">
                                    {new Date(v.createdAt).toLocaleString()}
                                    {v.publishedAt && ` · Published ${new Date(v.publishedAt).toLocaleDateString()}`}
                                  </p>
                                </div>
                              </div>
                              <div className="flex items-center gap-1.5 shrink-0">
                                {v.status === "draft" && (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    className="h-7 text-xs gap-1 border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/10"
                                    onClick={() => publishVersion.mutate({ versionId: v.id })}
                                    disabled={publishVersion.isPending}
                                  >
                                    <Upload className="w-3 h-3" />
                                    Publish
                                  </Button>
                                )}
                                {v.status !== "draft" && (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    className="h-7 text-xs gap-1"
                                    onClick={() => setRevertOpen(v.id)}
                                  >
                                    <RotateCcw className="w-3 h-3" />
                                    Revert
                                  </Button>
                                )}
                                {v.status === "draft" && (
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    className="h-7 text-xs text-muted-foreground"
                                    onClick={() => archiveVersion.mutate({ versionId: v.id })}
                                  >
                                    <Archive className="w-3 h-3" />
                                  </Button>
                                )}
                              </div>
                            </div>

                            {/* Body preview */}
                            <div className="mt-3 ml-11 bg-muted/20 rounded-lg p-3 border border-border/30">
                              <p className="text-xs text-muted-foreground font-mono leading-relaxed whitespace-pre-wrap">
                                {v.bodyText.length > 200 ? v.bodyText.slice(0, 200) + "…" : v.bodyText}
                              </p>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                    </>
                  )}
                  </ScrollArea>
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      </div>

      {/* New Version Dialog */}
      <Dialog open={newVersionOpen} onOpenChange={setNewVersionOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <GitBranch className="w-4 h-4 text-primary" />
              Create New Draft Version
            </DialogTitle>
          </DialogHeader>
          <Tabs defaultValue="edit">
            <TabsList className="mb-4">
              <TabsTrigger value="edit" className="gap-1.5"><FileText className="w-3.5 h-3.5" />Edit</TabsTrigger>
              <TabsTrigger value="preview" className="gap-1.5"><Eye className="w-3.5 h-3.5" />Preview</TabsTrigger>
            </TabsList>
            <TabsContent value="edit" className="space-y-4">
              <div className="space-y-2">
                <Label>Message Body</Label>
                <Textarea
                  value={newBody}
                  onChange={e => setNewBody(e.target.value)}
                  rows={8}
                  className="font-mono text-sm"
                  placeholder="Enter the message body. Use {{variable_name}} for dynamic values."
                />
                <p className="text-xs text-muted-foreground">
                  Variables detected: {(newBody.match(/\{\{[^}]+\}\}/g) ?? []).join(", ") || "none"}
                </p>
              </div>
              <div className="space-y-2">
                <Label>Change Summary</Label>
                <Input
                  value={newSummary}
                  onChange={e => setNewSummary(e.target.value)}
                  placeholder="e.g. Added tracking link, updated CTA button text"
                />
              </div>
            </TabsContent>
            <TabsContent value="preview" className="space-y-4">
              <div className="bg-[#0d1117] rounded-xl p-4 border border-border/30">
                <div className="flex items-center gap-2 mb-3">
                  <div className="w-8 h-8 rounded-full bg-emerald-500/20 flex items-center justify-center text-xs font-bold text-emerald-400">WC</div>
                  <div>
                    <p className="text-xs font-semibold text-foreground">WhatsApp Commerce</p>
                    <p className="text-xs text-muted-foreground">Business Account</p>
                  </div>
                </div>
                <div className="bg-[#1a2332] rounded-lg p-3 max-w-xs">
                  <p className="text-sm text-foreground whitespace-pre-wrap leading-relaxed">{newBody || "Your message will appear here…"}</p>
                  <p className="text-xs text-muted-foreground/60 text-right mt-1">12:00 PM ✓✓</p>
                </div>
              </div>
            </TabsContent>
          </Tabs>
          <DialogFooter>
            <Button variant="outline" onClick={() => setNewVersionOpen(false)}>Cancel</Button>
            <Button onClick={handleNewVersion} disabled={createVersion.isPending || !newBody.trim()}>
              {createVersion.isPending ? "Creating…" : "Create Draft"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Revert Confirmation Dialog */}
      <Dialog open={!!revertOpen} onOpenChange={() => setRevertOpen(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <RotateCcw className="w-4 h-4 text-amber-400" />
              Revert to This Version?
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            This will create a new draft version with the content from the selected version. The current published version will remain active until you publish the new draft.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRevertOpen(null)}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={() => revertOpen && revertVersion.mutate({ versionId: revertOpen, changeSummary: "Reverted to previous version" })}
              disabled={revertVersion.isPending}
            >
              {revertVersion.isPending ? "Reverting…" : "Revert"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  );
}
