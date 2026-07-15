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
import { Calendar, Package, RefreshCw, Plus } from "lucide-react";
import { toast } from "sonner";

const TENANT_ID = "default";

export default function ServiceCommercePage() {
  const [svcOpen, setSvcOpen] = useState(false);
  const [apptOpen, setApptOpen] = useState(false);
  const [svcForm, setSvcForm] = useState({ name: "", serviceType: "appointment" as "appointment" | "digital" | "subscription" | "physical", price: "", currency: "NGN", description: "" });
  const [apptForm, setApptForm] = useState({ serviceId: "", customerPhone: "", customerName: "", scheduledAt: "", notes: "" });

  const { data: services, refetch: refetchSvc } = trpc.serviceCommerce.listServices.useQuery({ tenantId: TENANT_ID });
  const { data: appointments, refetch: refetchAppt } = trpc.serviceCommerce.listAppointments.useQuery({ tenantId: TENANT_ID });
  const { data: subscriptions } = trpc.serviceCommerce.listSubscriptions.useQuery({ tenantId: TENANT_ID });
  const { data: digitalProducts } = trpc.serviceCommerce.listDigitalProducts.useQuery({ tenantId: TENANT_ID });

  const createService = trpc.serviceCommerce.createService.useMutation({
    onSuccess: () => { toast.success("Service created"); setSvcOpen(false); refetchSvc(); },
    onError: (e) => toast.error(e.message),
  });
  const bookAppt = trpc.serviceCommerce.bookAppointment.useMutation({
    onSuccess: () => { toast.success("Appointment booked"); setApptOpen(false); refetchAppt(); },
    onError: (e) => toast.error(e.message),
  });
  const updateApptStatus = trpc.serviceCommerce.updateAppointmentStatus.useMutation({ onSuccess: () => refetchAppt() });

  const statusColor = (s: string) => {
    if (s === "completed" || s === "confirmed") return "bg-green-100 text-green-800";
    if (s === "scheduled") return "bg-blue-100 text-blue-800";
    if (s === "cancelled" || s === "no_show") return "bg-red-100 text-red-800";
    return "bg-gray-100 text-gray-700";
  };

  return (
    <DashboardLayout>
      <div className="p-6 space-y-6">
        <h1 className="text-2xl font-bold text-gray-900">Service Commerce</h1>
        <p className="text-gray-500 text-sm">Appointments · Digital Products · Subscriptions</p>
        <Tabs defaultValue="services">
          <TabsList><TabsTrigger value="services">Services</TabsTrigger><TabsTrigger value="appointments">Appointments</TabsTrigger><TabsTrigger value="subscriptions">Subscriptions</TabsTrigger><TabsTrigger value="digital">Digital Products</TabsTrigger></TabsList>

          <TabsContent value="services" className="pt-4 space-y-3">
            <div className="flex justify-end">
              <Dialog open={svcOpen} onOpenChange={setSvcOpen}>
                <DialogTrigger asChild><Button size="sm"><Plus className="w-4 h-4 mr-1" />New Service</Button></DialogTrigger>
                <DialogContent>
                  <DialogHeader><DialogTitle>Create Service</DialogTitle></DialogHeader>
                  <div className="space-y-3 pt-2">
                    <Input placeholder="Service Name" value={svcForm.name} onChange={e => setSvcForm(f => ({ ...f, name: e.target.value }))} />
                    <Select value={svcForm.serviceType} onValueChange={v => setSvcForm(f => ({ ...f, serviceType: v as typeof svcForm.serviceType }))}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent><SelectItem value="appointment">Appointment</SelectItem><SelectItem value="digital">Digital</SelectItem><SelectItem value="subscription">Subscription</SelectItem><SelectItem value="physical">Physical</SelectItem></SelectContent>
                    </Select>
                    <Input placeholder="Price" type="number" value={svcForm.price} onChange={e => setSvcForm(f => ({ ...f, price: e.target.value }))} />
                    <Input placeholder="Description" value={svcForm.description} onChange={e => setSvcForm(f => ({ ...f, description: e.target.value }))} />
                    <Button className="w-full" onClick={() => createService.mutate({ tenantId: TENANT_ID, ...svcForm })} disabled={createService.isPending}>Create</Button>
                  </div>
                </DialogContent>
              </Dialog>
            </div>
            {(services ?? []).map(s => (
              <Card key={s.id}><CardContent className="pt-4"><div className="flex items-center justify-between"><div><p className="font-semibold">{s.name}</p><p className="text-sm text-gray-500">{s.serviceType} | {s.currency} {s.price}</p></div><Badge className={s.isActive ? "bg-green-100 text-green-800" : "bg-gray-100 text-gray-600"}>{s.isActive ? "Active" : "Inactive"}</Badge></div></CardContent></Card>
            ))}
          </TabsContent>

          <TabsContent value="appointments" className="pt-4 space-y-3">
            <div className="flex justify-end">
              <Dialog open={apptOpen} onOpenChange={setApptOpen}>
                <DialogTrigger asChild><Button size="sm"><Plus className="w-4 h-4 mr-1" />Book Appointment</Button></DialogTrigger>
                <DialogContent>
                  <DialogHeader><DialogTitle>Book Appointment</DialogTitle></DialogHeader>
                  <div className="space-y-3 pt-2">
                    <Input placeholder="Service ID" value={apptForm.serviceId} onChange={e => setApptForm(f => ({ ...f, serviceId: e.target.value }))} />
                    <Input placeholder="Customer Phone" value={apptForm.customerPhone} onChange={e => setApptForm(f => ({ ...f, customerPhone: e.target.value }))} />
                    <Input placeholder="Customer Name" value={apptForm.customerName} onChange={e => setApptForm(f => ({ ...f, customerName: e.target.value }))} />
                    <Input type="datetime-local" value={apptForm.scheduledAt} onChange={e => setApptForm(f => ({ ...f, scheduledAt: e.target.value }))} />
                    <Button className="w-full" onClick={() => bookAppt.mutate({ tenantId: TENANT_ID, ...apptForm })} disabled={bookAppt.isPending}>Book</Button>
                  </div>
                </DialogContent>
              </Dialog>
            </div>
            {(appointments ?? []).map(a => (
              <Card key={a.id}><CardContent className="pt-4"><div className="flex items-center justify-between"><div><p className="font-semibold">{a.customerName ?? a.customerPhone}</p><p className="text-sm text-gray-500">{new Date(a.scheduledAt).toLocaleString()} | {a.durationMinutes}min</p></div><div className="flex items-center gap-2"><Badge className={statusColor(a.status)}>{a.status}</Badge>{a.status === "scheduled" && <Button size="sm" variant="outline" onClick={() => updateApptStatus.mutate({ id: a.id, status: "confirmed" })}>Confirm</Button>}</div></div></CardContent></Card>
            ))}
          </TabsContent>

          <TabsContent value="subscriptions" className="pt-4 space-y-3">
            {(subscriptions ?? []).map(s => (
              <Card key={s.id}><CardContent className="pt-4"><div className="flex items-center justify-between"><div><p className="font-semibold">{s.customerName ?? s.customerPhone}</p><p className="text-sm text-gray-500">{s.billingCycle} | {s.currency} {s.amount} | Renews {new Date(s.currentPeriodEnd).toLocaleDateString()}</p></div><Badge className={s.status === "active" ? "bg-green-100 text-green-800" : "bg-gray-100 text-gray-600"}>{s.status}</Badge></div></CardContent></Card>
            ))}
            {(subscriptions ?? []).length === 0 && <p className="text-center text-gray-400 py-8">No subscriptions yet.</p>}
          </TabsContent>

          <TabsContent value="digital" className="pt-4 space-y-3">
            {(digitalProducts ?? []).map(p => (
              <Card key={p.id}><CardContent className="pt-4"><div className="flex items-center justify-between"><div><p className="font-semibold">{p.name}</p><p className="text-sm text-gray-500">{p.currency} {p.price} | Downloads: {p.downloadLimit}</p></div><Badge className={p.isActive ? "bg-green-100 text-green-800" : "bg-gray-100 text-gray-600"}>{p.isActive ? "Active" : "Inactive"}</Badge></div></CardContent></Card>
            ))}
            {(digitalProducts ?? []).length === 0 && <p className="text-center text-gray-400 py-8">No digital products yet.</p>}
          </TabsContent>
        </Tabs>
      </div>
    </DashboardLayout>
  );
}
