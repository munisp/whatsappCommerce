// === W55 ui-b ===
/**
 * TaxStatements — supplier tax profiles + annual statements (W33
 * `taxStatements` router). Profiles CRUD, per-supplier annual totals preview
 * (real payment records only), statement generate/send, and the supplier-side
 * inbox for statements addressed to this tenant.
 */
import { useState } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import { useActiveTenant } from "@/contexts/TenantContext";
import { Plus, Send, Loader2, Trash2, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { formatCents, formatDate } from "@/lib/b2bLogic";

const STMT_BADGE: Record<string, "default" | "secondary" | "outline"> = {
  generated: "secondary", sent: "default", viewed: "outline",
};

export default function TaxStatements() {
  const { activeTenantId: tenantId } = useActiveTenant();
  const [year, setYear] = useState(String(new Date().getFullYear() - 1));
  const [showProfile, setShowProfile] = useState(false);
  const [profileForm, setProfileForm] = useState({ vendorName: "", vendorRef: "", taxId: "", taxIdType: "tin", countryCode: "NG", withholdingPct: "", phone: "" });

  const profilesQ = trpc.taxStatements.listProfiles.useQuery({ tenantId }, { enabled: !!tenantId });
  const totalsQ = trpc.taxStatements.annualTotals.useQuery({ tenantId, year: Number(year) }, { enabled: !!tenantId && !!year });
  const statementsQ = trpc.taxStatements.listStatements.useQuery({ tenantId, year: Number(year) || undefined }, { enabled: !!tenantId });
  const inboxQ = trpc.taxStatements.supplierInbox.useQuery({ tenantId }, { enabled: !!tenantId });

  const onErr = (e: { message: string }) => toast.error(e.message);
  const upsertProfile = trpc.taxStatements.upsertProfile.useMutation({
    onSuccess: () => { toast.success("Supplier profile saved"); setShowProfile(false); profilesQ.refetch(); },
    onError: onErr,
  });
  const deleteProfile = trpc.taxStatements.deleteProfile.useMutation({
    onSuccess: () => { toast.success("Profile deleted (statements kept)"); profilesQ.refetch(); },
    onError: onErr,
  });
  const generate = trpc.taxStatements.generateAnnualStatement.useMutation({
    onSuccess: () => { toast.success("Statement generated"); statementsQ.refetch(); },
    onError: onErr,
  });
  const send = trpc.taxStatements.sendStatement.useMutation({
    onSuccess: () => { toast.success("Statement sent via WhatsApp"); statementsQ.refetch(); },
    onError: onErr,
  });
  const markViewed = trpc.taxStatements.markViewed.useMutation({
    onSuccess: () => { toast.success("Marked as viewed"); inboxQ.refetch(); },
    onError: onErr,
  });

  const years = Array.from({ length: 5 }, (_, i) => String(new Date().getFullYear() - i));

  return (
    <DashboardLayout>
      <div className="p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">Tax Statements</h1>
            <p className="text-muted-foreground text-sm mt-1">Supplier tax profiles & annual payment statements (from real payment records)</p>
          </div>
          <Button onClick={() => setShowProfile(true)}><Plus className="h-4 w-4 mr-2" /> New Supplier Profile</Button>
        </div>

        <Tabs defaultValue="statements">
          <div className="flex items-center gap-3">
            <TabsList>
              <TabsTrigger value="statements">Statements</TabsTrigger>
              <TabsTrigger value="profiles">Supplier Profiles</TabsTrigger>
              <TabsTrigger value="inbox">Supplier Inbox</TabsTrigger>
            </TabsList>
            <div className="flex-1" />
            <Label className="text-xs text-muted-foreground">Year</Label>
            <Select value={year} onValueChange={setYear}>
              <SelectTrigger className="w-28"><SelectValue /></SelectTrigger>
              <SelectContent>{years.map((y) => <SelectItem key={y} value={y}>{y}</SelectItem>)}</SelectContent>
            </Select>
          </div>

          <TabsContent value="statements" className="space-y-4">
            <Card>
              <CardHeader><CardTitle className="text-base">Annual totals preview ({year})</CardTitle></CardHeader>
              <CardContent className="p-0">
                {!totalsQ.data?.length ? (
                  <p className="text-muted-foreground text-sm text-center py-8">No real payments recorded to suppliers in {year}.</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Supplier</TableHead><TableHead className="text-right">Payments</TableHead>
                        <TableHead className="text-right">Total paid</TableHead><TableHead>Sources</TableHead><TableHead className="text-right">Statement</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {totalsQ.data.map((t: any) => (
                        <TableRow key={`${t.supplierRef}-${t.currency}`}>
                          <TableCell className="font-medium">{t.vendorName ?? t.supplierRef}</TableCell>
                          <TableCell className="text-right">{t.paymentCount}</TableCell>
                          <TableCell className="text-right font-semibold">{formatCents(t.totalPaidCents, t.currency)}</TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {Object.entries(t.sources ?? {}).filter(([, n]) => (n as number) > 0).map(([k, n]) => `${k} ${n}`).join(" · ") || "—"}
                          </TableCell>
                          <TableCell className="text-right">
                            <Button size="sm" variant="outline" disabled={generate.isPending}
                              onClick={() => generate.mutate({ tenantId, supplierRef: t.supplierRef, year: Number(year) })}>
                              <FileText className="h-3 w-3 mr-1" />Generate
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle className="text-base">Generated statements</CardTitle></CardHeader>
              <CardContent className="p-0">
                {!statementsQ.data?.length ? (
                  <p className="text-muted-foreground text-sm text-center py-8">No statements generated for {year} yet.</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Supplier</TableHead><TableHead>Year</TableHead><TableHead className="text-right">Total paid</TableHead>
                        <TableHead className="text-right">Withholding (label)</TableHead><TableHead>Generated</TableHead>
                        <TableHead>Status</TableHead><TableHead className="text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {statementsQ.data.map((s) => (
                        <TableRow key={s.id}>
                          <TableCell className="font-medium">{s.vendorName}</TableCell>
                          <TableCell>{s.year}</TableCell>
                          <TableCell className="text-right">{formatCents(s.totalPaidCents, s.currency)}</TableCell>
                          <TableCell className="text-right">{formatCents(s.withholdingCents, s.currency)}</TableCell>
                          <TableCell>{formatDate(s.generatedAt)}</TableCell>
                          <TableCell><Badge variant={STMT_BADGE[s.status] ?? "secondary"} className="capitalize">{s.status}</Badge></TableCell>
                          <TableCell className="text-right">
                            {s.status === "generated" && (
                              <Button size="sm" variant="outline" onClick={() => send.mutate({ tenantId, statementId: s.id })}><Send className="h-3 w-3 mr-1" />Send</Button>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="profiles">
            <Card>
              <CardContent className="p-0">
                {!profilesQ.data?.length ? (
                  <p className="text-muted-foreground text-sm text-center py-10">No supplier tax profiles yet.</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Vendor</TableHead><TableHead>Ref</TableHead><TableHead>Tax ID</TableHead>
                        <TableHead>Country</TableHead><TableHead className="text-right">Withholding</TableHead><TableHead className="text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {profilesQ.data.map((p) => (
                        <TableRow key={p.id}>
                          <TableCell className="font-medium">{p.vendorName}</TableCell>
                          <TableCell className="text-xs">{p.vendorRef ?? "—"}</TableCell>
                          <TableCell className="text-xs">{p.taxId ? `${p.taxId} (${p.taxIdType ?? "?"})` : "—"}</TableCell>
                          <TableCell>{p.countryCode ?? "—"}</TableCell>
                          <TableCell className="text-right">{(p.withholdingBps / 100).toFixed(2)}%</TableCell>
                          <TableCell className="text-right">
                            <Button size="sm" variant="ghost" onClick={() => deleteProfile.mutate({ tenantId, profileId: p.id })}><Trash2 className="h-3 w-3" /></Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="inbox">
            <Card>
              <CardContent className="p-0">
                {!inboxQ.data?.length ? (
                  <p className="text-muted-foreground text-sm text-center py-10">No statements addressed to this tenant.</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>From (payer)</TableHead><TableHead>Year</TableHead><TableHead className="text-right">Total paid</TableHead>
                        <TableHead>Generated</TableHead><TableHead>Status</TableHead><TableHead className="text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {inboxQ.data.map((s) => (
                        <TableRow key={s.id}>
                          <TableCell className="font-mono text-xs">{s.tenantId}</TableCell>
                          <TableCell>{s.year}</TableCell>
                          <TableCell className="text-right">{formatCents(s.totalPaidCents, s.currency)}</TableCell>
                          <TableCell>{formatDate(s.generatedAt)}</TableCell>
                          <TableCell><Badge variant={STMT_BADGE[s.status] ?? "secondary"} className="capitalize">{s.status}</Badge></TableCell>
                          <TableCell className="text-right">
                            {s.status === "sent" && (
                              <Button size="sm" variant="outline" onClick={() => markViewed.mutate({ tenantId, statementId: s.id })}>Mark viewed</Button>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>

        <Dialog open={showProfile} onOpenChange={setShowProfile}>
          <DialogContent>
            <DialogHeader><DialogTitle>Supplier Tax Profile</DialogTitle></DialogHeader>
            <div className="space-y-3">
              <div><Label>Vendor name</Label><Input value={profileForm.vendorName} onChange={(e) => setProfileForm({ ...profileForm, vendorName: e.target.value })} /></div>
              <div className="grid grid-cols-2 gap-3">
                <div><Label>Vendor ref</Label><Input value={profileForm.vendorRef} onChange={(e) => setProfileForm({ ...profileForm, vendorRef: e.target.value })} /></div>
                <div><Label>Phone</Label><Input value={profileForm.phone} onChange={(e) => setProfileForm({ ...profileForm, phone: e.target.value })} /></div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div><Label>Tax ID</Label><Input value={profileForm.taxId} onChange={(e) => setProfileForm({ ...profileForm, taxId: e.target.value })} /></div>
                <div>
                  <Label>Tax ID type</Label>
                  <Select value={profileForm.taxIdType} onValueChange={(v) => setProfileForm({ ...profileForm, taxIdType: v })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>{["tin", "vat", "cac", "nin", "other"].map((t) => <SelectItem key={t} value={t}>{t.toUpperCase()}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div><Label>Country code</Label><Input maxLength={2} value={profileForm.countryCode} onChange={(e) => setProfileForm({ ...profileForm, countryCode: e.target.value.toUpperCase() })} /></div>
                <div><Label>Withholding %</Label><Input type="number" min={0} max={100} step="0.01" value={profileForm.withholdingPct} onChange={(e) => setProfileForm({ ...profileForm, withholdingPct: e.target.value })} /></div>
              </div>
            </div>
            <DialogFooter>
              <Button
                disabled={upsertProfile.isPending || !profileForm.vendorName}
                onClick={() => upsertProfile.mutate({
                  tenantId,
                  vendorName: profileForm.vendorName,
                  vendorRef: profileForm.vendorRef || undefined,
                  taxId: profileForm.taxId || undefined,
                  taxIdType: (profileForm.taxIdType as any) || undefined,
                  countryCode: profileForm.countryCode || undefined,
                  withholdingBps: profileForm.withholdingPct ? Math.round(Number(profileForm.withholdingPct) * 100) : undefined,
                  phone: profileForm.phone || undefined,
                })}
              >
                {upsertProfile.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />} Save
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </DashboardLayout>
  );
}
// === END W55 ui-b ===
