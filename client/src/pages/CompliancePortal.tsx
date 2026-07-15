import { useState } from "react";
import { trpc } from "@/lib/trpc";
import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { FileText, Building, Gavel, CheckCircle2, Plus } from "lucide-react";
import { toast } from "sonner";

const TENANT_ID = "default";

export default function CompliancePortal() {
  const [taxOpen, setTaxOpen] = useState(false);
  const [cacOpen, setCacOpen] = useState(false);
  const [bidOpen, setBidOpen] = useState(false);
  const [taxForm, setTaxForm] = useState({ filingType: "vat", periodStart: "", periodEnd: "", grossRevenue: "", taxableAmount: "", taxAmount: "" });
  const [cacForm, setCacForm] = useState({ businessName: "", businessType: "sole_proprietorship", rcNumber: "", tinNumber: "" });
  const [bidForm, setBidForm] = useState({ contractTitle: "", procuringEntity: "", contractValue: "", deadline: "", technicalProposal: "" });

  const { data: taxFilings, refetch: refetchTax } = trpc.compliance.listTaxFilings.useQuery({ tenantId: TENANT_ID });
  const { data: cacs, refetch: refetchCac } = trpc.compliance.listCacRegistrations.useQuery({ tenantId: TENANT_ID });
  const { data: bids, refetch: refetchBids } = trpc.compliance.listProcurementBids.useQuery({ tenantId: TENANT_ID });
  const { data: summary } = trpc.compliance.complianceSummary.useQuery({ tenantId: TENANT_ID });

  const createTax = trpc.compliance.createTaxFiling.useMutation({ onSuccess: () => { toast.success("Tax filing created"); setTaxOpen(false); refetchTax(); }, onError: e => toast.error(e.message) });
  const submitTax = trpc.compliance.submitTaxFiling.useMutation({ onSuccess: () => { toast.success("Tax filing submitted"); refetchTax(); } });
  const createCac = trpc.compliance.createCacRegistration.useMutation({ onSuccess: () => { toast.success("CAC registration submitted"); setCacOpen(false); refetchCac(); }, onError: e => toast.error(e.message) });
  const createBid = trpc.compliance.createProcurementBid.useMutation({ onSuccess: () => { toast.success("Bid created"); setBidOpen(false); refetchBids(); }, onError: e => toast.error(e.message) });
  const submitBid = trpc.compliance.submitProcurementBid.useMutation({ onSuccess: () => { toast.success("Bid submitted"); refetchBids(); } });

  const statusColor = (s: string) => {
    if (s === "accepted" || s === "approved" || s === "awarded") return "bg-green-100 text-green-800";
    if (s === "submitted" || s === "shortlisted") return "bg-blue-100 text-blue-800";
    if (s === "rejected") return "bg-red-100 text-red-800";
    if (s === "draft" || s === "pending") return "bg-gray-100 text-gray-700";
    return "bg-yellow-100 text-yellow-800";
  };

  return (
    <DashboardLayout>
      <div className="p-6 space-y-6">
        <h1 className="text-2xl font-bold text-gray-900">Compliance & B2G Portal</h1>
        <p className="text-gray-500 text-sm">FIRS Tax Filing · CAC Registration · Government Procurement</p>

        {summary && (
          <div className="grid grid-cols-3 gap-4">
            {[
              { label: "Tax Filings", value: `${summary.taxFilings.submitted}/${summary.taxFilings.total} submitted`, icon: FileText, color: "text-blue-600" },
              { label: "CAC Registrations", value: `${summary.cacRegistrations.approved}/${summary.cacRegistrations.total} approved`, icon: Building, color: "text-green-600" },
              { label: "Procurement Bids", value: `${summary.procurementBids.awarded}/${summary.procurementBids.total} awarded`, icon: Gavel, color: "text-purple-600" },
            ].map(({ label, value, icon: Icon, color }) => (
              <Card key={label}><CardContent className="pt-4"><div className="flex items-center gap-3"><Icon className={`w-8 h-8 ${color}`} /><div><p className="text-lg font-bold">{value}</p><p className="text-xs text-gray-500">{label}</p></div></div></CardContent></Card>
            ))}
          </div>
        )}

        <Tabs defaultValue="tax">
          <TabsList><TabsTrigger value="tax">FIRS Tax</TabsTrigger><TabsTrigger value="cac">CAC</TabsTrigger><TabsTrigger value="procurement">Procurement</TabsTrigger></TabsList>

          <TabsContent value="tax" className="pt-4 space-y-3">
            <div className="flex justify-end">
              <Dialog open={taxOpen} onOpenChange={setTaxOpen}>
                <DialogTrigger asChild><Button size="sm"><Plus className="w-4 h-4 mr-1" />New Filing</Button></DialogTrigger>
                <DialogContent>
                  <DialogHeader><DialogTitle>Create Tax Filing</DialogTitle></DialogHeader>
                  <div className="space-y-3 pt-2">
                    <Select value={taxForm.filingType} onValueChange={v => setTaxForm(f => ({ ...f, filingType: v }))}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent><SelectItem value="vat">VAT</SelectItem><SelectItem value="cit">CIT</SelectItem><SelectItem value="paye">PAYE</SelectItem><SelectItem value="wht">WHT</SelectItem></SelectContent>
                    </Select>
                    <Input type="date" placeholder="Period Start" value={taxForm.periodStart} onChange={e => setTaxForm(f => ({ ...f, periodStart: e.target.value }))} />
                    <Input type="date" placeholder="Period End" value={taxForm.periodEnd} onChange={e => setTaxForm(f => ({ ...f, periodEnd: e.target.value }))} />
                    <Input placeholder="Gross Revenue" value={taxForm.grossRevenue} onChange={e => setTaxForm(f => ({ ...f, grossRevenue: e.target.value }))} />
                    <Input placeholder="Taxable Amount" value={taxForm.taxableAmount} onChange={e => setTaxForm(f => ({ ...f, taxableAmount: e.target.value }))} />
                    <Input placeholder="Tax Amount" value={taxForm.taxAmount} onChange={e => setTaxForm(f => ({ ...f, taxAmount: e.target.value }))} />
                    <Button className="w-full" onClick={() => createTax.mutate({ tenantId: TENANT_ID, ...taxForm })} disabled={createTax.isPending}>Create Filing</Button>
                  </div>
                </DialogContent>
              </Dialog>
            </div>
            {(taxFilings ?? []).map(f => (
              <Card key={f.id}><CardContent className="pt-4"><div className="flex items-center justify-between"><div><p className="font-semibold">{f.filingType.toUpperCase()} — {f.taxAuthority.toUpperCase()}</p><p className="text-sm text-gray-500">{new Date(f.periodStart).toLocaleDateString()} to {new Date(f.periodEnd).toLocaleDateString()}</p><p className="text-sm text-gray-700">Tax: {f.currency} {f.taxAmount}</p></div><div className="flex items-center gap-2"><Badge className={statusColor(f.status)}>{f.status}</Badge>{f.status === "draft" && <Button size="sm" variant="outline" onClick={() => submitTax.mutate({ id: f.id })}>Submit</Button>}</div></div></CardContent></Card>
            ))}
          </TabsContent>

          <TabsContent value="cac" className="pt-4 space-y-3">
            <div className="flex justify-end">
              <Dialog open={cacOpen} onOpenChange={setCacOpen}>
                <DialogTrigger asChild><Button size="sm"><Plus className="w-4 h-4 mr-1" />Register Business</Button></DialogTrigger>
                <DialogContent>
                  <DialogHeader><DialogTitle>CAC Business Registration</DialogTitle></DialogHeader>
                  <div className="space-y-3 pt-2">
                    <Input placeholder="Business Name" value={cacForm.businessName} onChange={e => setCacForm(f => ({ ...f, businessName: e.target.value }))} />
                    <Select value={cacForm.businessType} onValueChange={v => setCacForm(f => ({ ...f, businessType: v }))}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent><SelectItem value="sole_proprietorship">Sole Proprietorship</SelectItem><SelectItem value="partnership">Partnership</SelectItem><SelectItem value="limited_liability">Limited Liability</SelectItem><SelectItem value="incorporated_trustee">Incorporated Trustee</SelectItem></SelectContent>
                    </Select>
                    <Input placeholder="RC Number (if existing)" value={cacForm.rcNumber} onChange={e => setCacForm(f => ({ ...f, rcNumber: e.target.value }))} />
                    <Input placeholder="TIN Number (if existing)" value={cacForm.tinNumber} onChange={e => setCacForm(f => ({ ...f, tinNumber: e.target.value }))} />
                    <Button className="w-full" onClick={() => createCac.mutate({ tenantId: TENANT_ID, ...cacForm })} disabled={createCac.isPending}>Submit</Button>
                  </div>
                </DialogContent>
              </Dialog>
            </div>
            {(cacs ?? []).map(c => (
              <Card key={c.id}><CardContent className="pt-4"><div className="flex items-center justify-between"><div><p className="font-semibold">{c.businessName}</p><p className="text-sm text-gray-500">{c.businessType.replace(/_/g, " ")} | RC: {c.rcNumber ?? "Pending"} | TIN: {c.tinNumber ?? "Pending"}</p></div><Badge className={statusColor(c.status)}>{c.status}</Badge></div></CardContent></Card>
            ))}
          </TabsContent>

          <TabsContent value="procurement" className="pt-4 space-y-3">
            <div className="flex justify-end">
              <Dialog open={bidOpen} onOpenChange={setBidOpen}>
                <DialogTrigger asChild><Button size="sm"><Plus className="w-4 h-4 mr-1" />New Bid</Button></DialogTrigger>
                <DialogContent>
                  <DialogHeader><DialogTitle>Create Procurement Bid</DialogTitle></DialogHeader>
                  <div className="space-y-3 pt-2">
                    <Input placeholder="Contract Title" value={bidForm.contractTitle} onChange={e => setBidForm(f => ({ ...f, contractTitle: e.target.value }))} />
                    <Input placeholder="Procuring Entity" value={bidForm.procuringEntity} onChange={e => setBidForm(f => ({ ...f, procuringEntity: e.target.value }))} />
                    <Input placeholder="Contract Value (NGN)" value={bidForm.contractValue} onChange={e => setBidForm(f => ({ ...f, contractValue: e.target.value }))} />
                    <Input type="date" placeholder="Deadline" value={bidForm.deadline} onChange={e => setBidForm(f => ({ ...f, deadline: e.target.value }))} />
                    <Button className="w-full" onClick={() => createBid.mutate({ tenantId: TENANT_ID, ...bidForm })} disabled={createBid.isPending}>Create Draft</Button>
                  </div>
                </DialogContent>
              </Dialog>
            </div>
            {(bids ?? []).map(b => (
              <Card key={b.id}><CardContent className="pt-4"><div className="flex items-center justify-between"><div><p className="font-semibold">{b.contractTitle}</p><p className="text-sm text-gray-500">{b.procuringEntity} | {b.currency} {b.contractValue}</p>{b.deadline && <p className="text-xs text-gray-400">Deadline: {new Date(b.deadline).toLocaleDateString()}</p>}</div><div className="flex items-center gap-2"><Badge className={statusColor(b.status)}>{b.status}</Badge>{b.status === "draft" && <Button size="sm" variant="outline" onClick={() => submitBid.mutate({ id: b.id })}>Submit</Button>}</div></div></CardContent></Card>
            ))}
          </TabsContent>
        </Tabs>
      </div>
    </DashboardLayout>
  );
}
