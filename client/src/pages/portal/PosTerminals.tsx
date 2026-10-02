// === W59 banking-pos ===
/**
 * POS terminals page: terminal registry (register/disable) + payment session
 * creation (USSD short code + QR payload) and recent session statuses.
 */
import { trpc } from "@/lib/trpc";
import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { useState } from "react";

const fmt = (cents: number) => `NGN ${(cents / 100).toLocaleString("en-NG", { minimumFractionDigits: 2 })}`;

export default function PosTerminals() {
  const { data: myTenant } = trpc.tenantPortal.getMyTenant.useQuery();
  const tenantId = myTenant?.id ?? "";
  const { data: terminals, refetch: refetchTerminals } = trpc.posPayments.listTerminals.useQuery({ tenantId }, { enabled: !!tenantId });
  const { data: sessions, refetch: refetchSessions } = trpc.posPayments.listSessions.useQuery({ tenantId, limit: 50 }, { enabled: !!tenantId });
  const [terminalRef, setTerminalRef] = useState("");
  const [label, setLabel] = useState("");
  const [provider, setProvider] = useState<"paystack" | "flutterwave" | "softpos">("softpos");
  const [amount, setAmount] = useState("");
  const register = trpc.posPayments.registerTerminal.useMutation({
    onSuccess: (r) => { toast.success(r.duplicate ? "Terminal already registered." : "Terminal registered."); setTerminalRef(""); refetchTerminals(); },
    onError: (e) => toast.error(e.message),
  });
  const setStatus = trpc.posPayments.setTerminalStatus.useMutation({
    onSuccess: () => refetchTerminals(),
    onError: (e) => toast.error(e.message),
  });
  const createSession = trpc.posPayments.createSession.useMutation({
    onSuccess: (s) => {
      toast.success(`Session ${s.reference} — USSD code ${s.ussdCode}`);
      refetchSessions();
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <DashboardLayout>
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">POS Terminals</h1>
        <Card>
          <CardHeader><CardTitle>Registry</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {(terminals ?? []).map((t: any) => (
              <div key={t.id} className="flex items-center justify-between border-b pb-1 text-sm">
                <span>{t.label ?? t.terminalRef} <span className="text-muted-foreground">({t.provider} · {t.terminalRef})</span></span>
                <div className="flex gap-2 items-center">
                  <Badge variant={t.status === "active" ? "default" : "outline"}>{t.status}</Badge>
                  <Button size="sm" variant="ghost"
                    onClick={() => setStatus.mutate({ tenantId, terminalId: t.id, status: t.status === "active" ? "disabled" : "active" })}>
                    {t.status === "active" ? "Disable" : "Enable"}
                  </Button>
                </div>
              </div>
            ))}
            <div className="flex flex-wrap items-end gap-2 pt-2">
              <div><Label htmlFor="w59-tref">Terminal ref</Label><Input id="w59-tref" value={terminalRef} onChange={(e) => setTerminalRef(e.target.value)} /></div>
              <div><Label htmlFor="w59-tlabel">Label</Label><Input id="w59-tlabel" value={label} onChange={(e) => setLabel(e.target.value)} /></div>
              <div>
                <Label htmlFor="w59-tprov">Provider</Label>
                <select id="w59-tprov" className="border rounded px-2 py-2 text-sm" value={provider} onChange={(e) => setProvider(e.target.value as typeof provider)}>
                  <option value="softpos">SoftPOS</option>
                  <option value="paystack">Paystack</option>
                  <option value="flutterwave">Flutterwave</option>
                </select>
              </div>
              <Button disabled={!terminalRef || register.isPending}
                onClick={() => register.mutate({ tenantId, provider, terminalRef, label: label || undefined })}>Register</Button>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>New payment session</CardTitle></CardHeader>
          <CardContent className="flex flex-wrap items-end gap-3">
            <div><Label htmlFor="w59-pos-amt">Amount (NGN)</Label><Input id="w59-pos-amt" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" /></div>
            <Button disabled={createSession.isPending}
              onClick={() => {
                const amountCents = Math.round(parseFloat(amount) * 100);
                if (!Number.isInteger(amountCents) || amountCents <= 0) { toast.error("Enter a valid amount."); return; }
                createSession.mutate({ tenantId, amountCents, channel: "ussd_ref" });
              }}>Create session</Button>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Recent sessions</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {(sessions ?? []).map((s: any) => (
              <div key={s.id} className="flex justify-between border-b pb-1 text-sm">
                <span>{s.reference}</span>
                <span>{fmt(s.amountCents)} · {s.channel}</span>
                <Badge variant={s.status === "charged" ? "default" : "outline"}>{s.status}</Badge>
              </div>
            ))}
            {(sessions ?? []).length === 0 && <p className="text-sm text-muted-foreground">No sessions yet.</p>}
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
// === END W59 banking-pos ===
