// === W27 bookkeeping ===
// Tenant portal bookkeeping dashboard: daily/weekly sales summaries,
// expense records, digest opt-in, and tax-ready CSV/PDF export.
import { useState } from "react";
import { TenantPortalLayout } from "@/components/TenantPortalLayout";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

function fmt(cents: number): string {
  return `₦${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

function todayKey(offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 24 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

function download(filename: string, content: string, mime: string) {
  const blob = mime === "application/pdf"
    ? new Blob([Uint8Array.from(atob(content), (c) => c.charCodeAt(0))], { type: mime })
    : new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function PortalBookkeeping() {
  const [frequency, setFrequency] = useState<"daily" | "weekly">("weekly");
  const [from, setFrom] = useState(todayKey(-30));
  const [to, setTo] = useState(todayKey());
  const [expAmount, setExpAmount] = useState("");
  const [expVendor, setExpVendor] = useState("");
  const [expCategory, setExpCategory] = useState("general");

  const utils = trpc.useUtils();
  const { data: summary } = trpc.bookkeeping.summary.useQuery({ frequency });
  const { data: expenseRows } = trpc.bookkeeping.expenses.list.useQuery({ from, to });
  const { data: exportData } = trpc.bookkeeping.export.data.useQuery({ from, to });

  const addExpense = trpc.bookkeeping.expenses.add.useMutation({
    onSuccess: () => {
      setExpAmount(""); setExpVendor("");
      utils.bookkeeping.expenses.list.invalidate();
      utils.bookkeeping.export.data.invalidate();
    },
  });
  const removeExpense = trpc.bookkeeping.expenses.remove.useMutation({
    onSuccess: () => {
      utils.bookkeeping.expenses.list.invalidate();
      utils.bookkeeping.export.data.invalidate();
    },
  });
  const csvQuery = trpc.bookkeeping.export.csv.useQuery({ from, to }, { enabled: false });
  const pdfQuery = trpc.bookkeeping.export.pdf.useQuery({ from, to }, { enabled: false });

  const changePct = summary?.changePct;

  return (
    <TenantPortalLayout>
      <div className="space-y-6">
        <h1 className="text-2xl font-bold text-white">Bookkeeping</h1>

        {/* ── Sales summary ─────────────────────────────────────────── */}
        <div className="flex gap-2">
          {(["daily", "weekly"] as const).map((f) => (
            <Button key={f} variant={frequency === f ? "default" : "outline"} size="sm" onClick={() => setFrequency(f)}>
              {f === "daily" ? "Today" : "This week"}
            </Button>
          ))}
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Card className="bg-slate-800 border-slate-700">
            <CardHeader><CardTitle className="text-slate-300 text-sm">Sales ({frequency})</CardTitle></CardHeader>
            <CardContent>
              <p className="text-2xl font-bold text-emerald-400">{fmt(summary?.salesCents ?? 0)}</p>
              <p className="text-xs text-slate-400 mt-1">{summary?.orderCount ?? 0} orders</p>
            </CardContent>
          </Card>
          <Card className="bg-slate-800 border-slate-700">
            <CardHeader><CardTitle className="text-slate-300 text-sm">vs previous {frequency === "daily" ? "day" : "week"}</CardTitle></CardHeader>
            <CardContent>
              <p className={`text-2xl font-bold ${changePct == null ? "text-slate-400" : changePct >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                {changePct == null ? "—" : `${changePct >= 0 ? "+" : ""}${changePct}%`}
              </p>
              <p className="text-xs text-slate-400 mt-1">{fmt(summary?.prevSalesCents ?? 0)} previous</p>
            </CardContent>
          </Card>
          <Card className="bg-slate-800 border-slate-700">
            <CardHeader><CardTitle className="text-slate-300 text-sm">Digest message</CardTitle></CardHeader>
            <CardContent><p className="text-sm text-slate-300">{summary?.message ?? "…"}</p></CardContent>
          </Card>
        </div>

        {/* ── Expenses ──────────────────────────────────────────────── */}
        <Card className="bg-slate-800 border-slate-700">
          <CardHeader><CardTitle className="text-slate-200">Expenses</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap gap-2 items-center">
              <input className="bg-slate-900 border border-slate-700 rounded px-3 py-1.5 text-sm text-white w-32"
                placeholder="Amount (₦)" value={expAmount} onChange={(e) => setExpAmount(e.target.value)} />
              <input className="bg-slate-900 border border-slate-700 rounded px-3 py-1.5 text-sm text-white w-48"
                placeholder="Vendor" value={expVendor} onChange={(e) => setExpVendor(e.target.value)} />
              <select className="bg-slate-900 border border-slate-700 rounded px-3 py-1.5 text-sm text-white"
                value={expCategory} onChange={(e) => setExpCategory(e.target.value)}>
                {["stock", "transport", "rent", "utilities", "wages", "packaging", "marketing", "fees", "general"].map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
              <Button size="sm" disabled={!expAmount || addExpense.isPending}
                onClick={() => addExpense.mutate({ amount: expAmount, vendor: expVendor || undefined, category: expCategory })}>
                Add expense
              </Button>
              <p className="text-xs text-slate-500">…or WhatsApp a receipt photo: text "expense", then send the photo.</p>
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-700 text-slate-400 text-xs">
                  <th className="text-left p-2">Date</th>
                  <th className="text-left p-2">Vendor</th>
                  <th className="text-left p-2">Category</th>
                  <th className="text-left p-2">Source</th>
                  <th className="text-left p-2">Status</th>
                  <th className="text-right p-2">Amount</th>
                  <th className="p-2" />
                </tr>
              </thead>
              <tbody>
                {(expenseRows ?? []).map((x: any) => (
                  <tr key={x.id} className="border-b border-slate-700/50">
                    <td className="p-2 text-slate-300">{new Date(x.expenseDate).toISOString().slice(0, 10)}</td>
                    <td className="p-2 text-slate-300">{x.vendor ?? "—"}</td>
                    <td className="p-2 text-slate-400 capitalize">{x.category}</td>
                    <td className="p-2 text-slate-500 text-xs">{x.source === "receipt_photo" ? "📷 receipt" : "manual"}</td>
                    <td className="p-2"><Badge className="text-xs">{x.status}</Badge></td>
                    <td className="p-2 text-right text-red-300">{fmt(x.amountCents)}</td>
                    <td className="p-2 text-right">
                      <button className="text-xs text-slate-500 hover:text-red-400"
                        onClick={() => removeExpense.mutate({ id: x.id })}>delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!expenseRows?.length && <p className="text-center text-slate-500 py-6">No expenses in this period</p>}
          </CardContent>
        </Card>

        {/* ── Tax-ready export ──────────────────────────────────────── */}
        <Card className="bg-slate-800 border-slate-700">
          <CardHeader><CardTitle className="text-slate-200">Tax-ready export</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap gap-2 items-center">
              <input type="date" className="bg-slate-900 border border-slate-700 rounded px-3 py-1.5 text-sm text-white"
                value={from} onChange={(e) => setFrom(e.target.value)} />
              <span className="text-slate-500 text-sm">to</span>
              <input type="date" className="bg-slate-900 border border-slate-700 rounded px-3 py-1.5 text-sm text-white"
                value={to} onChange={(e) => setTo(e.target.value)} />
              <Button size="sm" variant="outline" onClick={async () => {
                const r = await csvQuery.refetch();
                if (r.data) download(r.data.filename, r.data.csv, "text/csv");
              }}>Download CSV</Button>
              <Button size="sm" variant="outline" onClick={async () => {
                const r = await pdfQuery.refetch();
                if (r.data) download(r.data.filename, r.data.pdfBase64, "application/pdf");
              }}>Download PDF</Button>
            </div>
            {exportData && (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
                <div className="bg-slate-900 rounded p-4">
                  <p className="text-slate-400 text-xs">Total sales</p>
                  <p className="text-emerald-400 font-bold text-lg">{fmt(exportData.totalSalesCents)}</p>
                </div>
                <div className="bg-slate-900 rounded p-4">
                  <p className="text-slate-400 text-xs">Total expenses</p>
                  <p className="text-red-300 font-bold text-lg">{fmt(exportData.totalExpensesCents)}</p>
                </div>
                <div className="bg-slate-900 rounded p-4">
                  <p className="text-slate-400 text-xs">Net income</p>
                  <p className="text-white font-bold text-lg">{fmt(exportData.netCents)}</p>
                  <p className="text-slate-500 text-xs mt-1">Formalization-friendly summary for banks / MFIs</p>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </TenantPortalLayout>
  );
}
