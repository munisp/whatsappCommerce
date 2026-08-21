/**
 * W27 catalog-ai — tenant portal review page for AI-drafted listings
 * (WhatsApp voice-note / photo → draft). Merchants review, edit, publish or
 * reject drafts before they go live in the catalog.
 */
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";

type Draft = {
  id: string;
  tenantId: string;
  source: "voice" | "photo";
  merchantPhone: string;
  status: string;
  transcript: string | null;
  name: string | null;
  description: string | null;
  category: string | null;
  suggestedPriceCents: number | null;
  priceBandLowCents: number | null;
  priceBandHighCents: number | null;
  currency: string;
  productId: string | null;
  createdAt: string | Date;
};

function fmt(cents: number | null, currency: string): string {
  if (cents == null) return "—";
  return `${currency} ${(cents / 100).toFixed(2)}`;
}

function DraftCard({ draft, tenantId, onChanged }: { draft: Draft; tenantId: string; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(draft.name ?? "");
  const [description, setDescription] = useState(draft.description ?? "");
  const [category, setCategory] = useState(draft.category ?? "");
  const [price, setPrice] = useState(draft.suggestedPriceCents != null ? (draft.suggestedPriceCents / 100).toFixed(2) : "");

  const utils = trpc.useUtils();
  const invalidate = () => {
    utils.catalogAI.listDrafts.invalidate();
    onChanged();
  };
  const updateMut = trpc.catalogAI.updateDraft.useMutation({
    onSuccess: (r) => { r.ok ? (toast.success("Draft updated"), setEditing(false), invalidate()) : toast.error(`Update failed: ${r.error}`); },
    onError: (e) => toast.error(e.message),
  });
  const publishMut = trpc.catalogAI.publishDraft.useMutation({
    onSuccess: (r) => { r.ok ? (toast.success("Published to catalog"), invalidate()) : toast.error(`Publish failed: ${r.error}`); },
    onError: (e) => toast.error(e.message),
  });
  const rejectMut = trpc.catalogAI.rejectDraft.useMutation({
    onSuccess: (r) => { r.ok ? (toast.success("Draft rejected"), invalidate()) : toast.error(`Reject failed: ${r.error}`); },
    onError: (e) => toast.error(e.message),
  });

  const pending = draft.status === "pending_confirm" || draft.status === "confirmed";
  const priceCents = price.trim() === "" ? null : Math.round(parseFloat(price) * 100);

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base font-semibold">{draft.name ?? "Untitled draft"}</CardTitle>
          <div className="flex items-center gap-2">
            <Badge variant="outline">{draft.source === "voice" ? "🎙 voice" : "📷 photo"}</Badge>
            <Badge variant={draft.status === "published" ? "default" : draft.status === "rejected" ? "destructive" : "secondary"}>
              {draft.status.replace("_", " ")}
            </Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {draft.transcript && (
          <p className="text-xs text-muted-foreground italic">“{draft.transcript}”</p>
        )}
        {editing ? (
          <div className="space-y-2">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Product name" />
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Description" rows={3} />
            <div className="flex gap-2">
              <Input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="Category" className="w-1/2" />
              <Input value={price} onChange={(e) => setPrice(e.target.value)} placeholder={`Price (${draft.currency})`} type="number" min="0" step="0.01" className="w-1/2" />
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => updateMut.mutate({
                tenantId, draftId: draft.id, name, description, category,
                priceCents: priceCents != null && Number.isInteger(priceCents) ? priceCents : null,
              })} disabled={updateMut.isPending}>Save</Button>
              <Button size="sm" variant="outline" onClick={() => setEditing(false)}>Cancel</Button>
            </div>
          </div>
        ) : (
          <>
            <p className="text-sm">{draft.description}</p>
            <div className="text-sm text-muted-foreground">
              Category: {draft.category ?? "other"} · Price: {fmt(draft.suggestedPriceCents, draft.currency)}
              {draft.priceBandLowCents != null && draft.priceBandHighCents != null && (
                <> · typical {fmt(draft.priceBandLowCents, draft.currency)}–{fmt(draft.priceBandHighCents, draft.currency)}</>
              )}
            </div>
            {draft.productId && <p className="text-xs text-muted-foreground">Product: {draft.productId}</p>}
            {pending && (
              <div className="flex gap-2 pt-1">
                <Button size="sm" onClick={() => publishMut.mutate({ tenantId, draftId: draft.id })} disabled={publishMut.isPending}>
                  ✅ Publish
                </Button>
                <Button size="sm" variant="outline" onClick={() => setEditing(true)}>✏️ Edit</Button>
                <Button size="sm" variant="destructive" onClick={() => rejectMut.mutate({ tenantId, draftId: draft.id })} disabled={rejectMut.isPending}>
                  ❌ Reject
                </Button>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

export default function CatalogAIDrafts() {
  const { user } = useAuth();
  const [tenantId, setTenantId] = useState<string>("");
  const [status, setStatus] = useState<string>("pending_confirm");

  const { data: tenantsData } = trpc.tenant.list.useQuery(undefined, { enabled: !!user });
  const tenants = (tenantsData as any)?.tenants ?? tenantsData ?? [];
  const effectiveTenantId = tenantId || tenants[0]?.id || "";

  const { data: drafts, isLoading, refetch } = trpc.catalogAI.listDrafts.useQuery(
    {
      tenantId: effectiveTenantId,
      ...(status !== "all" ? { status: status as any } : {}),
    },
    { enabled: !!effectiveTenantId },
  );

  return (
    <DashboardLayout>
      <div className="space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div>
            <h1 className="text-2xl font-bold">AI Listing Drafts</h1>
            <p className="text-sm text-muted-foreground">
              Review listings drafted from WhatsApp voice notes and product photos before publishing.
            </p>
          </div>
          <div className="flex gap-2">
            <Select value={effectiveTenantId} onValueChange={setTenantId}>
              <SelectTrigger className="w-48"><SelectValue placeholder="Tenant" /></SelectTrigger>
              <SelectContent>
                {tenants.map((t: any) => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger className="w-44"><SelectValue placeholder="Status" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="pending_confirm">Pending review</SelectItem>
                <SelectItem value="published">Published</SelectItem>
                <SelectItem value="rejected">Rejected</SelectItem>
                <SelectItem value="all">All</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        {isLoading ? (
          <div className="space-y-3">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-32 w-full" />)}</div>
        ) : !drafts || drafts.length === 0 ? (
          <Card><CardContent className="py-10 text-center text-muted-foreground">
            No drafts here yet. Send a voice note or product photo from the merchant WhatsApp number to create one.
          </CardContent></Card>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {(drafts as Draft[]).map((d) => (
              <DraftCard key={d.id} draft={d} tenantId={effectiveTenantId} onChanged={() => refetch()} />
            ))}
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
