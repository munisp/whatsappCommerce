// === W55 ui-a ===
/**
 * W55 (Coder UI-A): EventsHub — merchant surface for the W53 events router
 * (ticketing). Event list + create, publish/cancel lifecycle, ticket-type
 * management (integer cents), per-event sales/ticket list, and door check-in
 * by ticket code. Buyer purchase stays chat/USSD-only by design.
 */
import { useState } from "react";
import { useActiveTenant } from "@/contexts/TenantContext";
import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";

function fmt(cents: number, currency = "NGN") {
  return `${currency} ${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtDate(d: string | Date | null | undefined) {
  return d ? new Date(d).toLocaleString() : "—";
}

const statusVariant = (s: string) =>
  s === "published" ? "default" : s === "cancelled" ? "destructive" : "secondary";

export default function EventsHub() {
  const { activeTenantId: tenantId } = useActiveTenant();
  const utils = trpc.useUtils();
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [selected, setSelected] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [checkInCode, setCheckInCode] = useState("");

  // Create-event form state
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [venue, setVenue] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [capacity, setCapacity] = useState("");

  // Ticket-type form state
  const [ttName, setTtName] = useState("");
  const [ttPriceMajor, setTtPriceMajor] = useState("1000");
  const [ttQuantity, setTtQuantity] = useState("100");
  const [ttMaxPerOrder, setTtMaxPerOrder] = useState("");

  const { data: events } = trpc.events.listEvents.useQuery({
    tenantId,
    status: statusFilter === "all" ? undefined : (statusFilter as any),
  });
  const { data: sales } = trpc.events.sales.useQuery(
    { tenantId, eventId: selected! },
    { enabled: !!selected },
  );

  const onError = (e: any) => toast.error(e?.message ?? "Failed");
  const invalidate = () => {
    utils.events.listEvents.invalidate();
    if (selected) utils.events.sales.invalidate({ tenantId, eventId: selected });
  };
  const createMut = trpc.events.createEvent.useMutation({
    onSuccess: () => {
      toast.success("Event created (draft)");
      setCreateOpen(false);
      setTitle(""); setDescription(""); setVenue(""); setStartsAt(""); setEndsAt(""); setCapacity("");
      invalidate();
    },
    onError,
  });
  const publishMut = trpc.events.publishEvent.useMutation({
    onSuccess: () => { toast.success("Event published"); invalidate(); }, onError,
  });
  const cancelMut = trpc.events.cancelEvent.useMutation({
    onSuccess: () => { toast.success("Event cancelled — paid tickets flagged for refund"); invalidate(); }, onError,
  });
  const addTtMut = trpc.events.addTicketType.useMutation({
    onSuccess: () => { toast.success("Ticket type added"); setTtName(""); invalidate(); }, onError,
  });
  const checkInMut = trpc.events.checkIn.useMutation({
    onSuccess: (r: any) => {
      toast.success(`Checked in ${r.ticket?.code?.toUpperCase?.() ?? checkInCode.toUpperCase()}`);
      setCheckInCode("");
      invalidate();
    },
    onError,
  });

  const selectedEvent = (events ?? []).find((e: any) => e.id === selected);

  return (
    <DashboardLayout>
      <div className="space-y-6 p-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">Events & Ticketing</h1>
          <Dialog open={createOpen} onOpenChange={setCreateOpen}>
            <DialogTrigger asChild><Button>Create event</Button></DialogTrigger>
            <DialogContent>
              <DialogHeader><DialogTitle>Create event</DialogTitle></DialogHeader>
              <div className="space-y-3">
                <div><Label>Title</Label><Input value={title} onChange={(e) => setTitle(e.target.value)} /></div>
                <div><Label>Description</Label><Textarea value={description} onChange={(e) => setDescription(e.target.value)} /></div>
                <div><Label>Venue</Label><Input value={venue} onChange={(e) => setVenue(e.target.value)} /></div>
                <div className="grid grid-cols-2 gap-3">
                  <div><Label>Starts at</Label><Input type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} /></div>
                  <div><Label>Ends at</Label><Input type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} /></div>
                </div>
                <div><Label>Capacity (optional)</Label><Input value={capacity} onChange={(e) => setCapacity(e.target.value)} inputMode="numeric" /></div>
                <Button
                  disabled={createMut.isPending || !title || !startsAt}
                  onClick={() => createMut.mutate({
                    tenantId,
                    title,
                    description: description || undefined,
                    venue: venue || undefined,
                    startsAt: new Date(startsAt),
                    endsAt: endsAt ? new Date(endsAt) : undefined,
                    capacity: capacity ? parseInt(capacity, 10) : undefined,
                  })}
                >Create draft</Button>
              </div>
            </DialogContent>
          </Dialog>
        </div>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>Events</CardTitle>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                <SelectItem value="draft">Draft</SelectItem>
                <SelectItem value="published">Published</SelectItem>
                <SelectItem value="cancelled">Cancelled</SelectItem>
                <SelectItem value="completed">Completed</SelectItem>
              </SelectContent>
            </Select>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader><TableRow><TableHead>Title</TableHead><TableHead>Venue</TableHead><TableHead>Starts</TableHead><TableHead>Capacity</TableHead><TableHead>Status</TableHead><TableHead>Actions</TableHead></TableRow></TableHeader>
              <TableBody>
                {(events ?? []).map((ev: any) => (
                  <TableRow key={ev.id} className={selected === ev.id ? "bg-muted/50" : "cursor-pointer"} onClick={() => setSelected(ev.id)}>
                    <TableCell className="font-medium">{ev.title}</TableCell>
                    <TableCell>{ev.venue ?? "—"}</TableCell>
                    <TableCell>{fmtDate(ev.startsAt)}</TableCell>
                    <TableCell>{ev.capacity ?? "—"}</TableCell>
                    <TableCell><Badge variant={statusVariant(ev.status)}>{ev.status}</Badge></TableCell>
                    <TableCell className="space-x-2" onClick={(e) => e.stopPropagation()}>
                      {ev.status === "draft" && (
                        <Button size="sm" variant="outline" disabled={publishMut.isPending}
                          onClick={() => publishMut.mutate({ tenantId, eventId: ev.id })}>Publish</Button>
                      )}
                      {(ev.status === "draft" || ev.status === "published") && (
                        <Button size="sm" variant="destructive" disabled={cancelMut.isPending}
                          onClick={() => cancelMut.mutate({ tenantId, eventId: ev.id })}>Cancel</Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
                {(events ?? []).length === 0 && <TableRow><TableCell colSpan={6}>No events yet.</TableCell></TableRow>}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Door check-in</CardTitle></CardHeader>
          <CardContent className="flex flex-wrap items-end gap-4">
            <div className="min-w-64"><Label>Ticket code</Label><Input value={checkInCode} onChange={(e) => setCheckInCode(e.target.value)} placeholder="e.g. A1B2C3" /></div>
            <Button disabled={checkInMut.isPending || checkInCode.trim().length < 3}
              onClick={() => checkInMut.mutate({ tenantId, code: checkInCode.trim() })}>Check in</Button>
          </CardContent>
        </Card>

        {selected && sales && (
          <>
            <Card>
              <CardHeader><CardTitle>Ticket types — {selectedEvent?.title ?? "event"}</CardTitle></CardHeader>
              <CardContent className="space-y-4">
                <Table>
                  <TableHeader><TableRow><TableHead>Name</TableHead><TableHead>Price</TableHead><TableHead>Quantity</TableHead><TableHead>Sold</TableHead><TableHead>Remaining</TableHead><TableHead>Max/order</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {sales.ticketTypes.map((t: any) => (
                      <TableRow key={t.id}>
                        <TableCell>{t.name}</TableCell>
                        <TableCell>{fmt(t.priceCents, t.currency)}</TableCell>
                        <TableCell>{t.quantity}</TableCell>
                        <TableCell>{t.soldCount}</TableCell>
                        <TableCell>{Math.max(0, t.quantity - t.soldCount)}</TableCell>
                        <TableCell>{t.maxPerOrder ?? "—"}</TableCell>
                      </TableRow>
                    ))}
                    {sales.ticketTypes.length === 0 && <TableRow><TableCell colSpan={6}>No ticket types yet.</TableCell></TableRow>}
                  </TableBody>
                </Table>
                {selectedEvent && selectedEvent.status !== "cancelled" && (
                  <div className="flex flex-wrap items-end gap-4 border-t pt-4">
                    <div><Label>Name</Label><Input value={ttName} onChange={(e) => setTtName(e.target.value)} placeholder="Regular" /></div>
                    <div><Label>Price (major)</Label><Input value={ttPriceMajor} onChange={(e) => setTtPriceMajor(e.target.value)} inputMode="decimal" /></div>
                    <div><Label>Quantity</Label><Input value={ttQuantity} onChange={(e) => setTtQuantity(e.target.value)} inputMode="numeric" /></div>
                    <div><Label>Max per order</Label><Input value={ttMaxPerOrder} onChange={(e) => setTtMaxPerOrder(e.target.value)} inputMode="numeric" /></div>
                    <Button
                      disabled={addTtMut.isPending || !ttName || !ttQuantity}
                      onClick={() => addTtMut.mutate({
                        tenantId, eventId: selected,
                        name: ttName,
                        priceCents: Math.round(parseFloat(ttPriceMajor || "0") * 100),
                        quantity: parseInt(ttQuantity, 10),
                        maxPerOrder: ttMaxPerOrder ? parseInt(ttMaxPerOrder, 10) : undefined,
                      })}
                    >Add ticket type</Button>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle>Sales & tickets</CardTitle>
                <div className="text-sm">Revenue: <b>{fmt(sales.revenueCents, sales.ticketTypes[0]?.currency ?? "NGN")}</b></div>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader><TableRow><TableHead>Code</TableHead><TableHead>Status</TableHead><TableHead>Ticket type</TableHead><TableHead>Order</TableHead><TableHead>Checked in</TableHead><TableHead>Created</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {sales.tickets.map((t: any) => (
                      <TableRow key={t.ticketId}>
                        <TableCell className="font-mono">{t.code}</TableCell>
                        <TableCell><Badge variant={t.status === "checked_in" ? "default" : "secondary"}>{t.status}</Badge></TableCell>
                        <TableCell className="font-mono">{sales.ticketTypes.find((x: any) => x.id === t.ticketTypeId)?.name ?? t.ticketTypeId}</TableCell>                        <TableCell className="font-mono">{t.orderId ?? "—"}</TableCell>
                        <TableCell>{fmtDate(t.checkedInAt)}</TableCell>
                        <TableCell>{fmtDate(t.createdAt)}</TableCell>
                      </TableRow>
                    ))}
                    {sales.tickets.length === 0 && <TableRow><TableCell colSpan={6}>No tickets sold yet.</TableCell></TableRow>}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </DashboardLayout>
  );
}
// === END W55 ui-a ===
