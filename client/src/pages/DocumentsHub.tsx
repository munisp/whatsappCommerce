// === W55 ui-b ===
/**
 * DocumentsHub — finance documents surface for the W46 `ucDocs` router:
 * proforma invoices (UC-19), customer statements of account (UC-12), and
 * agent commission statements (UC-20). Generate/send/convert/pay actions map
 * 1:1 onto existing router procedures; no new backend surface.
 */
import { useMemo, useState } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import { useActiveTenant } from "@/contexts/TenantContext";
import { FileText, Plus, Send, CheckCircle, XCircle, RefreshCw, Loader2, Users, ArrowRight } from "lucide-react";
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

const PROFORMA_BADGE: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  draft: "secondary", sent: "default", accepted: "default", converted: "outline", expired: "destructive", cancelled: "outline",
};
const STMT_BADGE: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  generated: "secondary", sent: "default", viewed: "outline", paid: "default", cancelled: "outline",
};

function defaultPeriod() {
  const to = new Date();
  const from = new Date(to.getFullYear(), to.getMonth(), 1);
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

export default function DocumentsHub() {
  const { activeTenantId: tenantId } = useActiveTenant();
  const [tab, setTab] = useState("proformas");

  // ── Proformas ─────────────────────────────────────────────────────────────
  const [proformaStatus, setProformaStatus] = useState<string>("all");
  const proformasQ = trpc.ucDocs.listProformas.useQuery(
    { tenantId, status: proformaStatus === "all" ? undefined : proformaStatus },
    { enabled: !!tenantId },
  );
  const [showProforma, setShowProforma] = useState(false);
  const emptyItem = { name: "", quantity: "1", unitPrice: "" };
  const [pfForm, setPfForm] = useState({ customerName: "", customerPhone: "", validDays: "30", notes: "" });
  const [pfItems, setPfItems] = useState([{ ...emptyItem }]);

  const onErr = (e: { message: string }) => toast.error(e.message);

  const createProforma = trpc.ucDocs.createProforma.useMutation({
    onSuccess: () => { toast.success("Proforma created"); setShowProforma(false); setPfItems([{ ...emptyItem }]); proformasQ.refetch(); },
    onError: onErr,
  });
  const sendProforma = trpc.ucDocs.sendProforma.useMutation({ onSuccess: () => { toast.success("Proforma sent"); proformasQ.refetch(); }, onError: onErr });
  const acceptProforma = trpc.ucDocs.acceptProforma.useMutation({ onSuccess: () => { toast.success("Proforma accepted"); proformasQ.refetch(); }, onError: onErr });
  const convertProforma = trpc.ucDocs.convertProforma.useMutation({ onSuccess: () => { toast.success("Converted to order"); proformasQ.refetch(); }, onError: onErr });
  const cancelProforma = trpc.ucDocs.cancelProforma.useMutation({ onSuccess: () => { toast.success("Proforma cancelled"); proformasQ.refetch(); }, onError: onErr });
  const expireProformas = trpc.ucDocs.expireProformas.useMutation({ onSuccess: (r) => { toast.success(`Expired ${r.expired} proforma(s)`); proformasQ.refetch(); }, onError: onErr });

  // ── Customer statements ───────────────────────────────────────────────────
  const statementsQ = trpc.ucDocs.listCustomerStatements.useQuery({ tenantId }, { enabled: !!tenantId });
  const [showStmt, setShowStmt] = useState(false);
  const [stmtForm, setStmtForm] = useState({ customerPhone: "", customerName: "", ...defaultPeriod() });
  const genStatement = trpc.ucDocs.generateCustomerStatement.useMutation({
    onSuccess: () => { toast.success("Statement generated"); setShowStmt(false); statementsQ.refetch(); },
    onError: onErr,
  });
  const sendStatement = trpc.ucDocs.sendCustomerStatement.useMutation({ onSuccess: () => { toast.success("Statement sent"); statementsQ.refetch(); }, onError: onErr });

  // ── Agents & commissions ─────────────────────────────────────────────────
  const agentsQ = trpc.ucDocs.listAgents.useQuery({ tenantId }, { enabled: !!tenantId });
  const commissionsQ = trpc.ucDocs.listAgentCommissions.useQuery({ tenantId }, { enabled: !!tenantId });
  const commStatementsQ = trpc.ucDocs.listCommissionStatements.useQuery({ tenantId }, { enabled: !!tenantId });
  const [showAgent, setShowAgent] = useState(false);
  const [agentForm, setAgentForm] = useState({ name: "", phone: "", code: "", commissionPct: "" });
  const upsertAgent = trpc.ucDocs.upsertAgent.useMutation({
    onSuccess: () => { toast.success("Agent saved"); setShowAgent(false); agentsQ.refetch(); },
    onError: onErr,
  });
  const sweep = trpc.ucDocs.sweepAgentCommissions.useMutation({
    onSuccess: (r: any) => { toast.success(`Commission sweep done${typeof r?.created === "number" ? ` — ${r.created} new` : ""}`); commissionsQ.refetch(); },
    onError: onErr,
  });
  const [showCommStmt, setShowCommStmt] = useState(false);
  const [commStmtForm, setCommStmtForm] = useState({ agentId: "", ...defaultPeriod() });
  const genCommStmt = trpc.ucDocs.generateCommissionStatement.useMutation({
    onSuccess: () => { toast.success("Commission statement generated"); setShowCommStmt(false); commStatementsQ.refetch(); commissionsQ.refetch(); },
    onError: onErr,
  });
  const sendCommStmt = trpc.ucDocs.sendCommissionStatement.useMutation({ onSuccess: () => { toast.success("Statement sent"); commStatementsQ.refetch(); }, onError: onErr });
  const payCommStmt = trpc.ucDocs.payCommissionStatement.useMutation({ onSuccess: () => { toast.success("Commission paid out"); commStatementsQ.refetch(); commissionsQ.refetch(); }, onError: onErr });

  const agentById = useMemo(() => new Map((agentsQ.data ?? []).map((a) => [a.id, a])), [agentsQ.data]);

  const pfTotal = pfItems.reduce((s, it) => s + (Number(it.quantity) || 0) * Math.round(Number(it.unitPrice) * 100 || 0), 0);

  return (
    <DashboardLayout>
      <div className="p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">Finance Documents</h1>
            <p className="text-muted-foreground text-sm mt-1">Proforma invoices, customer statements & agent commissions</p>
          </div>
        </div>

        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="proformas">Proforma Invoices</TabsTrigger>
            <TabsTrigger value="statements">Customer Statements</TabsTrigger>
            <TabsTrigger value="commissions">Commissions</TabsTrigger>
          </TabsList>

          {/* ── Proformas ── */}
          <TabsContent value="proformas" className="space-y-4">
            <div className="flex items-center gap-2">
              <Select value={proformaStatus} onValueChange={setProformaStatus}>
                <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {["all", "draft", "sent", "accepted", "converted", "expired", "cancelled"].map((s) => (
                    <SelectItem key={s} value={s} className="capitalize">{s}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="flex-1" />
              <Button variant="outline" onClick={() => expireProformas.mutate({ tenantId })} disabled={expireProformas.isPending}>
                <RefreshCw className="h-4 w-4 mr-2" /> Expire stale
              </Button>
              <Button onClick={() => setShowProforma(true)}><Plus className="h-4 w-4 mr-2" /> New Proforma</Button>
            </div>
            <Card>
              <CardContent className="p-0">
                {!proformasQ.data?.length ? (
                  <p className="text-muted-foreground text-sm text-center py-10">No proforma invoices yet.</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>No.</TableHead><TableHead>Customer</TableHead><TableHead className="text-right">Total</TableHead>
                        <TableHead>Valid until</TableHead><TableHead>Status</TableHead><TableHead className="text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {proformasQ.data.map((p) => (
                        <TableRow key={p.id}>
                          <TableCell className="font-medium">PF-{p.proformaNo}</TableCell>
                          <TableCell>{p.customerName ?? p.customerPhone ?? "—"}</TableCell>
                          <TableCell className="text-right">{formatCents(p.totalCents, p.currency)}</TableCell>
                          <TableCell>{formatDate(p.validUntil)}</TableCell>
                          <TableCell><Badge variant={PROFORMA_BADGE[p.status] ?? "secondary"} className="capitalize">{p.status}</Badge></TableCell>
                          <TableCell className="text-right space-x-1">
                            {p.status === "draft" && (
                              <Button size="sm" variant="outline" onClick={() => sendProforma.mutate({ tenantId, proformaId: p.id })}><Send className="h-3 w-3 mr-1" />Send</Button>
                            )}
                            {p.status === "sent" && (
                              <Button size="sm" variant="outline" onClick={() => acceptProforma.mutate({ tenantId, proformaId: p.id })}><CheckCircle className="h-3 w-3 mr-1" />Accept</Button>
                            )}
                            {p.status === "accepted" && (
                              <Button size="sm" onClick={() => convertProforma.mutate({ tenantId, proformaId: p.id })}><ArrowRight className="h-3 w-3 mr-1" />Convert</Button>
                            )}
                            {["draft", "sent"].includes(p.status) && (
                              <Button size="sm" variant="ghost" onClick={() => cancelProforma.mutate({ tenantId, proformaId: p.id })}><XCircle className="h-3 w-3" /></Button>
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

          {/* ── Customer statements ── */}
          <TabsContent value="statements" className="space-y-4">
            <div className="flex justify-end">
              <Button onClick={() => setShowStmt(true)}><Plus className="h-4 w-4 mr-2" /> Generate Statement</Button>
            </div>
            <Card>
              <CardContent className="p-0">
                {!statementsQ.data?.length ? (
                  <p className="text-muted-foreground text-sm text-center py-10">No customer statements generated yet.</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Customer</TableHead><TableHead>Period</TableHead><TableHead className="text-right">Invoiced</TableHead>
                        <TableHead className="text-right">Paid</TableHead><TableHead className="text-right">Outstanding</TableHead>
                        <TableHead>Status</TableHead><TableHead className="text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {statementsQ.data.map((s) => (
                        <TableRow key={s.id}>
                          <TableCell className="font-medium">{s.customerName ?? s.customerPhone}</TableCell>
                          <TableCell className="text-xs">{formatDate(s.periodStart)} – {formatDate(s.periodEnd)}</TableCell>
                          <TableCell className="text-right">{formatCents(s.totalInvoicedCents, s.currency)}</TableCell>
                          <TableCell className="text-right">{formatCents(s.totalPaidCents, s.currency)}</TableCell>
                          <TableCell className="text-right font-semibold">{formatCents(s.outstandingCents, s.currency)}</TableCell>
                          <TableCell><Badge variant={STMT_BADGE[s.status] ?? "secondary"} className="capitalize">{s.status}</Badge></TableCell>
                          <TableCell className="text-right">
                            {s.status === "generated" && (
                              <Button size="sm" variant="outline" onClick={() => sendStatement.mutate({ tenantId, statementId: s.id })}><Send className="h-3 w-3 mr-1" />Send</Button>
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

          {/* ── Commissions ── */}
          <TabsContent value="commissions" className="space-y-4">
            <div className="flex items-center gap-2 justify-end">
              <Button variant="outline" onClick={() => sweep.mutate({ tenantId })} disabled={sweep.isPending}>
                <RefreshCw className="h-4 w-4 mr-2" /> Sweep commissions
              </Button>
              <Button variant="outline" onClick={() => setShowCommStmt(true)}><FileText className="h-4 w-4 mr-2" /> Generate statement</Button>
              <Button onClick={() => setShowAgent(true)}><Users className="h-4 w-4 mr-2" /> New agent</Button>
            </div>

            <div className="grid lg:grid-cols-2 gap-4">
              <Card>
                <CardHeader><CardTitle className="text-base">Agents</CardTitle></CardHeader>
                <CardContent className="p-0">
                  {!agentsQ.data?.length ? (
                    <p className="text-muted-foreground text-sm text-center py-8">No agents registered.</p>
                  ) : (
                    <Table>
                      <TableHeader><TableRow><TableHead>Name</TableHead><TableHead>Code</TableHead><TableHead className="text-right">Commission</TableHead><TableHead>Status</TableHead></TableRow></TableHeader>
                      <TableBody>
                        {agentsQ.data.map((a) => (
                          <TableRow key={a.id}>
                            <TableCell className="font-medium">{a.name}</TableCell>
                            <TableCell>{a.code}</TableCell>
                            <TableCell className="text-right">{(a.commissionBps / 100).toFixed(2)}%</TableCell>
                            <TableCell><Badge variant={a.status === "active" ? "default" : "destructive"} className="capitalize">{a.status}</Badge></TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader><CardTitle className="text-base">Commission Statements</CardTitle></CardHeader>
                <CardContent className="p-0">
                  {!commStatementsQ.data?.length ? (
                    <p className="text-muted-foreground text-sm text-center py-8">No commission statements yet.</p>
                  ) : (
                    <Table>
                      <TableHeader><TableRow><TableHead>Agent</TableHead><TableHead>Period</TableHead><TableHead className="text-right">Total</TableHead><TableHead>Status</TableHead><TableHead className="text-right">Actions</TableHead></TableRow></TableHeader>
                      <TableBody>
                        {commStatementsQ.data.map((cs) => (
                          <TableRow key={cs.id}>
                            <TableCell className="font-medium">{agentById.get(cs.agentId)?.name ?? cs.agentId.slice(0, 8)}</TableCell>
                            <TableCell className="text-xs">{formatDate(cs.periodStart)} – {formatDate(cs.periodEnd)}</TableCell>
                            <TableCell className="text-right">{formatCents(cs.totalCents, cs.currency)}</TableCell>
                            <TableCell><Badge variant={STMT_BADGE[cs.status] ?? "secondary"} className="capitalize">{cs.status}</Badge></TableCell>
                            <TableCell className="text-right space-x-1">
                              {cs.status === "generated" && (
                                <Button size="sm" variant="outline" onClick={() => sendCommStmt.mutate({ tenantId, statementId: cs.id })}><Send className="h-3 w-3 mr-1" />Send</Button>
                              )}
                              {["generated", "sent"].includes(cs.status) && (
                                <Button size="sm" onClick={() => payCommStmt.mutate({ tenantId, statementId: cs.id })}>Pay</Button>
                              )}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </CardContent>
              </Card>
            </div>

            <Card>
              <CardHeader><CardTitle className="text-base">Commission Lines</CardTitle></CardHeader>
              <CardContent className="p-0">
                {!commissionsQ.data?.length ? (
                  <p className="text-muted-foreground text-sm text-center py-8">No commission lines yet.</p>
                ) : (
                  <Table>
                    <TableHeader><TableRow><TableHead>Agent</TableHead><TableHead>Order</TableHead><TableHead className="text-right">Order total</TableHead><TableHead className="text-right">Commission</TableHead><TableHead>Status</TableHead></TableRow></TableHeader>
                    <TableBody>
                      {commissionsQ.data.map((c) => (
                        <TableRow key={c.id}>
                          <TableCell className="font-medium">{agentById.get(c.agentId)?.name ?? c.agentId.slice(0, 8)}</TableCell>
                          <TableCell className="font-mono text-xs">{c.orderId.slice(0, 8)}…</TableCell>
                          <TableCell className="text-right">{formatCents(c.orderTotalCents, c.currency)}</TableCell>
                          <TableCell className="text-right font-semibold">{formatCents(c.commissionCents, c.currency)}</TableCell>
                          <TableCell><Badge variant={c.status === "paid" ? "default" : c.status === "cancelled" ? "outline" : "secondary"} className="capitalize">{c.status}</Badge></TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>

        {/* New proforma dialog */}
        <Dialog open={showProforma} onOpenChange={setShowProforma}>
          <DialogContent className="max-w-lg">
            <DialogHeader><DialogTitle>New Proforma Invoice</DialogTitle></DialogHeader>
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div><Label>Customer name</Label><Input value={pfForm.customerName} onChange={(e) => setPfForm({ ...pfForm, customerName: e.target.value })} /></div>
                <div><Label>Customer phone</Label><Input value={pfForm.customerPhone} onChange={(e) => setPfForm({ ...pfForm, customerPhone: e.target.value })} /></div>
              </div>
              <div className="space-y-2">
                <Label>Line items</Label>
                {pfItems.map((it, i) => (
                  <div key={i} className="grid grid-cols-[1fr_80px_110px_32px] gap-2">
                    <Input placeholder="Item name" value={it.name} onChange={(e) => setPfItems(pfItems.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} />
                    <Input type="number" min={1} placeholder="Qty" value={it.quantity} onChange={(e) => setPfItems(pfItems.map((x, j) => j === i ? { ...x, quantity: e.target.value } : x))} />
                    <Input type="number" min={0} step="0.01" placeholder="Unit ₦" value={it.unitPrice} onChange={(e) => setPfItems(pfItems.map((x, j) => j === i ? { ...x, unitPrice: e.target.value } : x))} />
                    <Button variant="ghost" size="icon" onClick={() => setPfItems(pfItems.filter((_, j) => j !== i))} disabled={pfItems.length === 1}><XCircle className="h-4 w-4" /></Button>
                  </div>
                ))}
                <Button variant="outline" size="sm" onClick={() => setPfItems([...pfItems, { ...emptyItem }])}><Plus className="h-3 w-3 mr-1" /> Add item</Button>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div><Label>Valid for (days)</Label><Input type="number" min={1} max={365} value={pfForm.validDays} onChange={(e) => setPfForm({ ...pfForm, validDays: e.target.value })} /></div>
                <div><Label>Notes</Label><Input value={pfForm.notes} onChange={(e) => setPfForm({ ...pfForm, notes: e.target.value })} /></div>
              </div>
              <p className="text-sm text-muted-foreground">Total: <span className="font-semibold text-foreground">{formatCents(pfTotal, "NGN")}</span></p>
            </div>
            <DialogFooter>
              <Button
                disabled={createProforma.isPending || pfItems.some((it) => !it.name || !(Number(it.unitPrice) >= 0) || !(Number(it.quantity) > 0))}
                onClick={() => createProforma.mutate({
                  tenantId,
                  customerName: pfForm.customerName || undefined,
                  customerPhone: pfForm.customerPhone || undefined,
                  validDays: Number(pfForm.validDays) || undefined,
                  notes: pfForm.notes || undefined,
                  items: pfItems.map((it) => ({ name: it.name, quantity: Number(it.quantity), unitPriceCents: Math.round(Number(it.unitPrice) * 100) })),
                })}
              >
                {createProforma.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />} Create
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Generate customer statement dialog */}
        <Dialog open={showStmt} onOpenChange={setShowStmt}>
          <DialogContent>
            <DialogHeader><DialogTitle>Generate Customer Statement</DialogTitle></DialogHeader>
            <div className="space-y-3">
              <div><Label>Customer phone</Label><Input value={stmtForm.customerPhone} onChange={(e) => setStmtForm({ ...stmtForm, customerPhone: e.target.value })} /></div>
              <div><Label>Customer name (optional)</Label><Input value={stmtForm.customerName} onChange={(e) => setStmtForm({ ...stmtForm, customerName: e.target.value })} /></div>
              <div className="grid grid-cols-2 gap-3">
                <div><Label>From</Label><Input type="date" value={stmtForm.from} onChange={(e) => setStmtForm({ ...stmtForm, from: e.target.value })} /></div>
                <div><Label>To</Label><Input type="date" value={stmtForm.to} onChange={(e) => setStmtForm({ ...stmtForm, to: e.target.value })} /></div>
              </div>
            </div>
            <DialogFooter>
              <Button
                disabled={genStatement.isPending || stmtForm.customerPhone.trim().length < 3}
                onClick={() => genStatement.mutate({
                  tenantId,
                  customerPhone: stmtForm.customerPhone.trim(),
                  customerName: stmtForm.customerName || undefined,
                  from: new Date(stmtForm.from),
                  to: new Date(stmtForm.to),
                })}
              >
                {genStatement.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />} Generate
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* New agent dialog */}
        <Dialog open={showAgent} onOpenChange={setShowAgent}>
          <DialogContent>
            <DialogHeader><DialogTitle>Register Agent</DialogTitle></DialogHeader>
            <div className="space-y-3">
              <div><Label>Name</Label><Input value={agentForm.name} onChange={(e) => setAgentForm({ ...agentForm, name: e.target.value })} /></div>
              <div><Label>Phone</Label><Input value={agentForm.phone} onChange={(e) => setAgentForm({ ...agentForm, phone: e.target.value })} /></div>
              <div className="grid grid-cols-2 gap-3">
                <div><Label>Code (e.g. AGT-001)</Label><Input value={agentForm.code} onChange={(e) => setAgentForm({ ...agentForm, code: e.target.value })} /></div>
                <div><Label>Commission %</Label><Input type="number" min={0} max={100} step="0.01" value={agentForm.commissionPct} onChange={(e) => setAgentForm({ ...agentForm, commissionPct: e.target.value })} /></div>
              </div>
            </div>
            <DialogFooter>
              <Button
                disabled={upsertAgent.isPending || !agentForm.name || agentForm.phone.trim().length < 3 || agentForm.code.trim().length < 2 || !agentForm.commissionPct}
                onClick={() => upsertAgent.mutate({
                  tenantId,
                  name: agentForm.name,
                  phone: agentForm.phone.trim(),
                  code: agentForm.code.trim(),
                  commissionBps: Math.round(Number(agentForm.commissionPct) * 100),
                })}
              >
                {upsertAgent.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />} Save
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Generate commission statement dialog */}
        <Dialog open={showCommStmt} onOpenChange={setShowCommStmt}>
          <DialogContent>
            <DialogHeader><DialogTitle>Generate Commission Statement</DialogTitle></DialogHeader>
            <div className="space-y-3">
              <div>
                <Label>Agent</Label>
                <Select value={commStmtForm.agentId} onValueChange={(v) => setCommStmtForm({ ...commStmtForm, agentId: v })}>
                  <SelectTrigger><SelectValue placeholder="Select agent" /></SelectTrigger>
                  <SelectContent>
                    {(agentsQ.data ?? []).map((a) => <SelectItem key={a.id} value={a.id}>{a.name} ({a.code})</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div><Label>From</Label><Input type="date" value={commStmtForm.from} onChange={(e) => setCommStmtForm({ ...commStmtForm, from: e.target.value })} /></div>
                <div><Label>To</Label><Input type="date" value={commStmtForm.to} onChange={(e) => setCommStmtForm({ ...commStmtForm, to: e.target.value })} /></div>
              </div>
            </div>
            <DialogFooter>
              <Button
                disabled={genCommStmt.isPending || !commStmtForm.agentId}
                onClick={() => genCommStmt.mutate({ tenantId, agentId: commStmtForm.agentId, from: new Date(commStmtForm.from), to: new Date(commStmtForm.to) })}
              >
                {genCommStmt.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />} Generate
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </DashboardLayout>
  );
}
// === END W55 ui-b ===
