import { useActiveTenant } from "@/contexts/TenantContext";
import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { trpc } from "@/lib/trpc";
import { formatDistanceToNow } from "date-fns";
import { CreditCard, DollarSign, RefreshCw, XCircle } from "lucide-react";
import { useState } from "react";


const statusColors: Record<string, string> = {
  initiated: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  pending: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
  completed: "bg-green-500/20 text-green-400 border-green-500/30",
  failed: "bg-red-500/20 text-red-400 border-red-500/30",
  cancelled: "bg-gray-500/20 text-gray-400 border-gray-500/30",
  refunded: "bg-orange-500/20 text-orange-400 border-orange-500/30",
};

const providerColors: Record<string, string> = {
  stripe: "bg-violet-500/20 text-violet-400",
  mojaloop: "bg-teal-500/20 text-teal-400",
  paystack: "bg-blue-500/20 text-blue-400",
  flutterwave: "bg-orange-500/20 text-orange-400",
  manual: "bg-gray-500/20 text-gray-400",
};

export default function Payments() {
  const { activeTenantId: DEMO_TENANT } = useActiveTenant();
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const { data: paymentList, isLoading } = trpc.payment.list.useQuery({
    tenantId: DEMO_TENANT,
    status: statusFilter === "all" ? undefined : statusFilter,
    limit: 50,
  });

  const completed = paymentList?.filter((p) => p.status === "completed") ?? [];
  const failed = paymentList?.filter((p) => p.status === "failed") ?? [];
  const pending = paymentList?.filter((p) => p.status === "pending" || p.status === "initiated") ?? [];
  const totalRevenue = completed.reduce((sum, p) => sum + Number(p.amount), 0);

  return (
    <DashboardLayout>
      <div className="p-6 space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Payments</h1>
          <p className="text-muted-foreground mt-1">Payment intents, ledger reconciliation, and provider status</p>
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {[
            { label: "Total Revenue", value: `$${totalRevenue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, icon: DollarSign, color: "text-primary" },
            { label: "Completed", value: completed.length, icon: CreditCard, color: "text-green-400" },
            { label: "Pending", value: pending.length, icon: RefreshCw, color: "text-yellow-400" },
            { label: "Failed", value: failed.length, icon: XCircle, color: "text-red-400" },
          ].map((s) => (
            <Card key={s.label} className="bg-card border-border">
              <CardContent className="p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs text-muted-foreground">{s.label}</p>
                    <p className={`text-2xl font-bold mt-1 ${s.color}`}>{s.value}</p>
                  </div>
                  <s.icon className={`w-8 h-8 ${s.color} opacity-60`} />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        <div className="flex items-center gap-3">
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-48 bg-card border-border">
              <SelectValue placeholder="Filter by status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Statuses</SelectItem>
              <SelectItem value="initiated">Initiated</SelectItem>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="completed">Completed</SelectItem>
              <SelectItem value="failed">Failed</SelectItem>
              <SelectItem value="refunded">Refunded</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <Card className="bg-card border-border">
          <CardHeader><CardTitle className="text-sm font-medium text-muted-foreground">Payment Intents</CardTitle></CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow className="border-border hover:bg-transparent">
                  <TableHead>ID</TableHead>
                  <TableHead>Provider</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Idempotency Key</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-8">Loading payments...</TableCell></TableRow>
                ) : paymentList?.length === 0 ? (
                  <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-8">No payment intents found</TableCell></TableRow>
                ) : paymentList?.map((p) => (
                  <TableRow key={p.id} className="border-border hover:bg-accent/30">
                    <TableCell className="font-mono text-xs">{p.id.slice(0, 8)}...</TableCell>
                    <TableCell><Badge variant="outline" className={providerColors[p.provider] ?? ""}>{p.provider}</Badge></TableCell>
                    <TableCell><Badge variant="outline" className={statusColors[p.status] ?? ""}>{p.status}</Badge></TableCell>
                    <TableCell className="font-mono">{p.currency} {Number(p.amount).toFixed(2)}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{p.idempotencyKey.slice(0, 16)}...</TableCell>
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
