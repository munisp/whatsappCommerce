/**
 * CreditDashboard — W27 merchant credit workspace (route /credit).
 *
 * Score gauge (0-1000 SVG arc) + factor breakdown, micro-loan offers with
 * accept flow, active/past loans with the derived repayment schedule and a
 * manual repay action, and signed credit-certificate download (JSON + HTML,
 * print-to-PDF from the browser) for banks/MFIs. All via the tenant-guarded
 * credit.* tRPC router; money arrives as integer cents.
 */
import { useMemo, useState } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useActiveTenant } from "@/contexts/TenantContext";
import { trpc } from "@/lib/trpc";
import { Award, Download, HandCoins, Loader2, RefreshCw, TrendingUp } from "lucide-react";
import { toast } from "sonner";

// ─── Helpers ────────────────────────────────────────────────────────────────

function fmtCents(cents: number, currency = "NGN"): string {
  const sym: Record<string, string> = { NGN: "₦", USD: "$", GHS: "GH₵", KES: "KSh " };
  return `${sym[currency] ?? `${currency} `}${(cents / 100).toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtDate(d: string | Date | null | undefined): string {
  if (!d) return "—";
  return new Date(d).toISOString().slice(0, 10);
}

const FACTOR_LABELS: [string, string][] = [
  ["orderVolume", "Order volume"],
  ["completionRate", "Completion rate"],
  ["codCollectionRate", "COD collection"],
  ["paymentSuccessRate", "Payment success"],
  ["refundDisputeRate", "Refund/dispute record"],
  ["tenure", "Tenure"],
  ["trustScore", "Trust score"],
];

/** SVG semicircular gauge for a 0-1000 score. */
function ScoreGauge({ score }: { score: number }) {
  const frac = Math.max(0, Math.min(1, score / 1000));
  const angle = Math.PI * (1 - frac);
  const r = 80;
  const x = 100 + r * Math.cos(angle);
  const y = 100 - r * Math.sin(angle);
  const large = frac > 0.5 ? 1 : 0;
  const color = score >= 800 ? "#16a34a" : score >= 600 ? "#65a30d" : score >= 400 ? "#d97706" : "#dc2626";
  return (
    <div className="flex flex-col items-center">
      <svg viewBox="0 0 200 110" className="w-56">
        <path d="M 20 100 A 80 80 0 0 1 180 100" fill="none" stroke="#e5e7eb" strokeWidth="14" strokeLinecap="round" />
        {frac > 0 && (
          <path
            d={`M 20 100 A 80 80 0 ${large} 1 ${x.toFixed(2)} ${y.toFixed(2)}`}
            fill="none" stroke={color} strokeWidth="14" strokeLinecap="round"
          />
        )}
        <text x="100" y="88" textAnchor="middle" fontSize="34" fontWeight="700" fill={color}>{score}</text>
        <text x="100" y="106" textAnchor="middle" fontSize="11" fill="#6b7280">out of 1000</text>
      </svg>
      <Badge variant={score >= 600 ? "default" : "secondary"}>
        {score >= 800 ? "Excellent" : score >= 600 ? "Good" : score >= 400 ? "Fair" : "Building"}
      </Badge>
    </div>
  );
}

// ─── Page ───────────────────────────────────────────────────────────────────

export default function CreditDashboard() {
  const { activeTenantId } = useActiveTenant();
  const tenantId = activeTenantId;
  const utils = trpc.useUtils();

  const scoreQ = trpc.credit.score.useQuery({ tenantId });
  const offersQ = trpc.credit.offers.useQuery({ tenantId });
  const loansQ = trpc.credit.loans.useQuery({ tenantId });

  const [acceptOpen, setAcceptOpen] = useState(false);
  const [amountMajor, setAmountMajor] = useState("");
  const [repayLoanId, setRepayLoanId] = useState<string | null>(null);
  const [repayMajor, setRepayMajor] = useState("");

  const refreshAll = () => {
    void utils.credit.score.invalidate();
    void utils.credit.offers.invalidate();
    void utils.credit.loans.invalidate();
  };

  const acceptM = trpc.credit.accept.useMutation({
    onSuccess: (r) => {
      if (r.ok) {
        toast.success(`Loan disbursed: ${fmtCents(r.loan.principalCents)} to your wallet`);
        setAcceptOpen(false);
        setAmountMajor("");
        refreshAll();
      }
    },
    onError: (e) => toast.error(e.message),
  });

  const repayM = trpc.credit.repay.useMutation({
    onSuccess: (r) => {
      toast.success(r.repaid ? "Loan fully repaid — thank you!" : "Repayment applied");
      setRepayLoanId(null);
      setRepayMajor("");
      refreshAll();
    },
    onError: (e) => toast.error(e.message),
  });

  const certM = trpc.credit.certificate.useMutation({
    onError: (e) => toast.error(e.message),
  });

  const downloadCert = async (kind: "json" | "html") => {
    const cert = await certM.mutateAsync({ tenantId });
    const body = kind === "json"
      ? JSON.stringify({ payload: cert.payload, signature: cert.signature, certificateId: cert.certificateId }, null, 2)
      : cert.html;
    const blob = new Blob([body], { type: kind === "json" ? "application/json" : "text/html" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `credit-certificate-${cert.certificateId}.${kind === "json" ? "json" : "html"}`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success(`Certificate ${kind.toUpperCase()} downloaded (HTML opens print-to-PDF)`);
  };

  const offer = offersQ.data?.offers?.[0] ?? null;
  const loans = useMemo(() => loansQ.data ?? [], [loansQ.data]);
  const openLoan = loans.find((l) => l.loan.status === "active" || l.loan.status === "defaulted");

  return (
    <DashboardLayout>
      <div className="space-y-6 p-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <TrendingUp className="h-6 w-6" /> Merchant Credit
            </h1>
            <p className="text-sm text-muted-foreground">
              Your credit score, working-capital loans and portable credit certificate.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={refreshAll}>
            <RefreshCw className="h-4 w-4 mr-1" /> Refresh
          </Button>
        </div>

        <div className="grid gap-6 md:grid-cols-2">
          {/* Score */}
          <Card>
            <CardHeader>
              <CardTitle>Credit score</CardTitle>
              <CardDescription>
                Computed deterministically from your last 90 days of orders, COD
                collections, payments, refunds and tenure.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {scoreQ.isLoading ? (
                <div className="flex justify-center py-8"><Loader2 className="h-6 w-6 animate-spin" /></div>
              ) : scoreQ.data ? (
                <>
                  <ScoreGauge score={scoreQ.data.score} />
                  <Table className="mt-4">
                    <TableHeader>
                      <TableRow><TableHead>Factor</TableHead><TableHead className="text-right">Points</TableHead></TableRow>
                    </TableHeader>
                    <TableBody>
                      {FACTOR_LABELS.map(([key, label]) => {
                        const f = (scoreQ.data!.factors as any)[key];
                        return (
                          <TableRow key={key}>
                            <TableCell>{label}</TableCell>
                            <TableCell className="text-right">{f.points} / {f.weight}</TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                  <p className="text-xs text-muted-foreground mt-2">
                    Computed {fmtDate(scoreQ.data.computedAt)} · 90d sales {fmtCents(scoreQ.data.factors.salesVolumeCents90d)}
                  </p>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">Score unavailable.</p>
              )}
            </CardContent>
          </Card>

          {/* Offers */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><HandCoins className="h-5 w-5" /> Working capital</CardTitle>
              <CardDescription>
                Micro-loans sized from your score tier. Repayment is automatic:
                a fixed % of every settled sale.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {offersQ.isLoading ? (
                <div className="flex justify-center py-8"><Loader2 className="h-6 w-6 animate-spin" /></div>
              ) : offer ? (
                <div className="space-y-3">
                  <div className="rounded-lg border p-4">
                    <div className="flex items-center justify-between">
                      <span className="text-lg font-semibold">{fmtCents(offer.maxPrincipalCents)}</span>
                      <Badge>Tier {offer.tier}</Badge>
                    </div>
                    <p className="text-sm text-muted-foreground mt-1">
                      Fee {offer.feePct}% · {offer.termDays}-day term · repay {offer.repaymentPct}% of each sale ·
                      total repayable {fmtCents(offer.totalRepayCents)}
                    </p>
                  </div>
                  <Button onClick={() => setAcceptOpen(true)}>Accept offer</Button>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {offersQ.data?.blockedReason === "existing_loan"
                    ? "You have an active loan — repay it to unlock new offers."
                    : offersQ.data?.blockedReason === "score_below_minimum"
                      ? `Your score (${offersQ.data?.score ?? "—"}) is below the minimum 400. Keep selling to build it up.`
                      : "No offers yet — your recent sales volume is too low."}
                </p>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Loans */}
        <Card>
          <CardHeader>
            <CardTitle>Loans & repayment schedule</CardTitle>
          </CardHeader>
          <CardContent>
            {loans.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">No loans yet.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Created</TableHead><TableHead>Tier</TableHead>
                    <TableHead>Principal</TableHead><TableHead>Outstanding</TableHead>
                    <TableHead>Rule</TableHead><TableHead>Due</TableHead>
                    <TableHead>Status</TableHead><TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {loans.map(({ loan, schedule }) => (
                    <TableRow key={loan.id}>
                      <TableCell>{fmtDate(loan.createdAt)}</TableCell>
                      <TableCell><Badge variant="outline">{loan.tier}</Badge></TableCell>
                      <TableCell>{fmtCents(loan.principalCents, loan.currency)}</TableCell>
                      <TableCell>{fmtCents(loan.outstandingCents, loan.currency)}</TableCell>
                      <TableCell className="text-xs">{schedule[0]?.label}</TableCell>
                      <TableCell>{fmtDate(loan.dueAt)}</TableCell>
                      <TableCell>
                        <Badge variant={loan.status === "repaid" ? "default" : loan.status === "defaulted" ? "destructive" : "secondary"}>
                          {loan.status}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {(loan.status === "active" || loan.status === "defaulted") && (
                          <Button size="sm" variant="outline" onClick={() => setRepayLoanId(loan.id)}>Repay</Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        {/* Certificate */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Award className="h-5 w-5" /> Credit certificate</CardTitle>
            <CardDescription>
              A signed, portable summary of your score and track record for
              banks and MFIs. JSON carries the HMAC signature; HTML prints to PDF.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex gap-3">
            <Button variant="outline" disabled={certM.isPending} onClick={() => void downloadCert("json")}>
              <Download className="h-4 w-4 mr-1" /> JSON + signature
            </Button>
            <Button variant="outline" disabled={certM.isPending} onClick={() => void downloadCert("html")}>
              <Download className="h-4 w-4 mr-1" /> HTML / PDF
            </Button>
          </CardContent>
        </Card>
      </div>

      {/* Accept dialog */}
      <Dialog open={acceptOpen} onOpenChange={setAcceptOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Accept loan offer</DialogTitle>
            <DialogDescription>
              Principal is credited to your merchant wallet immediately. Leave
              the amount empty to borrow the full offer.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="loan-amount">Amount (major units, e.g. 50000)</Label>
            <Input
              id="loan-amount"
              inputMode="decimal"
              placeholder={offer ? (offer.maxPrincipalCents / 100).toString() : ""}
              value={amountMajor}
              onChange={(e) => setAmountMajor(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAcceptOpen(false)}>Cancel</Button>
            <Button
              disabled={acceptM.isPending || !offer}
              onClick={() => {
                const cents = amountMajor.trim()
                  ? Math.round(Number(amountMajor) * 100)
                  : offer!.maxPrincipalCents;
                if (!Number.isSafeInteger(cents) || cents <= 0) {
                  toast.error("Enter a valid amount");
                  return;
                }
                acceptM.mutate({ tenantId, principalCents: cents });
              }}
            >
              {acceptM.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Accept & disburse"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Repay dialog */}
      <Dialog open={repayLoanId != null} onOpenChange={(o) => !o && setRepayLoanId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Manual repayment</DialogTitle>
            <DialogDescription>
              Debited from your merchant wallet balance now (in addition to the
              automatic per-sale deductions).
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="repay-amount">Amount (major units)</Label>
            <Input
              id="repay-amount"
              inputMode="decimal"
              value={repayMajor}
              onChange={(e) => setRepayMajor(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRepayLoanId(null)}>Cancel</Button>
            <Button
              disabled={repayM.isPending || !repayLoanId}
              onClick={() => {
                const cents = Math.round(Number(repayMajor) * 100);
                if (!Number.isSafeInteger(cents) || cents <= 0) {
                  toast.error("Enter a valid amount");
                  return;
                }
                repayM.mutate({ tenantId, loanId: repayLoanId!, amountCents: cents });
              }}
            >
              {repayM.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Repay"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  );
}
