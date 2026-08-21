/**
 * W27 (Coder G): Stokvel / group savings circle management.
 * Create circles, inspect rotation + contributions + payouts + audit trail,
 * and trigger the missed-contribution scan.
 */
import { useState } from "react";
import { useActiveTenant } from "@/contexts/TenantContext";
import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";

function fmt(cents: number, currency = "NGN") {
  return `${currency} ${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default function SavingsCircles() {
  const { activeTenantId } = useActiveTenant();
  const tenantId = activeTenantId;
  const utils = trpc.useUtils();
  const { data: circles, isLoading } = trpc.stokvel.listCircles.useQuery({ tenantId });
  const [selected, setSelected] = useState<string | null>(null);
  const { data: statement } = trpc.stokvel.statement.useQuery(
    { tenantId, circleId: selected! },
    { enabled: !!selected },
  );

  const [name, setName] = useState("");
  const [amountMajor, setAmountMajor] = useState("500");
  const [frequency, setFrequency] = useState<"weekly" | "monthly">("monthly");
  const [membersText, setMembersText] = useState("");

  const invalidate = () => {
    utils.stokvel.listCircles.invalidate();
    if (selected) utils.stokvel.statement.invalidate({ tenantId, circleId: selected });
  };
  const onError = (e: any) => toast.error(e?.message ?? "Action failed");

  const createMut = trpc.stokvel.createCircle.useMutation({
    onSuccess: () => { toast.success("Circle created"); setName(""); setMembersText(""); invalidate(); },
    onError,
  });
  const missedMut = trpc.stokvel.markMissed.useMutation({
    onSuccess: (r) => { toast.success(`${r.missed.length} contribution(s) marked missed`); invalidate(); },
    onError,
  });

  const create = () => {
    const members = membersText.split(/\n|,/).map((s) => s.trim()).filter(Boolean)
      .map((entry) => {
        const [ph, ...rest] = entry.split(/\s*[:|]\s*/);
        return { phone: ph, name: rest.join(" ") || undefined };
      });
    createMut.mutate({
      tenantId,
      name,
      contributionAmountCents: Math.round(parseFloat(amountMajor) * 100),
      frequency,
      members,
    });
  };

  return (
    <DashboardLayout>
      <div className="space-y-6 p-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">Savings Circles (Stokvel)</h1>
          <Button variant="outline" onClick={() => missedMut.mutate({ tenantId })} disabled={missedMut.isPending}>
            Run missed-contribution scan
          </Button>
        </div>

        <Card>
          <CardHeader><CardTitle>Create circle</CardTitle></CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label>Name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Esusu Circle" />
              <Label>Contribution (major units, per member per cycle)</Label>
              <Input value={amountMajor} onChange={(e) => setAmountMajor(e.target.value)} inputMode="decimal" />
              <Label>Frequency</Label>
              <Select value={frequency} onValueChange={(v) => setFrequency(v as any)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="weekly">Weekly</SelectItem>
                  <SelectItem value="monthly">Monthly</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Members (one per line: phone or phone: name — join order = payout rotation)</Label>
              <textarea
                className="min-h-32 w-full rounded-md border bg-background p-2 text-sm"
                value={membersText}
                onChange={(e) => setMembersText(e.target.value)}
                placeholder={"2348011111111: Ada\n2348022222222: Bola\n2348033333333: Chidi"}
              />
              <Button onClick={create} disabled={createMut.isPending || !name || membersText.trim().length === 0}>
                Create
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Circles</CardTitle></CardHeader>
          <CardContent>
            {isLoading ? <p>Loading…</p> : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead><TableHead>Contribution</TableHead>
                    <TableHead>Frequency</TableHead><TableHead>Cycle</TableHead>
                    <TableHead>Rotation</TableHead><TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(circles ?? []).map((c: any) => (
                    <TableRow key={c.id} className="cursor-pointer" onClick={() => setSelected(c.id)}>
                      <TableCell>{c.name}</TableCell>
                      <TableCell>{fmt(c.contributionAmountCents, c.currency)}</TableCell>
                      <TableCell>{c.frequency}</TableCell>
                      <TableCell>{c.currentCycle}</TableCell>
                      <TableCell>#{c.rotationIndex}</TableCell>
                      <TableCell><Badge variant={c.status === "active" ? "default" : "secondary"}>{c.status}</Badge></TableCell>
                    </TableRow>
                  ))}
                  {(circles ?? []).length === 0 && <TableRow><TableCell colSpan={6}>No circles yet.</TableCell></TableRow>}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        {statement && (
          <Card>
            <CardHeader><CardTitle>{statement.circle.name} — statement</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <div>
                <h3 className="font-semibold">Members (rotation order)</h3>
                <Table>
                  <TableHeader><TableRow><TableHead>#</TableHead><TableHead>Phone</TableHead><TableHead>Name</TableHead><TableHead>Status</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {statement.members.map((m: any) => (
                      <TableRow key={m.id}>
                        <TableCell>{m.rotationPosition}</TableCell>
                        <TableCell>{m.phone}</TableCell>
                        <TableCell>{m.name ?? "—"}</TableCell>
                        <TableCell>{m.status}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <div>
                <h3 className="font-semibold">Contributions</h3>
                <Table>
                  <TableHeader><TableRow><TableHead>Cycle</TableHead><TableHead>Phone</TableHead><TableHead>Amount</TableHead><TableHead>Status</TableHead><TableHead>Reminders</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {statement.contributions.map((c: any) => (
                      <TableRow key={c.id}>
                        <TableCell>{c.cycle}</TableCell>
                        <TableCell>{c.phone}</TableCell>
                        <TableCell>{fmt(c.amountCents)}</TableCell>
                        <TableCell><Badge variant={c.status === "paid" ? "default" : c.status === "missed" ? "destructive" : "secondary"}>{c.status}</Badge></TableCell>
                        <TableCell>{c.reminderCount}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <div>
                <h3 className="font-semibold">Payouts</h3>
                <Table>
                  <TableHeader><TableRow><TableHead>Cycle</TableHead><TableHead>Recipient</TableHead><TableHead>Amount</TableHead><TableHead>Status</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {statement.payouts.map((p: any) => (
                      <TableRow key={p.id}>
                        <TableCell>{p.cycle}</TableCell>
                        <TableCell>{p.phone}</TableCell>
                        <TableCell>{fmt(p.amountCents)}</TableCell>
                        <TableCell>{p.status}</TableCell>
                      </TableRow>
                    ))}
                    {statement.payouts.length === 0 && <TableRow><TableCell colSpan={4}>No payouts yet.</TableCell></TableRow>}
                  </TableBody>
                </Table>
              </div>
              <div>
                <h3 className="font-semibold">Audit trail</h3>
                <ul className="space-y-1 text-sm">
                  {statement.events.map((e: any) => (
                    <li key={e.id} className="font-mono">
                      {new Date(e.createdAt).toISOString()} · {e.kind}{e.actorPhone ? ` · ${e.actorPhone}` : ""}
                    </li>
                  ))}
                </ul>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </DashboardLayout>
  );
}
