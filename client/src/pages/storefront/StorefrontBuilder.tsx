/**
 * The visual store builder. The right side is the real store in a frame, so what the merchant sees is what
 * shoppers get; edits reach it instantly by message, reach the database on Save, and shoppers on Publish.
 */
import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { Link, useLocation } from "wouter";
import { ArrowDown, ArrowLeft, ArrowUp, ExternalLink, Eye, EyeOff, GripVertical, ImagePlus, LayoutTemplate, Monitor, Plus, RotateCcw, Smartphone, Trash2, Undo2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";
import {
  CARD_VARIANTS, FOOTER_VARIANTS, GRID_VARIANTS, HEADER_VARIANTS, HERO_VARIANTS, moveSection, section as newSection, STORE_FONTS, storeConfigSchema,
  type SectionType, type StoreConfig, type StoreSection,
} from "@shared/storefront/config";

const SECTION_LABEL: Record<SectionType, string> = {
  hero: "Hero", trust: "Trust strip", categories: "Categories", products: "Product grid", banner: "Banner", collections: "Featured collections",
  about: "About", testimonials: "Reviews", newsletter: "Newsletter", whatsapp: "WhatsApp call-out", text: "Text", gallery: "Image gallery",
};
const SECTION_HELP: Record<SectionType, string> = {
  hero: "The big opening of your page", trust: "Short reassurances in a row", categories: "Links to your product categories", products: "Products you choose, or best sellers, new arrivals, offers", banner: "A promotion or message",
  collections: "Tiles linking to groups of products", about: "Your story, with a photo", testimonials: "Your real customer reviews", newsletter: "Collect emails", whatsapp: "Invite customers to chat", text: "A heading and paragraph", gallery: "A row of photos",
};
const VARIANT_OPTIONS: Partial<Record<SectionType, string[]>> = {
  hero: [...HERO_VARIANTS], categories: ["tiles", "photo", "chips", "text"], banner: ["", "side"], gallery: ["strip", "lookbook"], trust: ["", "spec"], text: ["", "statement"],
};
const VARIANT_NAME: Record<string, string> = {
  fullBleed: "Full-screen photo", split: "Half photo, half text", type: "Big words only", mosaic: "Photo mosaic", spotlight: "One product", search: "Search first", cover: "Centred on photo", stacked: "Words above photo",
  tiles: "Tiles", photo: "Large photos", chips: "Pills", text: "Words only", "": "Standard", side: "Photo beside text", strip: "Even row", lookbook: "Lookbook", spec: "Detailed", statement: "Large statement",
  classic: "Classic", centered: "Centred logo", searchFirst: "Search first", minimal: "Minimal menu", ticker: "Scrolling ticker", columns: "Columns", wordmark: "Giant name", bar: "Slim bar",
  editorial: "Editorial", overlay: "Text on photo", boxed: "Boxed with button", compact: "Compact, quick add", tile: "Tinted tile", row: "Price list row", menu: "Menu item", plain: "Quiet and centred", grid: "Grid", rail: "Swipe row", list: "List",
};
const PRODUCT_SOURCE_NAME: Record<string, string> = { all: "All products", featured: "Featured", bestSellers: "Best sellers", newArrivals: "New arrivals", onSale: "On sale", category: "One category", manual: "Hand-picked" };
const COLOUR_FIELDS: [keyof StoreConfig["theme"], string][] = [["background", "Page"], ["surface", "Panels"], ["text", "Text"], ["muted", "Quiet text"], ["line", "Lines"], ["accent", "Accent"], ["accentText", "Text on accent"], ["inverse", "Contrast band"], ["inverseText", "Text on band"], ["sale", "Sale price"]];
const inputClass = "w-full rounded border border-input bg-background px-2.5 py-1.5 text-sm";

const Field = ({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) => (
  <label className="block space-y-1 text-xs font-medium"><span>{label}</span>{children}{hint && <span className="block font-normal text-muted-foreground">{hint}</span>}</label>
);

function Choice({ label, value, options, onChange, names = VARIANT_NAME }: { label: string; value: string; options: readonly string[]; onChange: (v: string) => void; names?: Record<string, string> }) {
  return <Field label={label}><select className={inputClass} value={value} onChange={(e) => onChange(e.target.value)}>{options.map((o) => <option key={o} value={o}>{names[o] ?? o}</option>)}</select></Field>;
}

function ImageField({ label, value, onChange }: { label: string; value: string; onChange: (url: string) => void }) {
  const upload = trpc.storefront.design.uploadImage.useMutation({ onError: (e) => toast.error(e.message) });
  const inputRef = useRef<HTMLInputElement>(null);
  const pick = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) { toast.error("Use a JPG, PNG or WebP image"); return; }
    if (file.size > 8 * 1024 * 1024) { toast.error("Images must be 8MB or smaller"); return; }
    const base64 = await new Promise<string>((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.onerror = reject; r.readAsDataURL(file); });
    const { url } = await upload.mutateAsync({ base64, mimeType: file.type as "image/jpeg" });
    onChange(url);
  };
  return (
    <div className="space-y-1 text-xs font-medium">
      <span>{label}</span>
      <div className="flex items-center gap-2">
        <div className="h-14 w-20 flex-none overflow-hidden rounded border border-border bg-muted">{value && <img src={value} alt="" className="h-full w-full object-cover" />}</div>
        <div className="flex flex-wrap gap-1.5">
          <Button type="button" variant="outline" size="sm" className="gap-1" disabled={upload.isPending} onClick={() => inputRef.current?.click()}><ImagePlus className="h-3.5 w-3.5" aria-hidden="true" /> {upload.isPending ? "Uploading…" : "Upload"}</Button>
          {value && <Button type="button" variant="ghost" size="sm" onClick={() => onChange("")}>Remove</Button>}
        </div>
        <input ref={inputRef} type="file" accept="image/jpeg,image/png,image/webp" hidden aria-label={`Upload ${label}`} onChange={pick} />
      </div>
    </div>
  );
}

function SectionEditor({ s, onChange, categories, products }: { s: StoreSection; onChange: (patch: Partial<StoreSection>) => void; categories: string[]; products: { id: string; name: string }[] }) {
  const text = (key: "eyebrow" | "title" | "ctaLabel" | "ctaHref", label: string, hint?: string) => <Field label={label} hint={hint}><input className={inputClass} value={s[key]} onChange={(e) => onChange({ [key]: e.target.value })} /></Field>;
  const variants = VARIANT_OPTIONS[s.type];
  const setItem = (i: number, patch: Partial<StoreSection["items"][number]>) => onChange({ items: s.items.map((it, n) => (n === i ? { ...it, ...patch } : it)) });
  const usesItems = s.type === "gallery" || s.type === "collections" || s.type === "trust" || s.type === "testimonials" || (s.type === "hero" && s.variant === "mosaic");
  return (
    <div className="space-y-3 border-t border-border bg-muted/40 p-3">
      {variants && <Choice label="Layout" value={s.variant} options={variants} onChange={(variant) => onChange({ variant })} />}
      {!["categories", "trust"].includes(s.type) && text("eyebrow", "Small label above")}
      {s.type !== "trust" && text("title", "Heading")}
      {["hero", "banner", "about", "newsletter", "whatsapp", "text"].includes(s.type) && <Field label="Text"><textarea rows={3} className={inputClass} value={s.body} onChange={(e) => onChange({ body: e.target.value })} /></Field>}
      {["hero", "banner", "about", "whatsapp"].includes(s.type) && !(s.type === "hero" && s.variant === "mosaic") && <ImageField label="Image" value={s.imageUrl} onChange={(imageUrl) => onChange({ imageUrl })} />}
      {["hero", "banner", "about", "text"].includes(s.type) && <>{text("ctaLabel", "Button text")}{text("ctaHref", "Button link", "products, products?sale=1, whatsapp, or a full https:// link")}</>}
      {s.type === "whatsapp" && text("ctaLabel", "Button text")}
      {s.type === "products" && <>
        <Choice label="Which products" value={s.source} options={Object.keys(PRODUCT_SOURCE_NAME)} names={PRODUCT_SOURCE_NAME} onChange={(source) => onChange({ source: source as StoreSection["source"] })} />
        {s.source === "category" && <Choice label="Category" value={s.category} options={["", ...categories]} names={{ "": "Choose…" }} onChange={(category) => onChange({ category })} />}
        {s.source === "manual" && <Field label="Products"><select multiple size={Math.min(6, products.length || 1)} className={inputClass} value={s.productIds} onChange={(e) => onChange({ productIds: Array.from(e.target.selectedOptions).map((o) => o.value).slice(0, 24) })}>{products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>}
        <div className="grid grid-cols-2 gap-2">
          <Choice label="Arrangement" value={s.grid} options={GRID_VARIANTS} onChange={(grid) => onChange({ grid: grid as StoreSection["grid"] })} />
          <Choice label="Card style" value={s.card} options={["", ...CARD_VARIANTS]} names={{ ...VARIANT_NAME, "": "Store default" }} onChange={(card) => onChange({ card: card as StoreSection["card"] })} />
          <Field label="Per row"><input type="number" min={1} max={6} className={inputClass} value={s.columns} onChange={(e) => onChange({ columns: clamp(e.target.value, 1, 6) })} /></Field>
          <Field label="How many"><input type="number" min={1} max={24} className={inputClass} value={s.limit} onChange={(e) => onChange({ limit: clamp(e.target.value, 1, 24) })} /></Field>
        </div>
      </>}
      <div className="grid grid-cols-2 gap-2">
        <Choice label="Background" value={s.tone} options={["", "surface", "accent", "inverse"]} names={{ "": "Page", surface: "Panel", accent: "Accent", inverse: "Contrast" }} onChange={(tone) => onChange({ tone: tone as StoreSection["tone"] })} />
        <Choice label="Align" value={s.align} options={["left", "center", "right"]} names={{ left: "Left", center: "Centre", right: "Right" }} onChange={(align) => onChange({ align: align as StoreSection["align"] })} />
      </div>
      {usesItems && (
        <div className="space-y-2">
          <p className="text-xs font-medium">{s.type === "testimonials" ? "Quotes you've been given (real reviews appear automatically)" : "Items"}</p>
          {s.items.map((item, i) => (
            <div key={i} className="space-y-2 rounded border border-border bg-background p-2">
              {s.type !== "trust" && s.type !== "testimonials" && <ImageField label={`Image ${i + 1}`} value={item.imageUrl} onChange={(imageUrl) => setItem(i, { imageUrl })} />}
              <input className={inputClass} placeholder={s.type === "testimonials" ? "Customer's name" : "Title"} aria-label="Title" value={item.title} onChange={(e) => setItem(i, { title: e.target.value })} />
              {(s.type === "trust" || s.type === "testimonials") && <input className={inputClass} placeholder={s.type === "testimonials" ? "What they said" : "Detail"} aria-label="Detail" value={item.text} onChange={(e) => setItem(i, { text: e.target.value })} />}
              {s.type !== "trust" && s.type !== "testimonials" && <input className={inputClass} placeholder="Link, e.g. products" aria-label="Link" value={item.href} onChange={(e) => setItem(i, { href: e.target.value })} />}
              <Button type="button" variant="ghost" size="sm" onClick={() => onChange({ items: s.items.filter((_, n) => n !== i) })}>Remove item</Button>
            </div>
          ))}
          {s.items.length < 12 && <Button type="button" variant="outline" size="sm" onClick={() => onChange({ items: [...s.items, { title: "", text: "", imageUrl: "", href: "" }] })}>Add item</Button>}
        </div>
      )}
    </div>
  );
}

const clamp = (v: string, min: number, max: number) => Math.min(max, Math.max(min, Number(v) || min));

const DEFAULTS: Record<SectionType, Partial<StoreSection>> = {
  hero: { variant: "type", title: "Your headline", ctaLabel: "Shop now", ctaHref: "products" },
  products: { title: "Products", source: "all", limit: 8 },
  banner: { title: "Your message", ctaLabel: "Shop now", ctaHref: "products", tone: "accent" },
  categories: { title: "Shop by category", variant: "tiles" },
  collections: { title: "Collections", items: [{ title: "Collection", text: "", imageUrl: "", href: "products" }] },
  about: { title: "About us", body: "Tell customers your story." },
  testimonials: { title: "What customers say" },
  newsletter: { title: "Stay in touch", tone: "surface" },
  whatsapp: { title: "Questions? Chat with us", ctaLabel: "Chat on WhatsApp" },
  text: { title: "A heading", body: "Write something here." },
  gallery: { variant: "strip", items: [{ title: "", text: "", imageUrl: "", href: "" }] },
  trust: { items: [{ title: "Secure payment", text: "", imageUrl: "", href: "" }, { title: "Order tracking", text: "", imageUrl: "", href: "" }] },
};

type Tab = "sections" | "style" | "layout" | "business";

export default function StorefrontBuilder() {
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const design = trpc.storefront.design.get.useQuery(undefined, { refetchOnWindowFocus: false });
  const [config, setConfig] = useState<StoreConfig | null>(null);
  const [dirty, setDirty] = useState(false);
  const [tab, setTab] = useState<Tab>("sections");
  const [openId, setOpenId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [device, setDevice] = useState<"desktop" | "phone">("desktop");
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [frameNonce, setFrameNonce] = useState(0);
  const [previewStale, setPreviewStale] = useState(false);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const frameReady = useRef(false);
  const slug = design.data?.slug;
  const shop = trpc.storefront.shop.store.useQuery({ slug: slug ?? "", preview: true }, { enabled: !!slug, retry: false, refetchOnWindowFocus: false });

  useEffect(() => { if (design.data && !config) setConfig(design.data.draft); }, [design.data, config]);
  // Live preview: push every edit into the frame, and again whenever the frame reports it has loaded.
  useEffect(() => { if (config) frameRef.current?.contentWindow?.postMessage({ type: "store-config", config }, window.location.origin); }, [config]);
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin || e.data?.type !== "store-ready") return;
      frameReady.current = true;
      setPreviewStale(false);
      if (config) frameRef.current?.contentWindow?.postMessage({ type: "store-config", config }, window.location.origin);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [config]);
  // The real store announces itself. If the frame never does, this browser kept an old copy of the app,
  // so clear it and load the frame again, once. Only then is it worth bothering the merchant.
  useEffect(() => {
    if (!slug) return;
    frameReady.current = false;
    const timer = window.setTimeout(async () => {
      if (frameReady.current) return;
      let healed = false;
      try { healed = !!sessionStorage.getItem("builderPreviewHealed"); } catch { /* treat as not yet tried */ }
      if (healed) { setPreviewStale(true); return; }
      try { sessionStorage.setItem("builderPreviewHealed", "1"); } catch { /* the reload below still helps */ }
      const workers = await navigator.serviceWorker?.getRegistrations().catch(() => []) ?? [];
      await Promise.all(workers.filter((w) => new URL(w.scope).pathname === "/").map((w) => w.unregister()));
      const names = await window.caches?.keys().catch(() => []) ?? [];
      await Promise.all(names.map((n) => caches.delete(n)));
      setFrameNonce((n) => n + 1);
    }, 8000);
    return () => window.clearTimeout(timer);
  }, [slug, frameNonce]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const update = (next: StoreConfig) => { setConfig(next); setDirty(true); };
  const fail = (e: { message: string }) => toast.error(e.message);
  const replaced = async (draft: StoreConfig, message: string) => { setConfig(draft); setDirty(false); setFrameNonce((n) => n + 1); await utils.storefront.design.get.invalidate(); toast.success(message); };
  const save = trpc.storefront.design.saveDraft.useMutation({ onSuccess: async () => { setDirty(false); await utils.storefront.design.get.invalidate(); toast.success("Draft saved"); }, onError: fail });
  const publish = trpc.storefront.design.publish.useMutation({ onSuccess: async () => { setDirty(false); await utils.storefront.design.get.invalidate(); toast.success("Published. Your store is live."); }, onError: fail });
  const reset = trpc.storefront.design.resetToTemplate.useMutation({ onSuccess: (r) => replaced(r.draft, "Reset to the template's design"), onError: fail });
  const discard = trpc.storefront.design.discardDraft.useMutation({ onSuccess: (r) => replaced(r.draft, "Back to your published store"), onError: fail });
  const validation = useMemo(() => (config ? storeConfigSchema.safeParse(config) : null), [config]);
  const invalid = validation && !validation.success ? validation.error.issues[0] : null;

  if (design.isLoading || !config) return <div className="grid h-screen place-items-center text-sm text-muted-foreground" role="status">Loading your store…</div>;
  if (design.error) return <div className="grid h-screen place-items-center text-sm">{design.error.message}</div>;

  const setSections = (sections: StoreSection[]) => update({ ...config, sections });
  const patchSection = (id: string, patch: Partial<StoreSection>) => setSections(config.sections.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  const theme = <K extends keyof StoreConfig["theme"]>(key: K, value: StoreConfig["theme"][K]) => update({ ...config, theme: { ...config.theme, [key]: value } });
  const contact = (key: keyof StoreConfig["contact"], value: string) => update({ ...config, contact: { ...config.contact, [key]: value } });
  const policy = (key: keyof StoreConfig["policies"], value: string) => update({ ...config, policies: { ...config.policies, [key]: value } });
  const addSection = (type: SectionType) => {
    const id = `${type}-${Date.now().toString(36)}`;
    setSections([...config.sections, newSection(type, id, DEFAULTS[type])]);
    setAdding(false);
    setOpenId(id);
  };
  const categories = shop.data?.categories.map((c) => c.name) ?? [];
  const products = shop.data?.catalog.map((p) => ({ id: p.id, name: p.name })) ?? [];
  const storeUrl = `/shop/${slug}`;

  return (
    <div className="flex h-screen flex-col bg-background">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div className="flex items-center gap-2">
          <Link href="/settings/storefront" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4" aria-hidden="true" /> Back</Link>
          <span className="text-sm font-semibold">Store builder</span>
          <span className="text-xs text-muted-foreground" role="status">{dirty ? "Unsaved changes" : design.data?.hasUnpublishedChanges ? "Draft saved, not published" : design.data?.publishedAt ? "Published" : "Not published yet"}</span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <div className="flex rounded border border-border" role="group" aria-label="Preview size">
            <button type="button" aria-pressed={device === "desktop"} aria-label="Computer" className={`p-1.5 ${device === "desktop" ? "bg-muted" : ""}`} onClick={() => setDevice("desktop")}><Monitor className="h-4 w-4" /></button>
            <button type="button" aria-pressed={device === "phone"} aria-label="Phone" className={`p-1.5 ${device === "phone" ? "bg-muted" : ""}`} onClick={() => setDevice("phone")}><Smartphone className="h-4 w-4" /></button>
          </div>
          <Button variant="ghost" size="sm" className="gap-1" onClick={() => navigate("/settings/storefront/templates")}><LayoutTemplate className="h-4 w-4" aria-hidden="true" /> Templates</Button>
          {design.data?.isVisible && <a href={storeUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 px-2 text-sm text-muted-foreground hover:text-foreground"><ExternalLink className="h-3.5 w-3.5" aria-hidden="true" /> View store</a>}
          <Button variant="outline" size="sm" disabled={!dirty || !!invalid || save.isPending} onClick={() => save.mutate({ config })}>{save.isPending ? "Saving…" : "Save draft"}</Button>
          <Button size="sm" disabled={!!invalid || publish.isPending || save.isPending} onClick={async () => { await save.mutateAsync({ config }); publish.mutate({ makeVisible: true }); }}>{publish.isPending ? "Publishing…" : "Publish"}</Button>
        </div>
      </header>
      {invalid && <p className="border-b border-border bg-destructive/10 px-3 py-1.5 text-xs text-destructive" role="alert">Fix this before saving: {invalid.path.join(" ")}: {invalid.message}</p>}
      {previewStale && <p className="border-b border-border bg-destructive/10 px-3 py-1.5 text-xs" role="alert">The preview couldn't load the latest version of your store. Your changes are safe. <button type="button" className="underline" onClick={() => window.location.reload()}>Reload this page</button>.</p>}
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <aside className="flex max-h-[50vh] w-full flex-none flex-col border-b border-border lg:max-h-none lg:w-[360px] lg:border-b-0 lg:border-r">
          <div className="flex border-b border-border text-xs font-medium" role="tablist">
            {([["sections", "Sections"], ["style", "Style"], ["layout", "Layout"], ["business", "Business"]] as [Tab, string][]).map(([k, label]) => (
              <button key={k} type="button" role="tab" aria-selected={tab === k} className={`flex-1 py-2.5 ${tab === k ? "border-b-2 border-primary text-foreground" : "text-muted-foreground"}`} onClick={() => setTab(k)}>{label}</button>
            ))}
          </div>
          <div className="flex-1 space-y-3 overflow-y-auto p-3">
            {tab === "sections" && <>
              <p className="text-xs text-muted-foreground">Drag to reorder, or use the arrows. Click a section to edit it.</p>
              <ol className="space-y-1.5">
                {config.sections.map((s, i) => (
                  <li key={s.id} className={`overflow-hidden rounded border border-border bg-card ${dragIndex === i ? "opacity-50" : ""}`} draggable onDragStart={() => setDragIndex(i)} onDragEnd={() => setDragIndex(null)} onDragOver={(e) => e.preventDefault()} onDrop={() => { if (dragIndex !== null) setSections(moveSection(config.sections, dragIndex, i)); setDragIndex(null); }}>
                    <div className="flex items-center gap-1 px-1.5 py-1.5">
                      <GripVertical className="h-4 w-4 flex-none cursor-grab text-muted-foreground" aria-hidden="true" />
                      <button type="button" aria-expanded={openId === s.id} className={`min-w-0 flex-1 truncate text-left text-sm ${s.hidden ? "text-muted-foreground line-through" : ""}`} onClick={() => setOpenId(openId === s.id ? null : s.id)}>{SECTION_LABEL[s.type]}{s.title ? <span className="text-muted-foreground"> · {s.title}</span> : null}</button>
                      <button type="button" aria-label={`Move ${SECTION_LABEL[s.type]} up`} disabled={i === 0} className="p-1 disabled:opacity-30" onClick={() => setSections(moveSection(config.sections, i, i - 1))}><ArrowUp className="h-3.5 w-3.5" /></button>
                      <button type="button" aria-label={`Move ${SECTION_LABEL[s.type]} down`} disabled={i === config.sections.length - 1} className="p-1 disabled:opacity-30" onClick={() => setSections(moveSection(config.sections, i, i + 1))}><ArrowDown className="h-3.5 w-3.5" /></button>
                      <button type="button" aria-label={s.hidden ? `Show ${SECTION_LABEL[s.type]}` : `Hide ${SECTION_LABEL[s.type]}`} className="p-1" onClick={() => patchSection(s.id, { hidden: !s.hidden })}>{s.hidden ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}</button>
                      <button type="button" aria-label={`Remove ${SECTION_LABEL[s.type]}`} className="p-1 text-muted-foreground hover:text-destructive" onClick={() => setSections(config.sections.filter((x) => x.id !== s.id))}><Trash2 className="h-3.5 w-3.5" /></button>
                    </div>
                    {openId === s.id && <SectionEditor s={s} categories={categories} products={products} onChange={(patch) => patchSection(s.id, patch)} />}
                  </li>
                ))}
              </ol>
              {config.sections.length === 0 && <p className="rounded border border-dashed border-border p-4 text-center text-sm text-muted-foreground">An empty page. Add your first section.</p>}
              {adding ? (
                <div className="grid gap-1 rounded border border-border p-1.5">
                  {(Object.keys(SECTION_LABEL) as SectionType[]).map((type) => <button key={type} type="button" className="rounded px-2 py-1.5 text-left hover:bg-muted" onClick={() => addSection(type)}><span className="block text-sm">{SECTION_LABEL[type]}</span><span className="block text-xs text-muted-foreground">{SECTION_HELP[type]}</span></button>)}
                  <Button type="button" variant="ghost" size="sm" onClick={() => setAdding(false)}>Cancel</Button>
                </div>
              ) : <Button type="button" variant="outline" className="w-full gap-1" onClick={() => setAdding(true)}><Plus className="h-4 w-4" aria-hidden="true" /> Add a section</Button>}
            </>}
            {tab === "style" && <>
              <div className="grid grid-cols-2 gap-2">
                {COLOUR_FIELDS.map(([key, label]) => (
                  <label key={key} className="flex items-center gap-2 text-xs"><input type="color" className="h-7 w-9 flex-none cursor-pointer rounded border border-input bg-transparent" value={config.theme[key] as string} onChange={(e) => theme(key, e.target.value as never)} aria-label={label} /><span>{label}</span></label>
                ))}
              </div>
              <Choice label="Heading font" value={config.theme.headingFont} options={STORE_FONTS} onChange={(v) => theme("headingFont", v as StoreConfig["theme"]["headingFont"])} />
              <Choice label="Body font" value={config.theme.bodyFont} options={STORE_FONTS} onChange={(v) => theme("bodyFont", v as StoreConfig["theme"]["bodyFont"])} />
              <div className="grid grid-cols-2 gap-2">
                <Choice label="Heading letters" value={config.theme.headingCase} options={["none", "upper"]} names={{ none: "As typed", upper: "CAPITALS" }} onChange={(v) => theme("headingCase", v as "none")} />
                <Choice label="Heading weight" value={String(config.theme.headingWeight)} options={["300", "400", "500", "600", "700", "800"]} names={{}} onChange={(v) => theme("headingWeight", Number(v))} />
              </div>
              <Field label={`Corners: ${config.theme.radius}px`}><input type="range" min={0} max={40} className="w-full" value={config.theme.radius} onChange={(e) => theme("radius", Number(e.target.value))} /></Field>
              <Field label={`Space between sections: ${config.theme.spacing}px`}><input type="range" min={0} max={160} step={4} className="w-full" value={config.theme.spacing} onChange={(e) => theme("spacing", Number(e.target.value))} /></Field>
              <Field label={`Page width: ${config.theme.width}px`}><input type="range" min={960} max={1800} step={20} className="w-full" value={config.theme.width} onChange={(e) => theme("width", Number(e.target.value))} /></Field>
              <Choice label="Product photo shape" value={config.theme.imageRatio} options={["1/1", "4/5", "3/4", "16/10", "free"]} names={{ "1/1": "Square", "4/5": "Portrait", "3/4": "Tall portrait", "16/10": "Landscape", free: "As uploaded" }} onChange={(v) => theme("imageRatio", v as "1/1")} />
            </>}
            {tab === "layout" && <>
              <ImageField label="Logo" value={config.logoUrl} onChange={(logoUrl) => update({ ...config, logoUrl })} />
              <Field label="Store name" hint={`Leave empty to use ${design.data?.businessName ?? "your business name"}.`}><input className={inputClass} value={config.storeName} onChange={(e) => update({ ...config, storeName: e.target.value })} /></Field>
              <Choice label="Header" value={config.header.variant} options={HEADER_VARIANTS} onChange={(variant) => update({ ...config, header: { ...config.header, variant: variant as StoreConfig["header"]["variant"] } })} />
              <Field label="Announcement bar"><input className={inputClass} value={config.header.announcement} onChange={(e) => update({ ...config, header: { ...config.header, announcement: e.target.value } })} /></Field>
              <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={config.header.showCategories} onChange={(e) => update({ ...config, header: { ...config.header, showCategories: e.target.checked } })} /> Add my categories to the menu</label>
              <LinkList title="Menu links" links={config.header.links} onChange={(links) => update({ ...config, header: { ...config.header, links } })} />
              <Choice label="Product cards" value={config.product.card} options={CARD_VARIANTS} onChange={(card) => update({ ...config, product: { ...config.product, card: card as StoreConfig["product"]["card"] } })} />
              <div className="grid grid-cols-2 gap-2">
                <Field label="Products per row"><input type="number" min={1} max={6} className={inputClass} value={config.product.listColumns} onChange={(e) => update({ ...config, product: { ...config.product, listColumns: clamp(e.target.value, 1, 6) } })} /></Field>
                <Choice label="Filters" value={config.product.filters} options={["bar", "sidebar"]} names={{ bar: "Above products", sidebar: "Side panel" }} onChange={(filters) => update({ ...config, product: { ...config.product, filters: filters as "bar" } })} />
              </div>
              <Choice label="Footer" value={config.footer.variant} options={FOOTER_VARIANTS} onChange={(variant) => update({ ...config, footer: { ...config.footer, variant: variant as StoreConfig["footer"]["variant"] } })} />
              <Field label="About line in footer"><textarea rows={2} className={inputClass} value={config.footer.about} onChange={(e) => update({ ...config, footer: { ...config.footer, about: e.target.value } })} /></Field>
              <Field label="Legal line" hint="Replaces the copyright line."><input className={inputClass} value={config.footer.legal} onChange={(e) => update({ ...config, footer: { ...config.footer, legal: e.target.value } })} /></Field>
            </>}
            {tab === "business" && <>
              <Field label="WhatsApp number" hint={design.data?.defaultWhatsapp.number
                ? design.data.defaultWhatsapp.shared
                  ? `Leave empty to use the shared OAK number, ${design.data.defaultWhatsapp.number}. Customers who tap it go straight to your shop.`
                  : `Leave empty to use your connected number, ${design.data.defaultWhatsapp.number}.`
                : "Digits with the country code, e.g. 2348012345678."}><input className={inputClass} inputMode="numeric" value={config.contact.whatsapp} onChange={(e) => contact("whatsapp", e.target.value.replace(/\D/g, ""))} /></Field>
              <Field label="Phone"><input className={inputClass} value={config.contact.phone} onChange={(e) => contact("phone", e.target.value)} /></Field>
              <Field label="Email"><input type="email" className={inputClass} value={config.contact.email} onChange={(e) => contact("email", e.target.value)} /></Field>
              <Field label="Address"><input className={inputClass} value={config.contact.address} onChange={(e) => contact("address", e.target.value)} /></Field>
              <Field label="Opening hours"><input className={inputClass} value={config.contact.hours} onChange={(e) => contact("hours", e.target.value)} /></Field>
              {(["instagram", "facebook", "tiktok", "x"] as const).map((k) => <Field key={k} label={k === "x" ? "X" : k[0].toUpperCase() + k.slice(1)}><input className={inputClass} placeholder="https://" value={config.contact[k]} onChange={(e) => contact(k, e.target.value)} /></Field>)}
              {(["delivery", "returns", "privacy", "terms"] as const).map((k) => <Field key={k} label={`${k[0].toUpperCase()}${k.slice(1)} policy`}><textarea rows={3} className={inputClass} value={config.policies[k]} onChange={(e) => policy(k, e.target.value)} /></Field>)}
            </>}
            <div className="space-y-1.5 border-t border-border pt-3">
              {config.templateId !== "blank" && <Button type="button" variant="ghost" size="sm" className="w-full justify-start gap-1.5" disabled={reset.isPending} onClick={() => { if (window.confirm("Reset the design to the template's defaults? Your logo, contact details and policies stay.")) reset.mutate(); }}><RotateCcw className="h-3.5 w-3.5" aria-hidden="true" /> Reset to the template's design</Button>}
              {design.data?.publishedAt && <Button type="button" variant="ghost" size="sm" className="w-full justify-start gap-1.5" disabled={discard.isPending} onClick={() => { if (window.confirm("Throw away your unpublished changes?")) discard.mutate(); }}><Undo2 className="h-3.5 w-3.5" aria-hidden="true" /> Go back to what's published</Button>}
            </div>
          </div>
        </aside>
        <div className="flex min-h-0 flex-1 justify-center overflow-hidden bg-muted p-2">
          {slug && <iframe key={frameNonce} ref={frameRef} title="Live preview of your store" src={`${storeUrl}?preview=1`} className={`h-full border border-border bg-white ${device === "phone" ? "w-[390px]" : "w-full"}`} />}
        </div>
      </div>
    </div>
  );
}

function LinkList({ title, links, onChange }: { title: string; links: { label: string; href: string }[]; onChange: (links: { label: string; href: string }[]) => void }) {
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium">{title}</p>
      {links.map((link, i) => (
        <div key={i} className="flex gap-1">
          <input className={inputClass} placeholder="Label" aria-label="Link label" value={link.label} onChange={(e) => onChange(links.map((l, n) => (n === i ? { ...l, label: e.target.value } : l)))} />
          <input className={inputClass} placeholder="products" aria-label="Link address" value={link.href} onChange={(e) => onChange(links.map((l, n) => (n === i ? { ...l, href: e.target.value } : l)))} />
          <button type="button" aria-label={`Remove ${link.label || "link"}`} className="p-1 text-muted-foreground" onClick={() => onChange(links.filter((_, n) => n !== i))}><Trash2 className="h-3.5 w-3.5" /></button>
        </div>
      ))}
      {links.length < 10 && <Button type="button" variant="outline" size="sm" onClick={() => onChange([...links, { label: "", href: "products" }])}>Add a link</Button>}
    </div>
  );
}
