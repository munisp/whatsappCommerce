/**
 * W27 (Coder G): Micro-insurance — products, policies and claims.
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

export default function InsurancePolicies() {
  const { activeTenantId } = useActiveTenant();
  const tenantId = activeTenantId;
  const utils = trpc.useUtils();
  const { data: products } = trpc.insurance.listProducts.useQuery({ tenantId, activeOnly: false });
  const { data: policies } = trpc.insurance.listPolicies.useQuery({ tenantId });
  const { data: claims } = trpc.insurance.listClaims.useQuery({ tenantId });

  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [bps, setBps] = useState("200");
  const [flatMajor, setFlatMajor] = useState("1");
  const [coverageMajor, setCoverageMajor] = useState("500");

  const invalidate = () => {
    utils.insurance.listProducts.invalidate();
    utils.insurance.listPolicies.invalidate();
    utils.insurance.listClaims.invalidate();
  };
  const upsertMut = trpc.insurance.upsertProduct.useMutation({
    onSuccess: () => { toast.success("Product saved"); invalidate(); },
    onError: (e) => toast.error(e?.message ?? "Failed"),
  });

  return (
    <DashboardLayout>
      <div className="space-y-6 p-6">
        <h1 className="text-2xl font-bold">Micro-Insurance</h1>

        <Card>
          <CardHeader><CardTitle>Configure product</CardTitle></CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-5">
            <div><Label>Product id</Label><Input value={id} onChange={(e) => setId(e.target.value)} placeholder="delivery-basic" /></div>
            <div><Label>Name</Label><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Delivery Insurance" /></div>
            <div><Label>Premium (bps of order)</Label><Input value={bps} onChange={(e) => setBps(e.target.value)} inputMode="numeric" /></div>
            <div><Label>Flat premium floor (major)</Label><Input value={flatMajor} onChange={(e) => setFlatMajor(e.target.value)} inputMode="decimal" /></div>
            <div><Label>Coverage (major)</Label><Input value={coverageMajor} onChange={(e) => setCoverageMajor(e.target.value)} inputMode="decimal" /></div>
            <div className="md:col-span-5">
              <Button
                disabled={upsertMut.isPending || !id || !name}
                onClick={() => upsertMut.mutate({
                  tenantId, id, name,
                  premiumBps: parseInt(bps || "0", 10),
                  flatPremiumCents: Math.round(parseFloat(flatMajor || "0") * 100),
                  coverageCents: Math.round(parseFloat(coverageMajor || "0") * 100),
                })}
              >Save product</Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Products</CardTitle></CardHeader>
          <CardContent>
            <Table>
              <TableHeader><TableRow><TableHead>Id</TableHead><TableHead>Name</TableHead><TableHead>Premium</TableHead><TableHead>Coverage</TableHead><TableHead>Active</TableHead></TableRow></TableHeader>
              <TableBody>
                {(products ?? []).map((p: any) => (
                  <TableRow key={p.id}>
                    <TableCell className="font-mono">{p.id}</TableCell>
                    <TableCell>{p.name}</TableCell>
                    <TableCell>{p.premiumBps} bps (floor {fmt(p.flatPremiumCents)})</TableCell>
                    <TableCell>{fmt(p.coverageCents)}</TableCell>
                    <TableCell>{p.active ? "yes" : "no"}</TableCell>
                  </TableRow>
                ))}
                {(products ?? []).length === 0 && <TableRow><TableCell colSpan={5}>No products configured.</TableCell></TableRow>}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Policies</CardTitle></CardHeader>
          <CardContent>
            <Table>
              <TableHeader><TableRow><TableHead>Policy #</TableHead><TableHead>Product</TableHead><TableHead>Holder</TableHead><TableHead>Premium</TableHead><TableHead>Coverage</TableHead><TableHead>Status</TableHead></TableRow></TableHeader>
              <TableBody>
                {(policies ?? []).map((p: any) => (
                  <TableRow key={p.id}>
                    <TableCell className="font-mono">{p.policyNumber}</TableCell>
                    <TableCell>{p.productId}</TableCell>
                    <TableCell>{p.holderPhone ?? "—"}</TableCell>
                    <TableCell>{fmt(p.premiumCents, p.currency)}</TableCell>
                    <TableCell>{fmt(p.coverageCents, p.currency)}</TableCell>
                    <TableCell><Badge variant={p.status === "active" ? "default" : "secondary"}>{p.status}</Badge></TableCell>
                  </TableRow>
                ))}
                {(policies ?? []).length === 0 && <TableRow><TableCell colSpan={6}>No policies yet.</TableCell></TableRow>}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Claims</CardTitle></CardHeader>
          <CardContent>
            <Table>
              <TableHeader><TableRow><TableHead>Reason</TableHead><TableHead>Trigger</TableHead><TableHead>Payout</TableHead><TableHead>Status</TableHead><TableHead>Filed</TableHead></TableRow></TableHeader>
              <TableBody>
                {(claims ?? []).map((c: any) => (
                  <TableRow key={c.id}>
                    <TableCell>{c.reason}</TableCell>
                    <TableCell>{c.trigger}</TableCell>
                    <TableCell>{c.payoutCents != null ? fmt(c.payoutCents) : "—"}</TableCell>
                    <TableCell><Badge variant={c.status === "paid" ? "default" : "secondary"}>{c.status}</Badge></TableCell>
                    <TableCell>{new Date(c.createdAt).toLocaleString()}</TableCell>
                  </TableRow>
                ))}
                {(claims ?? []).length === 0 && <TableRow><TableCell colSpan={5}>No claims yet.</TableCell></TableRow>}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
