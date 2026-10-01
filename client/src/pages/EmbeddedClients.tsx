// === W55 ui-c ===
// Platform-admin embedded API client lifecycle for the W33 embedded router
// (ORPHAN-BE-12): create (one-time plaintext key), suspend, rotate, list.
import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { trpc } from "@/lib/trpc";
import { formatDistanceToNow } from "date-fns";
import { Copy, KeyRound, Plus, RefreshCw, Ban } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

const ALL_SCOPES = ["bills:read", "bills:write", "payments:read", "payments:write", "invoices:read", "invoices:write"];

const statusColors: Record<string, string> = {
  active: "bg-green-500/20 text-green-400 border-green-500/30",
  suspended: "bg-red-500/20 text-red-400 border-red-500/30",
};

function OneTimeKeyDialog({ apiKey, onClose }: { apiKey: string | null; onClose: () => void }) {
  return (
    <Dialog open={!!apiKey} onOpenChange={() => onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>API key — shown once</DialogTitle></DialogHeader>
        <p className="text-sm text-muted-foreground">
          Store this key now. Only its SHA-256 digest is persisted; it cannot be recovered later (rotate instead).
        </p>
        <div className="flex items-center gap-2">
          <code className="flex-1 text-xs bg-muted/40 rounded-md p-3 break-all">{apiKey}</code>
          <Button variant="outline" size="sm" onClick={() => { navigator.clipboard.writeText(apiKey ?? ""); toast.success("Copied"); }}>
            <Copy className="w-4 h-4" />
          </Button>
        </div>
        <DialogFooter>
          <Button onClick={onClose}>I've stored it</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function EmbeddedClients() {
  const utils = trpc.useUtils();
  const { data, isLoading } = trpc.embedded.listClients.useQuery({});
  const clients = data?.clients ?? [];

  const [createOpen, setCreateOpen] = useState(false);
  const [oneTimeKey, setOneTimeKey] = useState<string | null>(null);
  const [form, setForm] = useState({ partnerName: "", tenantId: "", scopes: [] as string[] });

  const invalidate = () => utils.embedded.listClients.invalidate();

  const createMut = trpc.embedded.createClient.useMutation({
    onSuccess: (r) => {
      setCreateOpen(false);
      setOneTimeKey(r.apiKey);
      setForm({ partnerName: "", tenantId: "", scopes: [] });
      invalidate();
    },
    onError: (e) => toast.error(e.message),
  });
  const suspendMut = trpc.embedded.suspendClient.useMutation({
    onSuccess: () => { toast.success("Client suspended — its key now fails authentication"); invalidate(); },
    onError: (e) => toast.error(e.message),
  });
  const rotateMut = trpc.embedded.rotateKey.useMutation({
    onSuccess: (r) => { setOneTimeKey(r.apiKey); invalidate(); },
    onError: (e) => toast.error(e.message),
  });

  const toggleScope = (s: string) =>
    setForm((f) => ({ ...f, scopes: f.scopes.includes(s) ? f.scopes.filter((x) => x !== s) : [...f.scopes, s] }));

  return (
    <DashboardLayout>
      <div className="p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-foreground">Embedded API Clients</h1>
            <p className="text-muted-foreground mt-1">Partner API keys for the /api/embedded/v1 surface</p>
          </div>
          <Button onClick={() => setCreateOpen(true)} className="gap-1">
            <Plus className="w-4 h-4" /> New client
          </Button>
        </div>

        <Card className="bg-card border-border">
          <CardHeader><CardTitle className="text-sm font-medium text-muted-foreground">Clients</CardTitle></CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow className="border-border hover:bg-transparent">
                  <TableHead>Partner</TableHead>
                  <TableHead>Tenant</TableHead>
                  <TableHead>Scopes</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-8">Loading...</TableCell></TableRow>
                ) : clients.length === 0 ? (
                  <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                    <div className="flex flex-col items-center gap-2">
                      <KeyRound className="w-8 h-8 opacity-40" />
                      No embedded API clients yet
                    </div>
                  </TableCell></TableRow>
                ) : clients.map((c: any) => (
                  <TableRow key={c.id} className="border-border hover:bg-accent/30">
                    <TableCell className="font-medium">{c.partnerName}</TableCell>
                    <TableCell className="font-mono text-xs">{c.tenantId}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {(c.scopes as string[]).map((s) => (
                          <Badge key={s} variant="outline" className="text-[10px]">{s}</Badge>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell><Badge variant="outline" className={statusColors[c.status] ?? ""}>{c.status}</Badge></TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {c.createdAt ? formatDistanceToNow(new Date(c.createdAt), { addSuffix: true }) : "—"}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        {c.status === "active" && (
                          <>
                            <Button variant="ghost" size="sm" className="h-7 text-xs gap-1"
                              disabled={rotateMut.isPending}
                              onClick={() => rotateMut.mutate({ clientId: c.id })}>
                              <RefreshCw className="w-3 h-3" /> Rotate key
                            </Button>
                            <Button variant="ghost" size="sm" className="h-7 text-xs gap-1 text-red-400 hover:text-red-300"
                              disabled={suspendMut.isPending}
                              onClick={() => suspendMut.mutate({ clientId: c.id })}>
                              <Ban className="w-3 h-3" /> Suspend
                            </Button>
                          </>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogContent>
            <DialogHeader><DialogTitle>New embedded API client</DialogTitle></DialogHeader>
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>Partner name</Label>
                <Input value={form.partnerName} onChange={(e) => setForm({ ...form, partnerName: e.target.value })} />
              </div>
              <div className="space-y-2">
                <Label>Tenant ID (the client is bound to exactly one tenant)</Label>
                <Input value={form.tenantId} onChange={(e) => setForm({ ...form, tenantId: e.target.value })} className="font-mono" />
              </div>
              <div className="space-y-2">
                <Label>Scopes</Label>
                <div className="grid grid-cols-2 gap-2">
                  {ALL_SCOPES.map((s) => (
                    <label key={s} className="flex items-center gap-2 text-sm">
                      <Checkbox checked={form.scopes.includes(s)} onCheckedChange={() => toggleScope(s)} />
                      <span className="font-mono text-xs">{s}</span>
                    </label>
                  ))}
                </div>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setCreateOpen(false)}>Close</Button>
              <Button
                disabled={createMut.isPending || !form.partnerName.trim() || !form.tenantId.trim() || form.scopes.length === 0}
                onClick={() => createMut.mutate({ partnerName: form.partnerName.trim(), tenantId: form.tenantId.trim(), scopes: form.scopes as any })}
              >
                Create client
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <OneTimeKeyDialog apiKey={oneTimeKey} onClose={() => setOneTimeKey(null)} />
      </div>
    </DashboardLayout>
  );
}
