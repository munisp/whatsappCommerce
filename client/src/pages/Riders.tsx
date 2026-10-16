// === W55 ui-c ===
// Rider registry for the W47 riders router (ORPHAN-BE-17): register,
// approve/suspend lifecycle, and delivery assignment to ACTIVE riders.
// Rider self-service status updates stay channel-first (phone_identity
// proof) by design — this is the merchant-side surface.
import { useActiveTenant } from "@/contexts/TenantContext";
import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { trpc } from "@/lib/trpc";
import { formatDistanceToNow } from "date-fns";
import { Bike, Check, Ban, UserPlus, Link2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

const riderStatusColors: Record<string, string> = {
  pending: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
  active: "bg-green-500/20 text-green-400 border-green-500/30",
  suspended: "bg-red-500/20 text-red-400 border-red-500/30",
};

export default function Riders() {
  const { activeTenantId: tenantId } = useActiveTenant();
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [registerOpen, setRegisterOpen] = useState(false);
  const [assignFor, setAssignFor] = useState<string | null>(null); // deliveryId
  const [assignRiderId, setAssignRiderId] = useState("");
  const utils = trpc.useUtils();

  const { data: riders, isLoading } = trpc.riders.list.useQuery({
    tenantId,
    status: statusFilter === "all" ? undefined : (statusFilter as any),
  });
  const { data: deliveries, isLoading: deliveriesLoading } = trpc.deliveryAggregation.list.useQuery({ tenantId, limit: 100 });
  const { data: activeRiders } = trpc.riders.list.useQuery({ tenantId, status: "active" });

  const invalidate = () => {
    utils.riders.list.invalidate();
    utils.deliveryAggregation.list.invalidate();
  };
  const opts = (label: string) => ({
    onSuccess: () => { toast.success(label); invalidate(); },
    onError: (e: any) => toast.error(e.message),
  });
  const approveMut = trpc.riders.approve.useMutation(opts("Rider approved"));
  const suspendMut = trpc.riders.suspend.useMutation(opts("Rider suspended"));
  const assignMut = trpc.riders.assign.useMutation({
    onSuccess: () => { toast.success("Delivery assigned"); setAssignFor(null); setAssignRiderId(""); invalidate(); },
    onError: (e) => toast.error(e.message),
  });
  const registerMut = trpc.riders.register.useMutation({
    onSuccess: (r) => {
      toast.success(r.duplicate ? "Rider already registered" : "Rider registered (pending approval)");
      setRegisterOpen(false);
      invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const [form, setForm] = useState({ name: "", phone: "", idReference: "" });
  const assignableDeliveries = (deliveries ?? []).filter((d: any) => !["delivered", "cancelled", "failed"].includes(d.status));

  return (
    <DashboardLayout>
      <div className="p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-foreground">Riders</h1>
            <p className="text-muted-foreground mt-1">Driver registry, approval lifecycle and delivery assignment</p>
          </div>
          <Button onClick={() => setRegisterOpen(true)} className="gap-1">
            <UserPlus className="w-4 h-4" /> Register rider
          </Button>
        </div>

        <Tabs defaultValue="riders">
          <TabsList>
            <TabsTrigger value="riders"><Bike className="w-3.5 h-3.5 mr-1" />Registry</TabsTrigger>
            <TabsTrigger value="assign"><Link2 className="w-3.5 h-3.5 mr-1" />Assignments</TabsTrigger>
          </TabsList>

          <TabsContent value="riders" className="space-y-4 pt-4">
            <div className="flex items-center gap-3">
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-48 bg-card border-border">
                  <SelectValue placeholder="Filter by status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  <SelectItem value="pending">Pending</SelectItem>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="suspended">Suspended</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Card className="bg-card border-border">
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow className="border-border hover:bg-transparent">
                      <TableHead>Name</TableHead>
                      <TableHead>Phone</TableHead>
                      <TableHead>ID reference</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Registered</TableHead>
                      <TableHead></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {isLoading ? (
                      <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-8">Loading...</TableCell></TableRow>
                    ) : !riders?.length ? (
                      <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                        <div className="flex flex-col items-center gap-2">
                          <Bike className="w-8 h-8 opacity-40" />
                          No riders registered
                        </div>
                      </TableCell></TableRow>
                    ) : riders.map((r) => (
                      <TableRow key={r.id} className="border-border hover:bg-accent/30">
                        <TableCell className="font-medium">{r.name}</TableCell>
                        <TableCell className="font-mono text-xs">{r.phone}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">{r.idReference ?? "—"}</TableCell>
                        <TableCell><Badge variant="outline" className={riderStatusColors[r.status] ?? ""}>{r.status}</Badge></TableCell>
                        <TableCell className="text-muted-foreground text-xs">{formatDistanceToNow(new Date(r.createdAt), { addSuffix: true })}</TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1">
                            {r.status === "pending" && (
                              <Button variant="ghost" size="sm" className="h-7 text-xs gap-1 text-green-400 hover:text-green-300"
                                disabled={approveMut.isPending}
                                onClick={() => approveMut.mutate({ tenantId, riderId: r.id })}>
                                <Check className="w-3 h-3" /> Approve
                              </Button>
                            )}
                            {r.status === "active" && (
                              <Button variant="ghost" size="sm" className="h-7 text-xs gap-1 text-red-400 hover:text-red-300"
                                disabled={suspendMut.isPending}
                                onClick={() => suspendMut.mutate({ tenantId, riderId: r.id })}>
                                <Ban className="w-3 h-3" /> Suspend
                              </Button>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="assign" className="space-y-4 pt-4">
            <Card className="bg-card border-border">
              <CardHeader><CardTitle className="text-sm font-medium text-muted-foreground">In-flight deliveries</CardTitle></CardHeader>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow className="border-border hover:bg-transparent">
                      <TableHead>Delivery</TableHead>
                      <TableHead>Order</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Rider</TableHead>
                      <TableHead></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {deliveriesLoading ? (
                      <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground py-8">Loading...</TableCell></TableRow>
                    ) : assignableDeliveries.length === 0 ? (
                      <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground py-8">No assignable deliveries</TableCell></TableRow>
                    ) : assignableDeliveries.map((d: any) => {
                      const rider = (riders ?? []).find((r) => r.id === d.riderId);
                      return (
                        <TableRow key={d.id} className="border-border hover:bg-accent/30">
                          <TableCell className="font-mono text-xs">{String(d.id).slice(0, 8)}...</TableCell>
                          <TableCell className="font-mono text-xs">{d.orderNumber ?? d.orderId ?? "—"}</TableCell>
                          <TableCell><Badge variant="outline">{d.status}</Badge></TableCell>
                          <TableCell className="text-sm">{rider ? `${rider.name} (${rider.phone})` : <span className="text-muted-foreground">Unassigned</span>}</TableCell>
                          <TableCell>
                            <Button variant="ghost" size="sm" className="h-7 text-xs gap-1"
                              onClick={() => { setAssignFor(d.id); setAssignRiderId(""); }}>
                              <Link2 className="w-3 h-3" /> Assign
                            </Button>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>

        <Dialog open={registerOpen} onOpenChange={setRegisterOpen}>
          <DialogContent>
            <DialogHeader><DialogTitle>Register rider</DialogTitle></DialogHeader>
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>Name</Label>
                <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </div>
              <div className="space-y-2">
                <Label>Phone (rider status updates must come from this number)</Label>
                <Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="e.g. 0803..." />
              </div>
              <div className="space-y-2">
                <Label>ID reference (optional)</Label>
                <Input value={form.idReference} onChange={(e) => setForm({ ...form, idReference: e.target.value })} />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setRegisterOpen(false)}>Close</Button>
              <Button disabled={registerMut.isPending || !form.name.trim() || form.phone.trim().length < 7}
                onClick={() => registerMut.mutate({ tenantId, name: form.name.trim(), phone: form.phone.trim(), idReference: form.idReference || undefined })}>
                Register
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog open={!!assignFor} onOpenChange={() => setAssignFor(null)}>
          <DialogContent>
            <DialogHeader><DialogTitle>Assign delivery to rider</DialogTitle></DialogHeader>
            <div className="space-y-2">
              <Label>Active rider</Label>
              <Select value={assignRiderId} onValueChange={setAssignRiderId}>
                <SelectTrigger><SelectValue placeholder="Pick a rider" /></SelectTrigger>
                <SelectContent>
                  {(activeRiders ?? []).map((r) => (
                    <SelectItem key={r.id} value={r.id}>{r.name} ({r.phone})</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {!activeRiders?.length && (
                <p className="text-xs text-muted-foreground">No active riders — approve a pending rider first.</p>
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setAssignFor(null)}>Close</Button>
              <Button disabled={assignMut.isPending || !assignRiderId}
                onClick={() => assignFor && assignMut.mutate({ tenantId, deliveryId: assignFor, riderId: assignRiderId })}>
                Assign
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </DashboardLayout>
  );
}
