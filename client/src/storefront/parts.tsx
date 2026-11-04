import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Menu, MessageCircle, Minus, Plus, Search, ShoppingBag, User, X } from "lucide-react";
import { useStore, type StoreProduct } from "./context";
import { formatMoney, salePercent, waLink } from "./format";
import type { StoreConfig } from "@shared/storefront/config";

export function Link({ to, className, children, onClick, ariaLabel }: { to: string; className?: string; children: React.ReactNode; onClick?: () => void; ariaLabel?: string }) {
  const { href, go, store } = useStore();
  if (to === "whatsapp") {
    const url = waLink(store, `Hello ${store.name}! I have a question.`);
    if (!url) return <Link to="contact" className={className}>{children}</Link>;
    return <a href={url} target="_blank" rel="noreferrer" className={className} aria-label={ariaLabel}>{children}</a>;
  }
  const url = href(to);
  const external = /^(https:|mailto:|tel:)/i.test(url);
  if (external) return <a href={url} target={url.startsWith("https") ? "_blank" : undefined} rel="noreferrer" className={className} aria-label={ariaLabel}>{children}</a>;
  return <a href={url} className={className} aria-label={ariaLabel} onClick={(e) => { if (e.metaKey || e.ctrlKey) return; e.preventDefault(); onClick?.(); go(to); }}>{children}</a>;
}

export function Logo() {
  const { store } = useStore();
  return <Link to="" className="sf-logo" ariaLabel={`${store.name} home`}>{store.config.logoUrl ? <img src={store.config.logoUrl} alt={store.name} /> : <span>{store.name}</span>}</Link>;
}

function SearchBox({ big }: { big?: boolean }) {
  const { go } = useStore();
  const [q, setQ] = useState("");
  const submit = (e: FormEvent) => { e.preventDefault(); go(`products?q=${encodeURIComponent(q)}`); };
  return (
    <form className={`sf-search ${big ? "is-big" : ""}`} role="search" onSubmit={submit}>
      <Search size={18} aria-hidden="true" />
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search products" aria-label="Search products" />
      {big && <button type="submit" className="sf-btn sf-btn-accent">Search</button>}
    </form>
  );
}

function Icons({ search = true }: { search?: boolean }) {
  const { cart, setDrawerOpen, go } = useStore();
  return (
    <div className="sf-icons">
      {search && <button type="button" aria-label="Search" onClick={() => go("products?focus=1")}><Search size={20} /></button>}
      <Link to="account" ariaLabel="Your account"><User size={20} /></Link>
      <button type="button" aria-label={`Cart, ${cart.count} items`} className="sf-cart-btn" onClick={() => setDrawerOpen(true)}>
        <ShoppingBag size={20} />{cart.count > 0 && <span className="sf-cart-count">{cart.count}</span>}
      </button>
    </div>
  );
}

function useNav() {
  const { store } = useStore();
  const { links, showCategories } = store.config.header;
  return useMemo(() => {
    const items = [...links];
    if (showCategories) for (const c of store.categories.slice(0, 5)) items.push({ label: c.name, href: `products?category=${encodeURIComponent(c.name)}` });
    return items.length ? items : [{ label: "Shop", href: "products" }];
  }, [links, showCategories, store.categories]);
}

const NavLinks = ({ onClick }: { onClick?: () => void }) => {
  const nav = useNav();
  return <>{nav.map((l) => <Link key={`${l.label}${l.href}`} to={l.href} onClick={onClick}>{l.label}</Link>)}</>;
};

export function Header() {
  const { store } = useStore();
  const { variant, announcement } = store.config.header;
  const [open, setOpen] = useState(false);
  const nav = useNav();
  const half = Math.ceil(nav.length / 2);
  const burger = <button type="button" className="sf-burger" aria-label="Menu" onClick={() => setOpen(true)}><Menu size={22} /></button>;
  return (
    <>
      {announcement && variant !== "ticker" && <div className="sf-announce">{announcement}</div>}
      {announcement && variant === "ticker" && <div className="sf-ticker" aria-label={announcement}><div aria-hidden="true">{Array.from({ length: 6 }, (_, i) => <span key={i}>{announcement}</span>)}</div></div>}
      <header className={`sf-header sf-header-${variant}`}>
        {variant === "classic" && <div className="sf-wrap sf-header-row">{burger}<Logo /><nav className="sf-nav" aria-label="Main"><NavLinks /></nav><Icons /></div>}
        {variant === "ticker" && <div className="sf-wrap sf-header-row">{burger}<Logo /><nav className="sf-nav" aria-label="Main"><NavLinks /></nav><Icons /></div>}
        {variant === "centered" && <>
          <div className="sf-wrap sf-header-row sf-three">{burger}<div className="sf-header-side"><SearchBox /></div><Logo /><Icons search={false} /></div>
          <nav className="sf-nav sf-nav-below" aria-label="Main"><NavLinks /></nav>
        </>}
        {variant === "searchFirst" && <>
          <div className="sf-wrap sf-header-row">{burger}<Logo /><SearchBox big /><Icons search={false} /></div>
          <nav className="sf-nav sf-nav-bar" aria-label="Main"><div className="sf-wrap"><Link to="products">All</Link><NavLinks /></div></nav>
        </>}
        {variant === "minimal" && <div className="sf-wrap sf-header-row sf-three"><button type="button" className="sf-menu-word" onClick={() => setOpen(true)}><Menu size={18} aria-hidden="true" /> <span>Menu</span></button><Logo /><Icons search={false} /></div>}
        {variant === "split" && <div className="sf-wrap sf-header-row sf-three">{burger}<nav className="sf-nav" aria-label="Main">{nav.slice(0, half).map((l) => <Link key={l.label} to={l.href}>{l.label}</Link>)}</nav><Logo /><div className="sf-split-right"><nav className="sf-nav" aria-label="More">{nav.slice(half).map((l) => <Link key={l.label} to={l.href}>{l.label}</Link>)}</nav><Icons search={false} /></div></div>}
      </header>
      {open && (
        <div className="sf-overlay-menu" role="dialog" aria-modal="true" aria-label="Menu">
          <div className="sf-overlay-top"><Logo /><button type="button" aria-label="Close menu" onClick={() => setOpen(false)}><X size={26} /></button></div>
          <div className="sf-overlay-search" ><SearchBox /></div>
          <nav><Link to="products" onClick={() => setOpen(false)}>All products</Link><NavLinks onClick={() => setOpen(false)} /><Link to="account" onClick={() => setOpen(false)}>Account</Link><Link to="track" onClick={() => setOpen(false)}>Track an order</Link></nav>
        </div>
      )}
    </>
  );
}

const SOCIALS: [keyof StoreConfig["contact"], string][] = [["instagram", "Instagram"], ["facebook", "Facebook"], ["tiktok", "TikTok"], ["x", "X"]];

function FooterContact() {
  const { store } = useStore();
  const c = store.config.contact;
  return (
    <>
      {store.whatsapp && <Link to="whatsapp">WhatsApp us</Link>}
      {c.phone && <a href={`tel:${c.phone.replace(/\s/g, "")}`}>{c.phone}</a>}
      {c.email && <a href={`mailto:${c.email}`}>{c.email}</a>}
      {c.address && <span>{c.address}</span>}
      {c.hours && <span>{c.hours}</span>}
    </>
  );
}

const Socials = () => {
  const { store } = useStore();
  const items = SOCIALS.filter(([k]) => store.config.contact[k]);
  return items.length ? <div className="sf-socials">{items.map(([k, label]) => <a key={k} href={store.config.contact[k]} target="_blank" rel="noreferrer">{label}</a>)}</div> : null;
};

const PolicyLinks = () => {
  const { store } = useStore();
  const p = store.config.policies;
  const all: [string, string][] = [["delivery", "Delivery"], ["returns", "Returns"], ["privacy", "Privacy"], ["terms", "Terms"]];
  return <>{all.filter(([k]) => p[k as keyof typeof p]).map(([k, label]) => <Link key={k} to={`policy/${k}`}>{label}</Link>)}</>;
};

export function Footer() {
  const { store } = useStore();
  const { variant, about, columns, legal } = store.config.footer;
  const copyright = legal || `© ${new Date().getFullYear()} ${store.name}`;
  if (variant === "bar") return <footer className="sf-footer sf-footer-bar"><div className="sf-wrap"><Logo /><div className="sf-footer-inline"><Link to="products">Shop</Link><Link to="track">Track an order</Link><Link to="account">Account</Link><PolicyLinks /><FooterContact /></div><Socials /><small>{copyright}</small></div></footer>;
  if (variant === "centered") return <footer className="sf-footer sf-footer-centered"><div className="sf-wrap"><Logo />{about && <p>{about}</p>}<div className="sf-footer-inline"><Link to="products">Shop</Link><Link to="track">Track an order</Link><Link to="account">Account</Link><PolicyLinks /></div><div className="sf-footer-inline"><FooterContact /></div><Socials /><small>{copyright}</small></div></footer>;
  const cols = (
    <div className="sf-footer-cols">
      {columns.map((col) => <div key={col.title}><h4>{col.title}</h4>{col.links.map((l) => <Link key={l.label} to={l.href}>{l.label}</Link>)}</div>)}
      <div><h4>Contact</h4><FooterContact /><Socials /></div>
      {store.config.policies && <div className="sf-footer-policies"><PolicyLinks /></div>}
    </div>
  );
  if (variant === "wordmark") return <footer className="sf-footer sf-footer-wordmark"><div className="sf-wrap">{cols}<small>{copyright}</small></div><p className="sf-wordmark" aria-hidden="true">{store.name}</p></footer>;
  return <footer className="sf-footer sf-footer-columns"><div className="sf-wrap"><div className="sf-footer-about"><Logo />{about && <p>{about}</p>}</div>{cols}<small>{copyright}</small></div></footer>;
}

export function Price({ product }: { product: Pick<StoreProduct, "price" | "compareAtPrice"> }) {
  const { store } = useStore();
  return (
    <span className="sf-price">
      <span className={product.compareAtPrice ? "is-sale" : ""}>{formatMoney(product.price, store.currency)}</span>
      {product.compareAtPrice && <s>{formatMoney(product.compareAtPrice, store.currency)}</s>}
    </span>
  );
}

function Badge({ product }: { product: StoreProduct }) {
  if (!product.inStock) return <span className="sf-badge is-out">Sold out</span>;
  const off = salePercent(product.price, product.compareAtPrice);
  if (off > 0) return <span className="sf-badge is-sale">-{off}%</span>;
  if (product.isNew) return <span className="sf-badge">New</span>;
  return null;
}

export const Img = ({ src, alt, ratio, priority }: { src: string | null; alt: string; ratio?: string; priority?: boolean }) => (
  <div className="sf-img" style={ratio && ratio !== "free" ? { aspectRatio: ratio } : undefined}>
    {src ? <img src={src} alt={alt} loading={priority ? "eager" : "lazy"} decoding="async" /> : <div className="sf-img-empty" aria-label={alt}><ShoppingBag size={28} aria-hidden="true" /></div>}
  </div>
);

function QuickAdd({ product, label = "Add to cart", icon }: { product: StoreProduct; label?: string; icon?: boolean }) {
  const { cart, setDrawerOpen, go } = useStore();
  const hasOptions = (product.variants?.length ?? 0) > 0 || product.options.length > 0;
  if (!product.inStock) return <span className="sf-soldout-note">Sold out</span>;
  const action = () => {
    if (hasOptions) { go(`products/${product.id}`); return; }
    cart.add(product.id, null, 1);
    setDrawerOpen(true);
  };
  if (icon) return <button type="button" className="sf-add-icon" aria-label={`${hasOptions ? "Choose options for" : "Add to cart:"} ${product.name}`} onClick={action}><Plus size={18} /></button>;
  return <button type="button" className="sf-btn sf-btn-outline sf-add" onClick={action}>{hasOptions ? "Choose options" : label}</button>;
}

function RowQty({ product }: { product: StoreProduct }) {
  const { cart, setDrawerOpen, go } = useStore();
  const [qty, setQty] = useState(1);
  if (!product.inStock) return <span className="sf-soldout-note">Sold out</span>;
  if ((product.variants?.length ?? 0) > 0 || product.options.length > 0) return <button type="button" className="sf-btn sf-btn-outline" onClick={() => go(`products/${product.id}`)}>Options</button>;
  return (
    <div className="sf-row-buy">
      <Qty value={qty} onChange={setQty} label={product.name} />
      <button type="button" className="sf-btn sf-btn-accent" onClick={() => { cart.add(product.id, null, qty); setDrawerOpen(true); }}>Add</button>
    </div>
  );
}

export const Qty = ({ value, onChange, label }: { value: number; onChange: (n: number) => void; label: string }) => (
  <div className="sf-qty">
    <button type="button" aria-label={`Fewer ${label}`} onClick={() => onChange(Math.max(1, value - 1))}><Minus size={14} /></button>
    <span aria-live="polite">{value}</span>
    <button type="button" aria-label={`More ${label}`} onClick={() => onChange(value + 1)}><Plus size={14} /></button>
  </div>
);

/** The eight product card designs. Each lays the same information out differently. */
export function ProductCard({ product, variant }: { product: StoreProduct; variant?: string }) {
  const { store } = useStore();
  const card = variant || store.config.product.card;
  const ratio = store.config.theme.imageRatio;
  const to = `products/${product.id}`;
  const img = <Img src={product.imageUrl} alt={product.name} ratio={ratio} />;
  const stockNote = product.inStock && product.lowStock ? <span className="sf-low">Only a few left</span> : null;
  switch (card) {
    case "overlay":
      return <article className="sf-card sf-card-overlay"><Link to={to} ariaLabel={product.name}>{img}<div className="sf-card-veil"><h3>{product.name}</h3><Price product={product} /></div><Badge product={product} /></Link></article>;
    case "boxed":
      return <article className="sf-card sf-card-boxed"><Link to={to} ariaLabel={product.name}>{img}<Badge product={product} /></Link><div className="sf-card-body">{product.category && <small>{product.category}</small>}<h3><Link to={to}>{product.name}</Link></h3><Price product={product} />{stockNote}<QuickAdd product={product} /></div></article>;
    case "compact":
      return <article className="sf-card sf-card-compact"><Link to={to} ariaLabel={product.name}>{img}<Badge product={product} /></Link><QuickAdd product={product} icon /><Price product={product} /><h3><Link to={to}>{product.name}</Link></h3>{stockNote}</article>;
    case "tile":
      return <article className="sf-card sf-card-tile"><Link to={to} ariaLabel={product.name}>{img}<Badge product={product} /></Link><div className="sf-card-foot"><div><h3><Link to={to}>{product.name}</Link></h3><Price product={product} /></div><QuickAdd product={product} icon /></div></article>;
    case "row":
      return <article className="sf-card sf-card-row"><Link to={to} ariaLabel={product.name} className="sf-row-img">{img}</Link><div className="sf-row-main"><h3><Link to={to}>{product.name}</Link></h3>{product.category && <small>{product.category}</small>}{stockNote}</div><Price product={product} /><RowQty product={product} /></article>;
    case "menu":
      return <article className="sf-card sf-card-menu"><div className="sf-menu-text"><h3><Link to={to}>{product.name}</Link></h3>{product.description && <p>{product.description}</p>}<div className="sf-menu-foot"><Price product={product} /><QuickAdd product={product} icon /></div></div><Link to={to} ariaLabel={product.name} className="sf-menu-img"><Img src={product.imageUrl} alt={product.name} ratio="1/1" /></Link></article>;
    case "plain":
      return <article className="sf-card sf-card-plain"><Link to={to} ariaLabel={product.name}>{img}<Badge product={product} /><h3>{product.name}</h3><Price product={product} /></Link></article>;
    default:
      return <article className="sf-card sf-card-editorial"><Link to={to} ariaLabel={product.name}>{img}<Badge product={product} /><div className="sf-card-line"><h3>{product.name}</h3><Price product={product} /></div>{stockNote}</Link></article>;
  }
}

export function ProductGrid({ products, grid = "grid", columns, card }: { products: StoreProduct[]; grid?: string; columns?: number; card?: string }) {
  const { store } = useStore();
  const col = columns ?? store.config.product.listColumns;
  return (
    <div className={`sf-grid sf-grid-${grid}`} style={{ "--cols": col } as React.CSSProperties}>
      {products.map((p) => <ProductCard key={p.id} product={p} variant={card} />)}
    </div>
  );
}

/** Slides in from the side on any page, so adding to cart never loses your place. */
export function CartDrawer() {
  const { cart, drawerOpen, setDrawerOpen, store, go } = useStore();
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setDrawerOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawerOpen, setDrawerOpen]);
  if (!drawerOpen) return null;
  const rows = cartRows(store.catalog, cart.lines);
  const subtotal = rows.reduce((n, r) => n + Number(r.product.price) * r.line.quantity, 0);
  return (
    <div className="sf-drawer-wrap" role="dialog" aria-modal="true" aria-label="Your cart">
      <button type="button" className="sf-drawer-scrim" aria-label="Close cart" onClick={() => setDrawerOpen(false)} />
      <aside className="sf-drawer">
        <div className="sf-drawer-head"><h2>Your cart ({cart.count})</h2><button type="button" aria-label="Close cart" onClick={() => setDrawerOpen(false)}><X size={22} /></button></div>
        {rows.length === 0 ? (
          <div className="sf-empty"><p>Your cart is empty.</p><button type="button" className="sf-btn sf-btn-accent" onClick={() => { setDrawerOpen(false); go("products"); }}>Start shopping</button></div>
        ) : (
          <>
            <div className="sf-drawer-lines"><CartLines rows={rows} /></div>
            <div className="sf-drawer-foot">
              <div className="sf-sum-row"><span>Subtotal</span><strong>{formatMoney(subtotal, store.currency)}</strong></div>
              <small>Delivery and discounts are worked out at checkout.</small>
              <button type="button" className="sf-btn sf-btn-accent sf-btn-full" onClick={() => { setDrawerOpen(false); go("checkout"); }}>Checkout</button>
              <button type="button" className="sf-btn sf-btn-outline sf-btn-full" onClick={() => { setDrawerOpen(false); go("cart"); }}>View cart</button>
              <CartWhatsApp rows={rows} subtotal={subtotal} />
            </div>
          </>
        )}
      </aside>
    </div>
  );
}

export type CartRow = { line: { productId: string; variantId: string | null; quantity: number }; product: StoreProduct; label: string | null };

export function cartRows(catalog: StoreProduct[], lines: CartRow["line"][]): CartRow[] {
  return lines.flatMap((line) => {
    const product = catalog.find((p) => p.id === line.productId);
    if (!product) return [];
    return [{ line, product, label: product.variants?.find((v) => v.id === line.variantId)?.label ?? (line.variantId?.startsWith("demo:") ? line.variantId.slice(5) : null) }];
  });
}

export function CartLines({ rows }: { rows: CartRow[] }) {
  const { cart, store } = useStore();
  return <>{rows.map(({ line, product, label }) => (
    <div className="sf-line" key={`${line.productId}:${line.variantId ?? ""}`}>
      <Link to={`products/${product.id}`} className="sf-line-img"><Img src={product.imageUrl} alt={product.name} ratio="1/1" /></Link>
      <div className="sf-line-main">
        <Link to={`products/${product.id}`}>{product.name}</Link>
        {label && <small>{label}</small>}
        <div className="sf-line-controls">
          <Qty value={line.quantity} label={product.name} onChange={(n) => cart.setQuantity(line.productId, line.variantId, n)} />
          <button type="button" className="sf-text-btn" onClick={() => cart.setQuantity(line.productId, line.variantId, 0)}>Remove</button>
        </div>
      </div>
      <strong>{formatMoney(Number(product.price) * line.quantity, store.currency)}</strong>
    </div>
  ))}</>;
}

export function CartWhatsApp({ rows, subtotal }: { rows: CartRow[]; subtotal: number }) {
  const { store } = useStore();
  const text = `Hello ${store.name}! I'd like to order:\n${rows.map((r) => `• ${r.line.quantity} x ${r.product.name}${r.label ? ` (${r.label})` : ""}`).join("\n")}\nSubtotal: ${formatMoney(subtotal, store.currency)}`;
  const url = waLink(store, text);
  return url ? <a className="sf-wa-inline" href={url} target="_blank" rel="noreferrer"><MessageCircle size={16} aria-hidden="true" /> Send this cart on WhatsApp</a> : null;
}

/** On every page. A shop with no number set shows nothing rather than a dead link. */
export function WhatsAppButton({ message }: { message?: string }) {
  const { store } = useStore();
  const url = waLink(store, message ?? `Hello ${store.name}! I have a question.`);
  if (!url) return null;
  return <a className="sf-wa-float" href={url} target="_blank" rel="noreferrer" aria-label="Chat with us on WhatsApp"><MessageCircle size={22} aria-hidden="true" /><span>Chat with us</span></a>;
}
