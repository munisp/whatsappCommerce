// === W55 ui-a ===
/**
 * W55 (Coder UI-A): GiftCards — merchant admin for the W44 giftCards router:
 * issue cards (integer cents), list with redeem status, per-card transaction
 * rail, disable (claim-first), and audited balance adjustment. Redemption
 * itself stays chat-side (j338/j339); this is the operator surface.
 */
import { useState } from "react";
import { useActiveTenant } from "@/contexts/TenantContext";
import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";

function fmt(cents: number, currency = "NGN") {
  return `${currency} ${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtDate(d: string | Date | null | undefined) {
  return d ? new Date(d).toLocaleString() : "—";
}

const statusVariant = (s: string) =>
  s === "active" ? "default" : s === "disabled" ? "destructive" : "secondary";

export default function GiftCards() {
  const { activeTenantId: tenantId } = useActiveTenant();
  const utils = trpc.useUtils();
  const [selectedCard, setSelectedCard] = useState<{ id: string; code: string } | null>(null);

  // Issue form
  const [amountMajor, setAmountMajor] = useState("5000");
  const [customerId, setCustomerId] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [issueNote, setIssueNote] = useState("");

  // Adjust form
  const [adjustCode, setAdjustCode] = useState("");
  const [deltaMajor, setDeltaMajor] = useState("0");
  const [adjustNote, setAdjustNote] = useState("");

  // Disable form
  const [disableCode, setDisableCode] = useState("");

  const { data: cards } = trpc.giftCards.list.useQuery({ tenantId, limit: 200 });
  const { data: txns } = trpc.giftCards.transactions.useQuery(
    { tenantId, giftCardId: selectedCard!.id, limit: 100 },
    { enabled: !!selectedCard },
  );

  const onError = (e: any) => toast.error(e?.message ?? "Failed");
  const invalidate = () => {
    utils.giftCards.list.invalidate();
    if (selectedCard) utils.giftCards.transactions.invalidate({ tenantId, giftCardId: selectedCard.id });
  };
  const issueMut = trpc.giftCards.issue.useMutation({
    onSuccess: (r: any) => {
      toast.success(`Issued card ${r.code ?? ""}`.trim());
      setCustomerId(""); setExpiresAt(""); setIssueNote("");
      invalidate();
    },
    onError,
  });
  const disableMut = trpc.giftCards.disable.useMutation({
    onSuccess: () => { toast.success("Card disabled"); setDisableCode(""); invalidate(); }, onError,
  });
  const adjustMut = trpc.giftCards.adjust.useMutation({
    onSuccess: () => { toast.success("Balance adjusted"); setAdjustCode(""); setDeltaMajor("0"); setAdjustNote(""); invalidate(); }, onError,
  });

  return (
    <DashboardLayout>
      <div className="space-y-6 p-6">
        <h1 className="text-2xl font-bold">Gift Cards</h1>

        <Card>
          <CardHeader><CardTitle>Issue a card</CardTitle></CardHeader>
          <CardContent className="flex flex-wrap items-end gap-4">
            <div><Label>Amount (major units)</Label><Input value={amountMajor} onChange={(e) => setAmountMajor(e.target.value)} inputMode="decimal" /></div>
            <div className="min-w-56"><Label>Customer ID (optional)</Label><Input value={customerId} onChange={(e) => setCustomerId(e.target.value)} /></div>
            <div><Label>Expires at (optional)</Label><Input type="datetime-local" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} /></div>
            <div className="min-w-56"><Label>Note (optional)</Label><Input value={issueNote} onChange={(e) => setIssueNote(e.target.value)} /></div>
            <Button
              disabled={issueMut.isPending || !(parseFloat(amountMajor) > 0)}
              onClick={() => issueMut.mutate({
                tenantId,
                amountCents: Math.round(parseFloat(amountMajor || "0") * 100),
                customerId: customerId.trim() || undefined,
                expiresAt: expiresAt ? new Date(expiresAt).toISOString() : undefined,
                note: issueNote || undefined,
              })}
            >Issue</Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Cards</CardTitle></CardHeader>
          <CardContent>
            <Table>
              <TableHeader><TableRow><TableHead>Code</TableHead><TableHead>Balance</TableHead><TableHead>Initial</TableHead><TableHead>Customer</TableHead><TableHead>Status</TableHead><TableHead>Expires</TableHead><TableHead>Actions</TableHead></TableRow></TableHeader>
              <TableBody>
                {(cards ?? []).map((c: any) => (
                  <TableRow key={c.id} className={selectedCard?.id === c.id ? "bg-muted/50" : "cursor-pointer"}
                    onClick={() => setSelectedCard({ id: c.id, code: c.code })}>
                    <TableCell className="font-mono">{c.code}</TableCell>
                    <TableCell>{fmt(c.balanceCents, c.currency)}</TableCell>
                    <TableCell>{fmt(c.initialBalanceCents, c.currency)}</TableCell>
                    <TableCell className="font-mono">{c.purchaserCustomerId ?? "—"}</TableCell>
                    <TableCell><Badge variant={statusVariant(c.status)}>{c.status}</Badge></TableCell>
                    <TableCell>{fmtDate(c.expiresAt)}</TableCell>
                    <TableCell className="space-x-2" onClick={(e) => e.stopPropagation()}>
                      {c.status !== "disabled" && (
                        <Button size="sm" variant="destructive" disabled={disableMut.isPending}
                          onClick={() => disableMut.mutate({ tenantId, code: c.code })}>Disable</Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
                {(cards ?? []).length === 0 && <TableRow><TableCell colSpan={7}>No gift cards yet.</TableCell></TableRow>}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Adjust balance (audited)</CardTitle></CardHeader>
          <CardContent className="flex flex-wrap items-end gap-4">
            <div className="min-w-56">
              <Label>Card code</Label>
              <Input value={adjustCode} onChange={(e) => setAdjustCode(e.target.value)} placeholder={selectedCard?.code ?? "card code"} />
            </div>
            <div><Label>Delta (major units, signed)</Label><Input value={deltaMajor} onChange={(e) => setDeltaMajor(e.target.value)} inputMode="decimal" /></div>
            <div className="min-w-64"><Label>Note (required)</Label><Input value={adjustNote} onChange={(e) => setAdjustNote(e.target.value)} /></div>
            <Button
              disabled={adjustMut.isPending || adjustCode.trim().length < 4 || !adjustNote.trim() || !parseFloat(deltaMajor || "0")}
              onClick={() => adjustMut.mutate({
                tenantId,
                code: adjustCode.trim(),
                deltaCents: Math.round(parseFloat(deltaMajor || "0") * 100),
                note: adjustNote.trim(),
              })}
            >Apply adjustment</Button>
          </CardContent>
        </Card>

        {selectedCard && txns && (
          <Card>
            <CardHeader><CardTitle>Transactions — {selectedCard.code}</CardTitle></CardHeader>
            <CardContent>
              <Table>
                <TableHeader><TableRow><TableHead>Type</TableHead><TableHead>Amount</TableHead><TableHead>Order</TableHead><TableHead>Note</TableHead><TableHead>When</TableHead></TableRow></TableHeader>
                <TableBody>
                  {(txns as any[]).map((t: any) => (
                    <TableRow key={t.id}>
                      <TableCell><Badge variant="secondary">{t.type}</Badge></TableCell>
                      <TableCell>{fmt(t.amountCents)}</TableCell>
                      <TableCell className="font-mono">{t.orderId ?? "—"}</TableCell>
                      <TableCell>{t.note ?? "—"}</TableCell>
                      <TableCell>{fmtDate(t.createdAt)}</TableCell>
                    </TableRow>
                  ))}
                  {(txns as any[]).length === 0 && <TableRow><TableCell colSpan={5}>No transactions.</TableCell></TableRow>}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}
      </div>
    </DashboardLayout>
  );
}
// === END W55 ui-a ===
