/**
 * W27 (Coder G): Government/NGO voucher programs — create programs, issue
 * vouchers, view the issuer settlement report and export it as CSV.
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

export default function VoucherPrograms() {
  const { activeTenantId } = useActiveTenant();
  const tenantId = activeTenantId;
  const utils = trpc.useUtils();
  const { data: programs } = trpc.vouchers.listPrograms.useQuery({ tenantId });
  const [selected, setSelected] = useState<string | null>(null);
  const { data: report } = trpc.vouchers.report.useQuery(
    { tenantId, programId: selected! },
    { enabled: !!selected },
  );

  const [issuer, setIssuer] = useState("");
  const [name, setName] = useState("");
  const [budgetMajor, setBudgetMajor] = useState("10000");
  const [phones, setPhones] = useState("");
  const [categories, setCategories] = useState("");
  const [issueAmountMajor, setIssueAmountMajor] = useState("1000");
  const [recipients, setRecipients] = useState("");

  const invalidate = () => {
    utils.vouchers.listPrograms.invalidate();
    if (selected) utils.vouchers.report.invalidate({ tenantId, programId: selected });
  };
  const onError = (e: any) => toast.error(e?.message ?? "Failed");
  const createMut = trpc.vouchers.createProgram.useMutation({
    onSuccess: () => { toast.success("Program created"); invalidate(); }, onError,
  });
  const issueMut = trpc.vouchers.issue.useMutation({
    onSuccess: (r) => { toast.success(`Issued ${r.issued.length} voucher(s), skipped ${r.skipped.length}`); invalidate(); }, onError,
  });

  const exportCsv = async () => {
    if (!selected) return;
    const { csv } = await utils.vouchers.reportCsv.fetch({ tenantId, programId: selected });
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `voucher-report-${selected}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <DashboardLayout>
      <div className="space-y-6 p-6">
        <h1 className="text-2xl font-bold">Voucher Programs (Gov / NGO)</h1>

        <Card>
          <CardHeader><CardTitle>Create program</CardTitle></CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label>Issuer</Label><Input value={issuer} onChange={(e) => setIssuer(e.target.value)} placeholder="State Ministry / NGO" />
              <Label>Program name</Label><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Food Support 2026" />
              <Label>Budget (major units)</Label><Input value={budgetMajor} onChange={(e) => setBudgetMajor(e.target.value)} inputMode="decimal" />
            </div>
            <div className="space-y-2">
              <Label>Eligible phones (comma separated; blank = all)</Label>
              <Input value={phones} onChange={(e) => setPhones(e.target.value)} placeholder="2348011111111, 2348022222222" />
              <Label>Eligible categories (comma separated; blank = all)</Label>
              <Input value={categories} onChange={(e) => setCategories(e.target.value)} placeholder="food, agri" />
              <Button
                disabled={createMut.isPending || !issuer || !name}
                onClick={() => createMut.mutate({
                  tenantId, issuer, name,
                  budgetCents: Math.round(parseFloat(budgetMajor || "0") * 100),
                  eligiblePhones: phones.trim() ? phones.split(",").map((s) => s.trim()) : null,
                  eligibleCategories: categories.trim() ? categories.split(",").map((s) => s.trim()) : null,
                })}
              >Create</Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Programs</CardTitle></CardHeader>
          <CardContent>
            <Table>
              <TableHeader><TableRow><TableHead>Name</TableHead><TableHead>Issuer</TableHead><TableHead>Budget</TableHead><TableHead>Issued</TableHead><TableHead>Redeemed</TableHead><TableHead>Status</TableHead></TableRow></TableHeader>
              <TableBody>
                {(programs ?? []).map((p: any) => (
                  <TableRow key={p.id} className="cursor-pointer" onClick={() => setSelected(p.id)}>
                    <TableCell>{p.name}</TableCell>
                    <TableCell>{p.issuer}</TableCell>
                    <TableCell>{fmt(p.budgetCents, p.currency)}</TableCell>
                    <TableCell>{fmt(p.issuedCents, p.currency)}</TableCell>
                    <TableCell>{fmt(p.redeemedCents, p.currency)}</TableCell>
                    <TableCell><Badge variant={p.status === "active" ? "default" : "secondary"}>{p.status}</Badge></TableCell>
                  </TableRow>
                ))}
                {(programs ?? []).length === 0 && <TableRow><TableCell colSpan={6}>No programs yet.</TableCell></TableRow>}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        {selected && (
          <Card>
            <CardHeader><CardTitle>Issue vouchers</CardTitle></CardHeader>
            <CardContent className="flex flex-wrap items-end gap-4">
              <div><Label>Amount per voucher (major)</Label><Input value={issueAmountMajor} onChange={(e) => setIssueAmountMajor(e.target.value)} inputMode="decimal" /></div>
              <div className="min-w-64"><Label>Recipients (comma separated phones)</Label><Input value={recipients} onChange={(e) => setRecipients(e.target.value)} /></div>
              <Button
                disabled={issueMut.isPending || !recipients.trim()}
                onClick={() => issueMut.mutate({
                  tenantId, programId: selected,
                  recipients: recipients.split(",").map((s) => s.trim()).filter(Boolean),
                  amountCents: Math.round(parseFloat(issueAmountMajor || "0") * 100),
                })}
              >Issue</Button>
            </CardContent>
          </Card>
        )}

        {report && (
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle>Issuer settlement report — {report.name}</CardTitle>
              <Button variant="outline" onClick={exportCsv}>Export CSV</Button>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-2 text-sm md:grid-cols-5">
                <div>Budget: <b>{fmt(report.budgetCents, report.currency)}</b></div>
                <div>Issued: <b>{fmt(report.issuedCents, report.currency)}</b></div>
                <div>Redeemed: <b>{fmt(report.redeemedCents, report.currency)}</b></div>
                <div>Outstanding: <b>{fmt(report.outstandingCents, report.currency)}</b></div>
                <div>Remaining budget: <b>{fmt(report.remainingBudgetCents, report.currency)}</b></div>
              </div>
              <Table>
                <TableHeader><TableRow><TableHead>Code</TableHead><TableHead>Recipient</TableHead><TableHead>Amount</TableHead><TableHead>Status</TableHead><TableHead>Order</TableHead><TableHead>Redeemed at</TableHead></TableRow></TableHeader>
                <TableBody>
                  {report.rows.map((r) => (
                    <TableRow key={r.code}>
                      <TableCell className="font-mono">{r.code}</TableCell>
                      <TableCell>{r.recipientPhone}</TableCell>
                      <TableCell>{fmt(r.amountCents, r.currency)}</TableCell>
                      <TableCell><Badge variant={r.status === "redeemed" ? "default" : "secondary"}>{r.status}</Badge></TableCell>
                      <TableCell className="font-mono">{r.orderId ?? "—"}</TableCell>
                      <TableCell>{r.redeemedAt ? new Date(r.redeemedAt).toLocaleString() : "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}
      </div>
    </DashboardLayout>
  );
}
