// === W55 ui-c ===
// Returns & exchanges lifecycle for the W41 rma router (ORPHAN-BE-22) and
// W43 exchanges router (ORPHAN-BE-23): merchant decide/receive/refund and
// exchange decide/transition/receive. Buyer initiation stays chat-first.
import { useActiveTenant } from "@/contexts/TenantContext";
import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/lib/trpc";
import { formatDistanceToNow } from "date-fns";
import { ArrowLeftRight, Check, PackageCheck, RotateCcw, Wallet, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

const rmaStatusColors: Record<string, string> = {
  requested: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
  approved: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  rejected: "bg-red-500/20 text-red-400 border-red-500/30",
  received: "bg-cyan-500/20 text-cyan-400 border-cyan-500/30",
  restocked: "bg-purple-500/20 text-purple-400 border-purple-500/30",
  refunded: "bg-green-500/20 text-green-400 border-green-500/30",
  closed: "bg-gray-500/20 text-gray-400 border-gray-500/30",
};

const exchangeStatusColors: Record<string, string> = {
  requested: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
  approved: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  rejected: "bg-red-500/20 text-red-400 border-red-500/30",
  in_transit: "bg-cyan-500/20 text-cyan-400 border-cyan-500/30",
  received: "bg-purple-500/20 text-purple-400 border-purple-500/30",
  completed: "bg-green-500/20 text-green-400 border-green-500/30",
  cancelled: "bg-gray-500/20 text-gray-400 border-gray-500/30",
};

function fmtMoney(cents: number, currency = "NGN") {
  return `${currency} ${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default function ReturnsExchanges() {
  const { activeTenantId: tenantId } = useActiveTenant();
  const utils = trpc.useUtils();

  const [rmaStatus, setRmaStatus] = useState<string>("all");
  const [exStatus, setExStatus] = useState<string>("all");
  const [decision, setDecision] = useState<{ kind: "rma" | "exchange"; id: string; approve: boolean } | null>(null);
  const [decisionNote, setDecisionNote] = useState("");
  const [refundFor, setRefundFor] = useState<string | null>(null);
  const [refundMethod, setRefundMethod] = useState<"psp" | "wallet">("psp");

  const { data: rmas, isLoading: rmaLoading } = trpc.rma.list.useQuery({
    tenantId,
    status: rmaStatus === "all" ? undefined : (rmaStatus as any),
    limit: 100,
  });
  const { data: exchanges, isLoading: exLoading } = trpc.exchanges.list.useQuery({
    tenantId,
    status: exStatus === "all" ? undefined : (exStatus as any),
    limit: 100,
  });

  const invalidate = () => {
    utils.rma.list.invalidate();
    utils.exchanges.list.invalidate();
  };
  const opts = (label: string, close?: () => void) => ({
    onSuccess: () => { toast.success(label); close?.(); invalidate(); },
    onError: (e: any) => toast.error(e.message),
  });
  const rmaDecideMut = trpc.rma.decide.useMutation(opts("Return decision recorded", () => setDecision(null)));
  const rmaReceiveMut = trpc.rma.receive.useMutation(opts("Goods received and restocked"));
  const rmaRefundMut = trpc.rma.refund.useMutation(opts("Refund issued", () => setRefundFor(null)));
  const exDecideMut = trpc.exchanges.decide.useMutation(opts("Exchange decision recorded", () => setDecision(null)));
  const exTransitionMut = trpc.exchanges.transition.useMutation(opts("Exchange updated"));
  const exReceiveMut = trpc.exchanges.receive.useMutation(opts("Exchange goods received"));

  return (
    <DashboardLayout>
      <div className="p-6 space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Returns & Exchanges</h1>
          <p className="text-muted-foreground mt-1">RMA returns lifecycle and product exchanges</p>
        </div>

        <Tabs defaultValue="rma">
          <TabsList>
            <TabsTrigger value="rma"><RotateCcw className="w-3.5 h-3.5 mr-1" />Returns (RMA)</TabsTrigger>
            <TabsTrigger value="exchanges"><ArrowLeftRight className="w-3.5 h-3.5 mr-1" />Exchanges</TabsTrigger>
          </TabsList>

          <TabsContent value="rma" className="space-y-4 pt-4">
            <Select value={rmaStatus} onValueChange={setRmaStatus}>
              <SelectTrigger className="w-48 bg-card border-border"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                {["requested", "approved", "rejected", "received", "restocked", "refunded", "closed"].map((s) => (
                  <SelectItem key={s} value={s}>{s}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Card className="bg-card border-border">
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow className="border-border hover:bg-transparent">
                      <TableHead>Order</TableHead>
                      <TableHead>Buyer</TableHead>
                      <TableHead>Reason</TableHead>
                      <TableHead>Via</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Requested</TableHead>
                      <TableHead></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rmaLoading ? (
                      <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground py-8">Loading...</TableCell></TableRow>
                    ) : !rmas?.length ? (
                      <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground py-8">No return requests</TableCell></TableRow>
                    ) : rmas.map((r) => (
                      <TableRow key={r.id} className="border-border hover:bg-accent/30">
                        <TableCell className="font-mono text-xs">{r.orderId.slice(0, 8)}...</TableCell>
                        <TableCell className="font-mono text-xs">{r.buyerRef}</TableCell>
                        <TableCell className="text-sm max-w-[220px] truncate" title={r.reason}>{r.reason}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">{r.requestedVia}</TableCell>
                        <TableCell>
                          <Badge variant="outline" className={rmaStatusColors[r.status] ?? ""}>{r.status}</Badge>
                          {r.refundedCents != null && <span className="block text-[10px] text-green-400 mt-1">{fmtMoney(r.refundedCents)} refunded</span>}
                        </TableCell>
                        <TableCell className="text-muted-foreground text-xs">{formatDistanceToNow(new Date(r.createdAt), { addSuffix: true })}</TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1">
                            {r.status === "requested" && (
                              <>
                                <Button variant="ghost" size="sm" className="h-7 text-xs gap-1 text-green-400 hover:text-green-300"
                                  onClick={() => { setDecision({ kind: "rma", id: r.id, approve: true }); setDecisionNote(""); }}>
                                  <Check className="w-3 h-3" /> Approve
                                </Button>
                                <Button variant="ghost" size="sm" className="h-7 text-xs gap-1 text-red-400 hover:text-red-300"
                                  onClick={() => { setDecision({ kind: "rma", id: r.id, approve: false }); setDecisionNote(""); }}>
                                  <X className="w-3 h-3" /> Reject
                                </Button>
                              </>
                            )}
                            {r.status === "approved" && (
                              <Button variant="ghost" size="sm" className="h-7 text-xs gap-1"
                                disabled={rmaReceiveMut.isPending}
                                onClick={() => rmaReceiveMut.mutate({ tenantId, rmaId: r.id })}>
                                <PackageCheck className="w-3 h-3" /> Receive & restock
                              </Button>
                            )}
                            {(r.status === "restocked" || r.status === "received") && (
                              <Button variant="ghost" size="sm" className="h-7 text-xs gap-1"
                                onClick={() => { setRefundFor(r.id); setRefundMethod("psp"); }}>
                                <Wallet className="w-3 h-3" /> Refund
                              </Button>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="exchanges" className="space-y-4 pt-4">
            <Select value={exStatus} onValueChange={setExStatus}>
              <SelectTrigger className="w-48 bg-card border-border"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                {["requested", "approved", "rejected", "in_transit", "received", "completed", "cancelled"].map((s) => (
                  <SelectItem key={s} value={s}>{s}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Card className="bg-card border-border">
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow className="border-border hover:bg-transparent">
                      <TableHead>Order</TableHead>
                      <TableHead>Qty</TableHead>
                      <TableHead>Price delta</TableHead>
                      <TableHead>Requested by</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Created</TableHead>
                      <TableHead></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {exLoading ? (
                      <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground py-8">Loading...</TableCell></TableRow>
                    ) : !exchanges?.length ? (
                      <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground py-8">No exchange requests</TableCell></TableRow>
                    ) : exchanges.map((x) => (
                      <TableRow key={x.id} className="border-border hover:bg-accent/30">
                        <TableCell className="font-mono text-xs">{x.orderId.slice(0, 8)}...</TableCell>
                        <TableCell className="font-mono">{x.qty}</TableCell>
                        <TableCell className={`font-mono ${x.priceDeltaCents > 0 ? "text-yellow-400" : x.priceDeltaCents < 0 ? "text-green-400" : ""}`}>
                          {x.priceDeltaCents === 0 ? "—" : fmtMoney(Math.abs(x.priceDeltaCents)) + (x.priceDeltaCents > 0 ? " owed" : " refund")}
                        </TableCell>
                        <TableCell className="font-mono text-xs">{x.requestedBy}</TableCell>
                        <TableCell>
                          <Badge variant="outline" className={exchangeStatusColors[x.status] ?? ""}>{x.status.replaceAll("_", " ")}</Badge>
                          {x.damaged && <span className="block text-[10px] text-red-400 mt-1">damaged goods</span>}
                        </TableCell>
                        <TableCell className="text-muted-foreground text-xs">{formatDistanceToNow(new Date(x.createdAt), { addSuffix: true })}</TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1">
                            {x.status === "requested" && (
                              <>
                                <Button variant="ghost" size="sm" className="h-7 text-xs gap-1 text-green-400 hover:text-green-300"
                                  onClick={() => { setDecision({ kind: "exchange", id: x.id, approve: true }); setDecisionNote(""); }}>
                                  <Check className="w-3 h-3" /> Approve
                                </Button>
                                <Button variant="ghost" size="sm" className="h-7 text-xs gap-1 text-red-400 hover:text-red-300"
                                  onClick={() => { setDecision({ kind: "exchange", id: x.id, approve: false }); setDecisionNote(""); }}>
                                  <X className="w-3 h-3" /> Reject
                                </Button>
                              </>
                            )}
                            {x.status === "approved" && (
                              <Button variant="ghost" size="sm" className="h-7 text-xs"
                                disabled={exTransitionMut.isPending}
                                onClick={() => exTransitionMut.mutate({ tenantId, exchangeId: x.id, to: "in_transit" })}>
                                → in transit
                              </Button>
                            )}
                            {x.status === "in_transit" && (
                              <Button variant="ghost" size="sm" className="h-7 text-xs gap-1"
                                disabled={exReceiveMut.isPending}
                                onClick={() => exReceiveMut.mutate({ tenantId, exchangeId: x.id })}>
                                <PackageCheck className="w-3 h-3" /> Receive
                              </Button>
                            )}
                            {x.status === "received" && (
                              <Button variant="ghost" size="sm" className="h-7 text-xs"
                                disabled={exTransitionMut.isPending}
                                onClick={() => exTransitionMut.mutate({ tenantId, exchangeId: x.id, to: "completed" })}>
                                → complete
                              </Button>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>

        <Dialog open={!!decision} onOpenChange={() => setDecision(null)}>
          <DialogContent>
            <DialogHeader><DialogTitle>{decision?.approve ? "Approve" : "Reject"} {decision?.kind === "rma" ? "return" : "exchange"}</DialogTitle></DialogHeader>
            <div className="space-y-2">
              <Label>Note (optional)</Label>
              <Textarea value={decisionNote} onChange={(e) => setDecisionNote(e.target.value)} maxLength={500} />
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDecision(null)}>Close</Button>
              <Button variant={decision?.approve ? "default" : "destructive"}
                disabled={rmaDecideMut.isPending || exDecideMut.isPending}
                onClick={() => {
                  if (!decision) return;
                  if (decision.kind === "rma") {
                    rmaDecideMut.mutate({ tenantId, rmaId: decision.id, approve: decision.approve, note: decisionNote || undefined });
                  } else {
                    exDecideMut.mutate({ tenantId, exchangeId: decision.id, approve: decision.approve, note: decisionNote || undefined });
                  }
                }}>
                {decision?.approve ? "Approve" : "Reject"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog open={!!refundFor} onOpenChange={() => setRefundFor(null)}>
          <DialogContent>
            <DialogHeader><DialogTitle>Refund return</DialogTitle></DialogHeader>
            <div className="space-y-2">
              <Label>Refund method</Label>
              <Select value={refundMethod} onValueChange={(v) => setRefundMethod(v as any)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="psp">PSP (back to card/bank)</SelectItem>
                  <SelectItem value="wallet">Customer wallet credit</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setRefundFor(null)}>Close</Button>
              <Button disabled={rmaRefundMut.isPending}
                onClick={() => refundFor && rmaRefundMut.mutate({ tenantId, rmaId: refundFor, method: refundMethod })}>
                Issue refund
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </DashboardLayout>
  );
}
