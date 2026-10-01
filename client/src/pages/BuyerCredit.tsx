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
import { CreditCard } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

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

        <Card className="bg-card border-border">
          <CardHeader><CardTitle className="text-sm font-medium text-muted-foreground">Installment plans</CardTitle></CardHeader>
          <CardContent className="p-0">
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
