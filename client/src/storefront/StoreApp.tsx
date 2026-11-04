import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import type { StoreConfig } from "@shared/storefront/config";
import { DEMO_REVIEWS, demoProducts } from "@shared/storefront/demoCatalog";
import { findTemplate } from "@shared/storefront/templates";
import { trpc } from "@/lib/trpc";
import { Account, ResetPassword } from "./account";
import { useCart } from "./cart";
import { StoreProvider, type StoreData } from "./context";
import { CartPage, Checkout, Contact, Home, Listing, NotFound, OrderPage, Policy, ProductPage, Track } from "./pages";
import { CartDrawer, Footer, Header, WhatsAppButton } from "./parts";
import { themeStyle } from "./theme";
import "./store-fonts.css";
import "./store.css";

/** Removes the OAK platform frame: a shop's store carries the shop's brand, not ours. */
function useStoreChrome(name: string | undefined, background: string | undefined) {
  useEffect(() => {
    document.documentElement.classList.add("sf-active");
    return () => document.documentElement.classList.remove("sf-active");
  }, []);
  useEffect(() => { if (name) document.title = name; }, [name]);
  useEffect(() => {
    const meta = document.querySelector('meta[name="theme-color"]');
    const previous = meta?.getAttribute("content");
    if (meta && background) meta.setAttribute("content", background);
    return () => { if (meta && previous) meta.setAttribute("content", previous); };
  }, [background]);
}

function Shell({ data, base, demo, path }: { data: StoreData; base: string; demo: boolean; path: string }) {
  const [, navigate] = useLocation();
  const cart = useCart(data.slug, !demo);
  const [drawerOpen, setDrawerOpen] = useState(false);
  useStoreChrome(data.name, data.config.theme.background);
  const preserved = typeof window === "undefined" ? "" : new URLSearchParams(window.location.search).get("preview") ? "preview=1" : "";
  const href = useCallback((to: string) => {
    if (/^(https:|mailto:|tel:|\/|#)/i.test(to)) return to;
    const url = to ? `${base}/${to}` : base;
    if (!preserved) return url;
    return `${url}${url.includes("?") ? "&" : "?"}${preserved}`;
  }, [base, preserved]);
  const go = useCallback((to: string) => { navigate(href(to)); }, [href, navigate]);
  useEffect(() => { window.scrollTo(0, 0); setDrawerOpen(false); }, [path]);
  const search = new URLSearchParams(typeof window === "undefined" ? "" : window.location.search);
  const [head = "", second = "", third = ""] = path.split("/").filter(Boolean);

  let page: React.ReactNode;
  if (!head) page = <Home />;
  else if (head === "products" && second) page = <ProductPage id={decodeURIComponent(second)} />;
  else if (head === "products") page = <Listing search={search} />;
  else if (head === "cart") page = <CartPage />;
  else if (head === "checkout") page = <Checkout />;
  else if (head === "orders" && second) page = <OrderPage token={decodeURIComponent(second)} />;
  else if (head === "track") page = <Track />;
  else if (head === "contact") page = <Contact />;
  else if (head === "policy") page = <Policy kind={second} />;
  else if (head === "account" && second === "reset") page = <ResetPassword token={search.get("token") ?? ""} />;
  else if (head === "account") page = <Account tab={second} next={search.get("next")} />;
  else page = <NotFound what="That page doesn't exist." />;
  void third;

  return (
    <StoreProvider value={{ store: data, demo, base, href, go, cart, drawerOpen, setDrawerOpen }}>
      <div className="sf-root" style={themeStyle(data.config)} data-case={data.config.theme.headingCase} data-card={data.config.product.card}>
        {demo && <div className="sf-preview-note">Template preview with sample products. Your own products appear on your store.</div>}
        {data.isDraft && <div className="sf-preview-note">Preview of your unpublished changes. Shoppers can't see this.</div>}
        <Header />
        <main className="sf-main">{page}</main>
        <Footer />
        <CartDrawer />
        <WhatsAppButton />
      </div>
    </StoreProvider>
  );
}

const StateMessage = ({ title, children }: { title: string; children?: React.ReactNode }) => (
  <div className="sf-state"><h1>{title}</h1>{children}</div>
);

/** A real store at /shop/:slug. ?preview=1 shows staff their draft, and takes live edits from the builder. */
export function LiveStore({ slug, path }: { slug: string; path: string }) {
  const preview = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("preview") === "1";
  const query = trpc.storefront.shop.store.useQuery({ slug, preview: preview || undefined }, { retry: false, staleTime: 30_000 });
  const [override, setOverride] = useState<StoreConfig | null>(null);
  useEffect(() => {
    if (!preview) return;
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin || e.data?.type !== "store-config") return;
      setOverride(e.data.config as StoreConfig);
    };
    window.addEventListener("message", onMessage);
    window.parent?.postMessage({ type: "store-ready" }, window.location.origin);
    return () => window.removeEventListener("message", onMessage);
  }, [preview]);
  useStoreLoading();
  const data = useMemo(() => (query.data ? ({ ...query.data, config: override ?? query.data.config, name: override?.storeName || query.data.name } as unknown as StoreData) : null), [query.data, override]);
  if (query.isLoading) return <div className="sf-state" role="status">Loading store…</div>;
  if (query.error?.data?.code === "NOT_FOUND" || (!query.isLoading && !data && !query.error)) {
    return <StateMessage title="This store isn't available"><p>The link may be wrong, or the shop isn't open yet.</p></StateMessage>;
  }
  if (!data) return <StateMessage title="We couldn't load this store"><button type="button" onClick={() => query.refetch()}>Try again</button></StateMessage>;
  return <Shell data={data} base={`/shop/${slug}`} demo={false} path={path} />;
}

const useStoreLoading = () => useEffect(() => { document.documentElement.classList.add("sf-active"); return () => document.documentElement.classList.remove("sf-active"); }, []);

/** A template with sample products at /store-preview/:id. Nothing here reads or writes any shop's data. */
export function TemplatePreview({ templateId, path }: { templateId: string; path: string }) {
  useStoreLoading();
  const template = findTemplate(templateId);
  const data = useMemo<StoreData | null>(() => {
    if (!template) return null;
    const catalog = demoProducts(template.demo);
    const categories = new Map<string, { name: string; imageUrl: string | null; count: number }>();
    for (const p of catalog) {
      const c = categories.get(p.category) ?? { name: p.category, imageUrl: p.imageUrl, count: 0 };
      c.count += 1;
      categories.set(p.category, c);
    }
    return {
      slug: `preview-${template.id}`, name: template.name, currency: "NGN", config: template.config, whatsapp: "2340000000000",
      categories: Array.from(categories.values()), catalog, promos: [], reviews: DEMO_REVIEWS,
      checkout: { pickup: true, cod: true, online: true },
    };
  }, [template]);
  if (!data) return <StateMessage title="That template doesn't exist" />;
  return <Shell data={data} base={`/store-preview/${templateId}`} demo path={path} />;
}
