/** Template gallery: browse, preview on desktop and phone, and apply. Applying only changes the unpublished design. */
import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { Check, Eye, LayoutTemplate, Monitor, Search, Smartphone, X } from "lucide-react";
import { toast } from "sonner";
import DashboardLayout from "@/components/DashboardLayout";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";
import { BLANK_TEMPLATE, STORE_TEMPLATES, TEMPLATE_CATEGORIES, type StoreTemplate } from "@shared/storefront/templates";

function Thumb({ template }: { template: StoreTemplate }) {
  return (
    <div className="relative aspect-[4/3] overflow-hidden border-b border-border bg-muted">
      <img src={`/images/store-templates/${template.id}-desktop.webp`} alt={`${template.name} on a computer`} loading="lazy" className="h-full w-full object-cover object-top" />
      <img src={`/images/store-templates/${template.id}-mobile.webp`} alt={`${template.name} on a phone`} loading="lazy" className="absolute bottom-2 right-2 w-[22%] rounded-sm border-2 border-[var(--oak-charcoal)] bg-white shadow-md" />
    </div>
  );
}

export default function StorefrontTemplates() {
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const design = trpc.storefront.design.get.useQuery();
  // Previews open in a frame, so make sure this browser isn't holding an old copy of the app.
  useEffect(() => { void navigator.serviceWorker?.getRegistration().then((w) => w?.update()).catch(() => undefined); }, []);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("All");
  const [preview, setPreview] = useState<StoreTemplate | null>(null);
  const [device, setDevice] = useState<"desktop" | "phone">("desktop");
  const apply = trpc.storefront.design.applyTemplate.useMutation({
    onSuccess: async () => {
      await utils.storefront.design.get.invalidate();
      toast.success("Template applied to your draft. Your live store hasn't changed yet.");
      navigate("/settings/storefront/builder");
    },
    onError: (e) => toast.error(e.message),
  });
  const list = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return STORE_TEMPLATES.filter((t) => (category === "All" || t.category === category)
      && words.every((w) => `${t.name} ${t.category} ${t.description}`.toLowerCase().includes(w)));
  }, [query, category]);
  const useTemplate = (t: StoreTemplate) => apply.mutate({ templateId: t.id });
  const activeId = design.data?.templateId;
  const liveId = design.data?.publishedTemplateId;
  const showBlank = category === "All" && !query;

  return (
    <DashboardLayout>
      <div className="space-y-6 p-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-3xl">Store templates</h1>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">Pick a starting design, then make it yours. Switching template changes only how your store looks. Your products, customers and orders stay exactly as they are, and nothing goes live until you publish.</p>
          </div>
          <Button variant="outline" onClick={() => navigate("/settings/storefront/builder")}>Open the builder</Button>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <label className="relative w-full max-w-xs">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" aria-hidden="true" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search templates" aria-label="Search templates" className="w-full rounded border border-input bg-background py-2 pl-9 pr-3 text-sm" />
          </label>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter by category">
            {["All", ...TEMPLATE_CATEGORIES].map((c) => (
              <button key={c} type="button" aria-pressed={category === c} onClick={() => setCategory(c)} className={`rounded border px-2.5 py-1 text-xs ${category === c ? "border-primary bg-primary text-primary-foreground" : "border-border bg-background hover:bg-muted"}`}>{c}</button>
            ))}
          </div>
        </div>

        {showBlank && (
          <article className="flex flex-wrap items-center justify-between gap-4 rounded border border-dashed border-border bg-card p-5">
            <div className="flex items-center gap-4">
              <LayoutTemplate className="h-8 w-8 text-muted-foreground" aria-hidden="true" />
              <div>
                <h2 className="text-lg">{BLANK_TEMPLATE.name}{activeId === "blank" && <span className="ml-2 align-middle text-xs font-semibold text-primary">In your draft</span>}</h2>
                <p className="max-w-xl text-sm text-muted-foreground">{BLANK_TEMPLATE.description}</p>
              </div>
            </div>
            <Button onClick={() => useTemplate(BLANK_TEMPLATE)} disabled={apply.isPending}>Start from scratch</Button>
          </article>
        )}

        {list.length === 0 && <p className="py-12 text-center text-sm text-muted-foreground">No templates match that. Try another word or category.</p>}
        <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
          {list.map((t) => (
            <article key={t.id} className={`overflow-hidden rounded border bg-card ${activeId === t.id ? "border-primary ring-1 ring-primary" : "border-border"}`}>
              <Thumb template={t} />
              <div className="space-y-2 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-lg">{t.name}</h2>
                  <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{t.category}</span>
                  {liveId === t.id && <span className="inline-flex items-center gap-1 text-xs font-semibold text-primary"><Check className="h-3 w-3" aria-hidden="true" /> Live</span>}
                  {activeId === t.id && liveId !== t.id && <span className="text-xs font-semibold text-primary">In your draft</span>}
                </div>
                <p className="min-h-[3.75rem] text-sm text-muted-foreground">{t.description}</p>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" className="flex-1 gap-1.5" onClick={() => { setPreview(t); setDevice("desktop"); }}><Eye className="h-4 w-4" aria-hidden="true" /> Preview</Button>
                  <Button size="sm" className="flex-1" onClick={() => useTemplate(t)} disabled={apply.isPending}>Use template</Button>
                </div>
              </div>
            </article>
          ))}
        </div>
      </div>

      {preview && (
        <div className="fixed inset-0 z-[100] flex flex-col bg-background" role="dialog" aria-modal="true" aria-label={`Preview of ${preview.name}`}>
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-2.5">
            <div className="flex items-center gap-3"><Button variant="ghost" size="sm" aria-label="Close preview" onClick={() => setPreview(null)}><X className="h-4 w-4" /></Button><strong>{preview.name}</strong><span className="text-sm text-muted-foreground">{preview.category}</span></div>
            <div className="flex items-center gap-2">
              <div className="flex rounded border border-border" role="group" aria-label="Preview size">
                <button type="button" aria-pressed={device === "desktop"} aria-label="Computer" className={`p-2 ${device === "desktop" ? "bg-muted" : ""}`} onClick={() => setDevice("desktop")}><Monitor className="h-4 w-4" /></button>
                <button type="button" aria-pressed={device === "phone"} aria-label="Phone" className={`p-2 ${device === "phone" ? "bg-muted" : ""}`} onClick={() => setDevice("phone")}><Smartphone className="h-4 w-4" /></button>
              </div>
              <Button onClick={() => useTemplate(preview)} disabled={apply.isPending}>Use this template</Button>
            </div>
          </div>
          <div className="flex flex-1 justify-center overflow-hidden bg-muted p-3">
            <iframe key={preview.id} title={`${preview.name} preview`} src={`/store-preview/${preview.id}`} className={`h-full border border-border bg-white ${device === "phone" ? "w-[390px]" : "w-full"}`} />
          </div>
        </div>
      )}
    </DashboardLayout>
  );
}

