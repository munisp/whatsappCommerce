// === W55 ui-c ===
// Buyer installment credit surface for the W41 buyerCredit router
// (ORPHAN-BE-21): merchant opt-in + threshold config, and the tenant's
// installment plan book.
import { useActiveTenant } from "@/contexts/TenantContext";
import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { trpc } from "@/lib/trpc";
import { formatDistanceToNow } from "date-fns";
import { CreditCard, HandCoins, CalendarClock, Percent } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
// === W56 credit ===
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
// === END W56 credit ===

const INSTALLMENT_CHOICES = [2, 3, 4, 6];

const planStatusColors: Record<string, string> = {
  pending_down: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
  active: "bg-green-500/20 text-green-400 border-green-500/30",
  completed: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  defaulted: "bg-red-500/20 text-red-400 border-red-500/30",
  cancelled: "bg-gray-500/20 text-gray-400 border-gray-500/30",
};

function fmtMoney(cents: number, currency: string) {
  return `${currency} ${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// === W56 credit ===
/**
 * Credit servicing card (Feature 3): mid-flight adjustments on trade-credit
 * facilities and pay-over-time plans. All actions go through the
 * money-guarded creditServicing router (reason mandatory; large reschedules
 * may park for approval server-side and surface pendingApproval honestly).
 */
function ServicingCard({ tenantId }: { tenantId: string }) {
  const utils = trpc.useUtils();
  const accountsQ = trpc.tradeCredit.listAccounts.useQuery({ supplierTenantId: tenantId }, { enabled: !!tenantId });
  const plansQ = trpc.vendorBills.installmentPlans.useQuery({ tenantId }, { enabled: !!tenantId });

  const [feeOpen, setFeeOpen] = useState(false);
  const [graceOpen, setGraceOpen] = useState(false);
  const [reschedOpen, setReschedOpen] = useState(false);
  const [accountId, setAccountId] = useState("");
  const [newFeeBps, setNewFeeBps] = useState("");
  const [feeReason, setFeeReason] = useState("");
  const [graceDays, setGraceDays] = useState("7");
  const [graceReason, setGraceReason] = useState("");
  const [planId, setPlanId] = useState("");
  const [shiftDays, setShiftDays] = useState("14");
  const [reschedReason, setReschedReason] = useState("");

  const accounts = (accountsQ.data ?? []) as any[];
  const activePlans = useMemo(
    () => ((plansQ.data ?? []) as any[]).filter((p) => p.status === "active"),
    [plansQ.data],
  );
  const selectedAccount = accounts.find((a) => a.id === accountId);

  const feeMut = trpc.creditServicing.adjustFee.useMutation({
    onSuccess: (r) => {
      toast.success(r.unchanged ? "Fee already at that value" : `Fee updated ${r.oldFeeBps ?? 0} → ${r.newFeeBps} bps (future draws only)`);
      setFeeOpen(false); setFeeReason("");
      utils.tradeCredit.listAccounts.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });
  const graceMut = trpc.creditServicing.gracePeriod.useMutation({
    onSuccess: (r) => {
      toast.success(`Grace +${r.days}d applied to ${r.extended} open draw(s)`);
      setGraceOpen(false); setGraceReason("");
    },
    onError: (e) => toast.error(e.message),
  });
  const reschedMut = trpc.creditServicing.reschedule.useMutation({
    onSuccess: (r) => {
      if ((r as any).pendingApproval) {
        toast.info("Reschedule parked for owner approval (threshold policy)");
      } else {
        toast.success(`Plan rescheduled (${(r as any).rescheduledCount} slice(s), fee delta ${((r as any).feeDeltaCents / 100).toFixed(2)})`);
      }
      setReschedOpen(false); setReschedReason("");
      utils.vendorBills.installmentPlans.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <Card className="bg-card border-border">
      <CardHeader><CardTitle className="text-sm font-medium text-muted-foreground">Credit servicing (adjust fee / grace / reschedule)</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Button variant="outline" onClick={() => setFeeOpen(true)}>
            <Percent className="w-4 h-4 mr-2" /> Adjust facility fee
          </Button>
          <Button variant="outline" onClick={() => setGraceOpen(true)}>
            <HandCoins className="w-4 h-4 mr-2" /> Grant grace period
          </Button>
          <Button variant="outline" onClick={() => setReschedOpen(true)}>
            <CalendarClock className="w-4 h-4 mr-2" /> Reschedule plan
          </Button>
        </div>

        {/* Adjust fee — current vs new, reason required, future-only */}
        <Dialog open={feeOpen} onOpenChange={setFeeOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Adjust facility fee</DialogTitle>
              <DialogDescription>Applies to future draws/accruals only — settled ledger rows are never rewritten.</DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <div className="space-y-1">
                <Label>Credit account</Label>
                <select className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                  <option value="">Select account…</option>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>{a.id.slice(0, 8)}… — fee {a.feeBps ?? 0} bps — {a.status}</option>
                  ))}
                </select>
              </div>
              {selectedAccount && (
                <p className="text-sm text-muted-foreground">Current fee: <span className="font-mono">{selectedAccount.feeBps ?? 0} bps</span></p>
              )}
              <div className="space-y-1">
                <Label>New fee (bps)</Label>
                <Input type="number" min="0" max="10000" value={newFeeBps} onChange={(e) => setNewFeeBps(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label>Reason (required)</Label>
                <Textarea value={feeReason} onChange={(e) => setFeeReason(e.target.value)} maxLength={255} />
              </div>
            </div>
            <DialogFooter>
              <Button
                disabled={feeMut.isPending || !accountId || !feeReason.trim() || newFeeBps === ""}
                onClick={() => feeMut.mutate({ tenantId, accountId, newFeeBps: Math.round(Number(newFeeBps)), reason: feeReason.trim() })}
              >
                Apply fee
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Grace period */}
        <Dialog open={graceOpen} onOpenChange={setGraceOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Grant grace period</DialogTitle>
              <DialogDescription>Extends due dates on open draws — rows are never voided; dunning respects the new dates.</DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <div className="space-y-1">
                <Label>Credit account</Label>
                <select className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                  <option value="">Select account…</option>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>{a.id.slice(0, 8)}… — {a.status}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <Label>Extra days (1–90)</Label>
                <Input type="number" min="1" max="90" value={graceDays} onChange={(e) => setGraceDays(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label>Reason (required)</Label>
                <Textarea value={graceReason} onChange={(e) => setGraceReason(e.target.value)} maxLength={255} />
              </div>
            </div>
            <DialogFooter>
              <Button
                disabled={graceMut.isPending || !accountId || !graceReason.trim()}
                onClick={() => graceMut.mutate({ tenantId, accountId, days: Math.round(Number(graceDays)), reason: graceReason.trim() })}
              >
                Grant grace
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Reschedule plan (grace-shift of future installments) */}
        <Dialog open={reschedOpen} onOpenChange={setReschedOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Reschedule installment plan</DialogTitle>
              <DialogDescription>Shifts all future unpaid installments; large changes park for owner approval automatically.</DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <div className="space-y-1">
                <Label>Active plan</Label>
                <select className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm" value={planId} onChange={(e) => setPlanId(e.target.value)}>
                  <option value="">Select plan…</option>
                  {activePlans.map((p) => (
                    <option key={p.id} value={p.id}>{p.id.slice(0, 8)}… — {p.installments}× {fmtMoney(p.perInstallmentCents, p.currency)}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <Label>Shift future installments by (days, 1–90)</Label>
                <Input type="number" min="1" max="90" value={shiftDays} onChange={(e) => setShiftDays(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label>Reason (required)</Label>
                <Textarea value={reschedReason} onChange={(e) => setReschedReason(e.target.value)} maxLength={255} />
              </div>
            </div>
            <DialogFooter>
              <Button
                disabled={reschedMut.isPending || !planId || !reschedReason.trim()}
                onClick={() => reschedMut.mutate({ tenantId, planId, graceDays: Math.round(Number(shiftDays)), reason: reschedReason.trim() })}
              >
                Reschedule
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}
// === END W56 credit ===

export default function BuyerCredit() {
  const { activeTenantId: tenantId } = useActiveTenant();
  const utils = trpc.useUtils();

  const { data: config, isLoading: configLoading } = trpc.buyerCredit.getInstallmentConfig.useQuery({ tenantId });
  const { data: plans, isLoading: plansLoading } = trpc.buyerCredit.listPlans.useQuery({ tenantId });

  const [enabled, setEnabled] = useState(false);
  const [minTotalNaira, setMinTotalNaira] = useState("0");
  const [choices, setChoices] = useState<number[]>([2, 3, 4, 6]);

  useEffect(() => {
    if (config) {
      setEnabled(config.enabled);
      setMinTotalNaira(((config.minTotalCents ?? 0) / 100).toString());
      setChoices(config.choices?.length ? config.choices : [2, 3, 4, 6]);
    }
  }, [config]);

  const saveMut = trpc.buyerCredit.setInstallmentConfig.useMutation({
    onSuccess: (r) => {
      toast.success(r.enabled ? "Buyer installments enabled" : "Buyer installments disabled");
      utils.buyerCredit.getInstallmentConfig.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const save = () => {
    const minTotalCents = Math.round(Number(minTotalNaira) * 100);
    if (!Number.isFinite(minTotalCents) || minTotalCents < 0) {
      toast.error("Enter a valid minimum order total");
      return;
    }
    saveMut.mutate({ tenantId, enabled, minTotalCents, choices });
  };

  return (
    <DashboardLayout>
      <div className="p-6 space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Buyer Credit</h1>
          <p className="text-muted-foreground mt-1">Installment (buy-now-pay-later) opt-in and plan book</p>
        </div>

        <Card className="bg-card border-border">
          <CardHeader><CardTitle className="text-sm font-medium text-muted-foreground">Installment configuration</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            {configLoading ? (
              <p className="text-sm text-muted-foreground">Loading...</p>
            ) : (
              <>
                <div className="flex items-center gap-3">
                  <Switch checked={enabled} onCheckedChange={setEnabled} />
                  <div>
                    <p className="text-sm font-medium">Offer installments to buyers</p>
                    <p className="text-xs text-muted-foreground">
                      Orders with an unpaid plan cannot enter fulfilment until fully paid.
                    </p>
                  </div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-xl">
                  <div className="space-y-2">
                    <Label>Minimum order total (NGN)</Label>
                    <Input type="number" min="0" step="0.01" value={minTotalNaira} onChange={(e) => setMinTotalNaira(e.target.value)} />
                  </div>
                  <div className="space-y-2">
                    <Label>Installment counts offered</Label>
                    <div className="flex items-center gap-4 pt-2">
                      {INSTALLMENT_CHOICES.map((n) => (
                        <label key={n} className="flex items-center gap-1.5 text-sm">
                          <Checkbox
                            checked={choices.includes(n)}
                            onCheckedChange={() =>
                              setChoices((c) => (c.includes(n) ? c.filter((x) => x !== n) : [...c, n].sort((a, b) => a - b)))
                            }
                          />
                          {n}×
                        </label>
                      ))}
                    </div>
                  </div>
                </div>
                <Button onClick={save} disabled={saveMut.isPending}>Save configuration</Button>
              </>
            )}
          </CardContent>
        </Card>

        {/* === W56 credit === servicing actions (adjust fee / grace / reschedule) */}
        <ServicingCard tenantId={tenantId} />

        <Card className="bg-card border-border">
          <CardHeader><CardTitle className="text-sm font-medium text-muted-foreground">Installment plans</CardTitle></CardHeader>          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow className="border-border hover:bg-transparent">
                  <TableHead>Order</TableHead>
                  <TableHead>Buyer</TableHead>
                  <TableHead>Total</TableHead>
                  <TableHead>Down payment</TableHead>
                  <TableHead>Parts</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {plansLoading ? (
                  <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground py-8">Loading...</TableCell></TableRow>
                ) : !plans?.length ? (
                  <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground py-8">
                    <div className="flex flex-col items-center gap-2">
                      <CreditCard className="w-8 h-8 opacity-40" />
                      No installment plans
                    </div>
                  </TableCell></TableRow>
                ) : plans.map((p) => (
                  <TableRow key={p.id} className="border-border hover:bg-accent/30">
                    <TableCell className="font-mono text-xs">{p.orderId.slice(0, 8)}...</TableCell>
                    <TableCell className="font-mono text-xs">{p.buyerPhone}</TableCell>
                    <TableCell className="font-mono">{fmtMoney(p.totalCents, p.currency)}</TableCell>
                    <TableCell className="font-mono">
                      {fmtMoney(p.downPaymentCents, p.currency)}
                      {p.downPaymentPaidAt && <span className="block text-[10px] text-green-400">paid</span>}
                    </TableCell>
                    <TableCell className="text-sm">{p.installments}×</TableCell>
                    <TableCell><Badge variant="outline" className={planStatusColors[p.status] ?? ""}>{p.status.replaceAll("_", " ")}</Badge></TableCell>
                    <TableCell className="text-muted-foreground text-xs">{formatDistanceToNow(new Date(p.createdAt), { addSuffix: true })}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
