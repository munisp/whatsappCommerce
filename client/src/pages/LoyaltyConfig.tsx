/**
 * W27: Loyalty configuration — earn/burn rules, customer balances and the
 * points ledger.
 */
import { useEffect, useState } from "react";
import { useActiveTenant } from "@/contexts/TenantContext";
import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { Gift } from "lucide-react";

export default function LoyaltyConfig() {
  const { activeTenantId: tenantId } = useActiveTenant();
  const utils = trpc.useUtils();
  const { data: rules } = trpc.loyalty.getRules.useQuery({ tenantId });
  const { data: ledger } = trpc.loyalty.ledger.useQuery({ tenantId, limit: 100 });

  const [form, setForm] = useState({ enabled: true, pointsPerUnit: 1, unitValueNaira: 100, pointsValueNaira: 1, redemptionCapPercent: 20 });
  useEffect(() => {
    if (rules) {
      setForm({
        enabled: rules.enabled,
        pointsPerUnit: rules.pointsPerUnit,
        unitValueNaira: rules.unitValueCents / 100,
        pointsValueNaira: rules.pointsValueCents / 100,
        redemptionCapPercent: rules.redemptionCapPercent,
      });
    }
  }, [rules]);

  const saveMut = trpc.loyalty.setRules.useMutation({
    onSuccess: () => { utils.loyalty.getRules.invalidate(); toast.success("Loyalty rules saved"); },
    onError: (e) => toast.error(e?.message ?? "Save failed"),
  });

  const [phone, setPhone] = useState("");
  const balanceQuery = trpc.loyalty.balance.useQuery({ tenantId, customerPhone: phone }, { enabled: false });

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <h1 className="text-2xl font-bold flex items-center gap-2"><Gift className="h-6 w-6" /> Loyalty</h1>

        <div className="grid gap-4 md:grid-cols-2">
          <Card>
            <CardHeader><CardTitle>Earn & burn rules</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center justify-between">
                <Label>Program enabled</Label>
                <Switch checked={form.enabled} onCheckedChange={(v) => setForm({ ...form, enabled: v })} />
              </div>
              <Label>Earn: points per ₦{form.unitValueNaira} spent</Label>
              <Input type="number" value={form.pointsPerUnit}
                onChange={(e) => setForm({ ...form, pointsPerUnit: Number(e.target.value) || 0 })} />
              <Label>Spend unit (₦)</Label>
              <Input type="number" value={form.unitValueNaira}
                onChange={(e) => setForm({ ...form, unitValueNaira: Number(e.target.value) || 0 })} />
              <Label>Point value at redemption (₦)</Label>
              <Input type="number" value={form.pointsValueNaira}
                onChange={(e) => setForm({ ...form, pointsValueNaira: Number(e.target.value) || 0 })} />
              <Label>Redemption cap (% of order total)</Label>
              <Input type="number" value={form.redemptionCapPercent}
                onChange={(e) => setForm({ ...form, redemptionCapPercent: Number(e.target.value) || 0 })} />
              <Button onClick={() => saveMut.mutate({
                tenantId,
                enabled: form.enabled,
                pointsPerUnit: Math.floor(form.pointsPerUnit),
                unitValueCents: Math.round(form.unitValueNaira * 100),
                pointsValueCents: Math.round(form.pointsValueNaira * 100),
                redemptionCapPercent: Math.floor(form.redemptionCapPercent),
              })} disabled={saveMut.isPending}>
                Save rules
              </Button>
              <p className="text-xs text-muted-foreground">
                Buyers check their balance with “POINTS” on WhatsApp and redeem at checkout with “redeem points”.
                Points vest when orders are delivered.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Customer balance lookup</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <Label>WhatsApp phone</Label>
              <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="2348012345678" />
              <Button variant="secondary" onClick={() => balanceQuery.refetch()} disabled={!phone}>
                Check balance
              </Button>
              {balanceQuery.data && (
                <p className="text-sm">Balance: <b>{balanceQuery.data.balance}</b> points</p>
              )}
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader><CardTitle>Points ledger</CardTitle></CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead><TableHead>Customer</TableHead><TableHead>Type</TableHead>
                  <TableHead>Points</TableHead><TableHead>Balance</TableHead><TableHead>Reason</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(ledger ?? []).map((e: any) => (
                  <TableRow key={e.id}>
                    <TableCell className="text-xs">{new Date(e.createdAt).toLocaleString()}</TableCell>
                    <TableCell>{e.customerPhone}</TableCell>
                    <TableCell>
                      <Badge variant={e.entryType === "earn" ? "default" : e.entryType === "redeem" ? "destructive" : "outline"}>
                        {e.entryType}
                      </Badge>
                    </TableCell>
                    <TableCell>{e.entryType === "redeem" ? `−${e.points}` : `+${e.points}`}</TableCell>
                    <TableCell>{e.balanceAfter}</TableCell>
                    <TableCell className="text-xs">{e.reason}</TableCell>
                  </TableRow>
                ))}
                {(ledger ?? []).length === 0 && (
                  <TableRow><TableCell colSpan={6} className="text-muted-foreground">No points movements yet.</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
