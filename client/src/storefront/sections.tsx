import { useMemo, useState, type FormEvent } from "react";
import { MessageCircle, Search, ShieldCheck, Star } from "lucide-react";
import type { StoreSection } from "@shared/storefront/config";
import { trpc } from "@/lib/trpc";
import { useStore, type StoreProduct } from "./context";
import { Img, Link, Price, ProductGrid } from "./parts";
import { waLink } from "./format";

const toneClass = (s: StoreSection) => (s.tone ? `sf-tone-${s.tone}` : "");

const Cta = ({ s, kind = "accent" }: { s: StoreSection; kind?: string }) =>
  s.ctaLabel ? <Link to={s.ctaHref || "products"} className={`sf-btn sf-btn-${kind}`}>{s.ctaLabel}</Link> : null;

const Heading = ({ s }: { s: StoreSection }) =>
  s.title || s.eyebrow ? (
    <div className={`sf-sec-head sf-align-${s.align}`}>
      {s.eyebrow && <p className="sf-eyebrow">{s.eyebrow}</p>}
      {s.title && <h2>{s.title}</h2>}
    </div>
  ) : null;

/** Picks the products a section asks for, from real sales and dates, so "best sellers" means best sellers. */
export function productsForSection(all: StoreProduct[], s: StoreSection): StoreProduct[] {
  let list = all;
  switch (s.source) {
    case "featured": { const f = all.filter((p) => p.featured); list = f.length ? f : all; break; }
    case "bestSellers": { const sold = [...all].filter((p) => p.sold > 0).sort((a, b) => b.sold - a.sold); list = sold.length ? sold : all; break; }
    case "newArrivals": list = all; break; // loaded newest first
    case "onSale": list = all.filter((p) => p.compareAtPrice); break;
    case "category": list = all.filter((p) => p.category === s.category); break;
    case "manual": list = s.productIds.flatMap((id) => all.filter((p) => p.id === id)); break;
    default: break;
  }
  return list.slice(0, s.limit);
}

function Hero({ s }: { s: StoreSection }) {
  const { store, go } = useStore();
  const copy = (
    <div className={`sf-hero-copy sf-align-${s.align}`}>
      {s.eyebrow && <p className="sf-eyebrow">{s.eyebrow}</p>}
      <h1>{s.title || store.name}</h1>
      {s.body && <p className="sf-hero-body">{s.body}</p>}
      <Cta s={s} />
    </div>
  );
  const img = <img src={s.imageUrl} alt="" fetchPriority="high" />;
  switch (s.variant) {
    case "split":
      return <section className={`sf-hero sf-hero-split ${toneClass(s)}`}>{copy}<div className="sf-hero-media">{s.imageUrl && img}</div></section>;
    case "type":
      return <section className={`sf-hero sf-hero-type ${toneClass(s)}`}><div className="sf-wrap">{copy}</div></section>;
    case "mosaic":
      return (
        <section className={`sf-hero sf-hero-mosaic ${toneClass(s)}`}><div className="sf-wrap">
          {copy}
          <div className="sf-mosaic">{s.items.slice(0, 3).map((item, i) => <Link key={i} to={item.href || "products"}><img src={item.imageUrl} alt={item.title} fetchPriority={i === 0 ? "high" : undefined} /></Link>)}</div>
        </div></section>
      );
    case "spotlight": {
      const product = store.catalog.find((p) => p.featured) ?? store.catalog[0];
      return (
        <section className={`sf-hero sf-hero-spotlight ${toneClass(s)}`}><div className="sf-wrap">
          <div className="sf-hero-copy">
            {s.eyebrow && <p className="sf-eyebrow">{s.eyebrow}</p>}
            <h1>{product?.name ?? s.title}</h1>
            {s.body && <p className="sf-hero-body">{s.body}</p>}
            {product && <p className="sf-spot-price"><Price product={product} /></p>}
            <Link to={product ? `products/${product.id}` : "products"} className="sf-btn sf-btn-accent">{s.ctaLabel || "See details"}</Link>
          </div>
          <div className="sf-spot-media"><img src={product?.images[0] ?? s.imageUrl} alt={product?.name ?? ""} fetchPriority="high" /></div>
        </div></section>
      );
    }
    case "search":
      return (
        <section className={`sf-hero sf-hero-search ${toneClass(s)}`} style={s.imageUrl ? { backgroundImage: `linear-gradient(rgba(0,0,0,.45),rgba(0,0,0,.45)),url("${s.imageUrl}")` } : undefined}>
          <div className="sf-wrap">
            <h1>{s.title}</h1>
            {s.body && <p>{s.body}</p>}
            <HeroSearch onSearch={(q) => go(`products?q=${encodeURIComponent(q)}`)} />
          </div>
        </section>
      );
    case "cover":
      return <section className={`sf-hero sf-hero-cover ${toneClass(s)}`}>{s.imageUrl && img}<div className="sf-hero-veil" />{copy}</section>;
    case "stacked":
      return <section className={`sf-hero sf-hero-stacked ${toneClass(s)}`}><div className="sf-wrap">{copy}</div><div className="sf-hero-media">{s.imageUrl && img}</div></section>;
    default:
      return <section className={`sf-hero sf-hero-full ${toneClass(s)}`}>{s.imageUrl && img}<div className="sf-hero-veil" /><div className="sf-wrap">{copy}</div></section>;
  }
}

function HeroSearch({ onSearch }: { onSearch: (q: string) => void }) {
  const [q, setQ] = useState("");
  return (
    <form className="sf-hero-searchbox" role="search" onSubmit={(e: FormEvent) => { e.preventDefault(); onSearch(q); }}>
      <Search size={20} aria-hidden="true" />
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="What do you need today?" aria-label="Search products" />
      <button type="submit" className="sf-btn sf-btn-accent">Search</button>
    </form>
  );
}

function Categories({ s }: { s: StoreSection }) {
  const { store } = useStore();
  if (store.categories.length === 0) return null;
  const to = (name: string) => `products?category=${encodeURIComponent(name)}`;
  return (
    <section className={`sf-section ${toneClass(s)}`}><div className="sf-wrap">
      <Heading s={s} />
      {s.variant === "text" && <div className="sf-cat-text">{store.categories.map((c) => <Link key={c.name} to={to(c.name)}>{c.name}<sup>{c.count}</sup></Link>)}</div>}
      {s.variant === "chips" && <div className="sf-cat-chips">{store.categories.map((c) => <Link key={c.name} to={to(c.name)}>{c.name}</Link>)}</div>}
      {s.variant === "photo" && <div className="sf-cat-photo">{store.categories.slice(0, 4).map((c) => <Link key={c.name} to={to(c.name)}><Img src={c.imageUrl} alt="" ratio="4/3" /><span>{c.name}</span></Link>)}</div>}
      {(s.variant === "tiles" || !s.variant) && <div className="sf-cat-tiles">{store.categories.map((c) => <Link key={c.name} to={to(c.name)}><Img src={c.imageUrl} alt="" ratio="1/1" /><span>{c.name}</span></Link>)}</div>}
    </div></section>
  );
}

function Products({ s }: { s: StoreSection }) {
  const { store } = useStore();
  const list = useMemo(() => productsForSection(store.catalog, s), [store.catalog, s]);
  if (list.length === 0) return s.source === "onSale" || s.source === "category" ? null : (
    <section className={`sf-section ${toneClass(s)}`}><div className="sf-wrap"><Heading s={s} /><p className="sf-muted">Products will appear here soon.</p></div></section>
  );
  return (
    <section className={`sf-section ${toneClass(s)}`}><div className="sf-wrap">
      <div className={`sf-sec-head sf-sec-head-row sf-align-${s.align}`}>
        <div>{s.eyebrow && <p className="sf-eyebrow">{s.eyebrow}</p>}{s.title && <h2>{s.title}</h2>}</div>
        {s.align !== "center" && store.catalog.length > list.length && <Link to="products" className="sf-more">View all</Link>}
      </div>
      <ProductGrid products={list} grid={s.grid} columns={s.columns} card={s.card || undefined} />
    </div></section>
  );
}

function Banner({ s }: { s: StoreSection }) {
  if (s.variant === "side") {
    return <section className={`sf-banner sf-banner-side ${toneClass(s)}`}><div className="sf-banner-copy">{s.eyebrow && <p className="sf-eyebrow">{s.eyebrow}</p>}<h2>{s.title}</h2>{s.body && <p>{s.body}</p>}<Cta s={s} kind={s.tone === "accent" ? "inverse" : "accent"} /></div>{s.imageUrl && <div className="sf-banner-media"><img src={s.imageUrl} alt="" loading="lazy" /></div>}</section>;
  }
  return (
    <section className={`sf-banner ${toneClass(s)} ${s.imageUrl ? "has-image" : ""}`}>
      {s.imageUrl && <img src={s.imageUrl} alt="" loading="lazy" />}
      <div className="sf-wrap sf-banner-copy">{s.eyebrow && <p className="sf-eyebrow">{s.eyebrow}</p>}<h2>{s.title}</h2>{s.body && <p>{s.body}</p>}<Cta s={s} kind={s.tone === "accent" ? "inverse" : "accent"} /></div>
    </section>
  );
}

function About({ s }: { s: StoreSection }) {
  return (
    <section className={`sf-section sf-about ${toneClass(s)}`}><div className="sf-wrap">
      <div>{s.title && <h2>{s.title}</h2>}{s.body && <p>{s.body}</p>}<Cta s={s} kind="outline" /></div>
      {s.imageUrl && <Img src={s.imageUrl} alt="" ratio="4/3" />}
    </div></section>
  );
}

/** Real published reviews, and anything the merchant wrote in themselves. Nothing is ever invented. */
function Testimonials({ s }: { s: StoreSection }) {
  const { store } = useStore();
  const quotes = [...s.items.map((i) => ({ text: i.text, author: i.title, rating: 5 })), ...store.reviews.map((r) => ({ text: r.text, author: r.author ?? "Verified buyer", rating: r.rating }))].slice(0, 6);
  if (quotes.length === 0) return null;
  return (
    <section className={`sf-section sf-quotes ${toneClass(s)}`}><div className="sf-wrap">
      <Heading s={s} />
      <div className="sf-quote-grid">{quotes.map((q, i) => (
        <figure key={i}><div className="sf-stars" aria-label={`${q.rating} out of 5`}>{Array.from({ length: q.rating }, (_, n) => <Star key={n} size={14} fill="currentColor" aria-hidden="true" />)}</div><blockquote>{q.text}</blockquote><figcaption>{q.author}</figcaption></figure>
      ))}</div>
    </div></section>
  );
}

function Newsletter({ s }: { s: StoreSection }) {
  const { store, demo } = useStore();
  const [email, setEmail] = useState("");
  const [done, setDone] = useState(false);
  const subscribe = trpc.storefront.shop.subscribe.useMutation({ onSuccess: () => setDone(true) });
  return (
    <section className={`sf-section sf-news ${toneClass(s)}`}><div className={`sf-wrap sf-align-${s.align}`}>
      {s.title && <h2>{s.title}</h2>}
      {s.body && <p>{s.body}</p>}
      {done ? <p role="status">Thanks, you're on the list.</p> : (
        <form onSubmit={(e) => { e.preventDefault(); if (demo) setDone(true); else subscribe.mutate({ slug: store.slug, email }); }}>
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Your email" aria-label="Your email" />
          <button type="submit" className="sf-btn sf-btn-accent" disabled={subscribe.isPending}>Sign up</button>
        </form>
      )}
      {subscribe.error && <p className="sf-error" role="alert">{subscribe.error.message}</p>}
    </div></section>
  );
}

function WhatsAppSection({ s }: { s: StoreSection }) {
  const { store } = useStore();
  const url = waLink(store, `Hello ${store.name}! ${s.title}`);
  if (!url) return null;
  return (
    <section className={`sf-section sf-wa-section ${toneClass(s)} ${s.imageUrl ? "has-image" : ""}`}><div className={`sf-wrap sf-align-${s.align}`}>
      <div><h2>{s.title}</h2>{s.body && <p>{s.body}</p>}
        <a className="sf-btn sf-btn-wa" href={url} target="_blank" rel="noreferrer"><MessageCircle size={18} aria-hidden="true" /> {s.ctaLabel || "Chat on WhatsApp"}</a>
      </div>
      {s.imageUrl && <Img src={s.imageUrl} alt="" ratio="4/3" />}
    </div></section>
  );
}

function Gallery({ s }: { s: StoreSection }) {
  if (s.items.length === 0) return null;
  return (
    <section className={`sf-section sf-gallery sf-gallery-${s.variant || "strip"} ${toneClass(s)}`}><div className="sf-wrap">
      <Heading s={s} />
      <div className="sf-gallery-items" style={{ "--n": s.items.length } as React.CSSProperties}>
        {s.items.map((item, i) => {
          const inner = <>{item.imageUrl && <img src={item.imageUrl} alt={item.title} loading="lazy" />}{item.title && <span>{item.title}</span>}</>;
          return item.href ? <Link key={i} to={item.href}>{inner}</Link> : <div key={i}>{inner}</div>;
        })}
      </div>
    </div></section>
  );
}

function Trust({ s }: { s: StoreSection }) {
  return (
    <section className={`sf-trust sf-trust-${s.variant || "plain"} ${toneClass(s)}`}><div className="sf-wrap">
      {s.items.map((item, i) => <div key={i}><ShieldCheck size={18} aria-hidden="true" /><span><strong>{item.title}</strong>{item.text && <small>{item.text}</small>}</span></div>)}
    </div></section>
  );
}

const Text = ({ s }: { s: StoreSection }) => (
  <section className={`sf-section sf-text sf-text-${s.variant || "plain"} ${toneClass(s)}`}><div className={`sf-wrap sf-align-${s.align}`}>
    {s.title && <h2>{s.title}</h2>}{s.body && <p>{s.body}</p>}<Cta s={s} kind="outline" />
  </div></section>
);

function Collections({ s }: { s: StoreSection }) {
  return (
    <section className={`sf-section ${toneClass(s)}`}><div className="sf-wrap">
      <Heading s={s} />
      <div className="sf-cat-photo">{s.items.map((item, i) => <Link key={i} to={item.href || "products"}><Img src={item.imageUrl || null} alt="" ratio="4/3" /><span>{item.title}</span></Link>)}</div>
    </div></section>
  );
}

export function Section({ section }: { section: StoreSection }) {
  if (section.hidden) return null;
  switch (section.type) {
    case "hero": return <Hero s={section} />;
    case "trust": return <Trust s={section} />;
    case "categories": return <Categories s={section} />;
    case "products": return <Products s={section} />;
    case "banner": return <Banner s={section} />;
    case "collections": return <Collections s={section} />;
    case "about": return <About s={section} />;
    case "testimonials": return <Testimonials s={section} />;
    case "newsletter": return <Newsletter s={section} />;
    case "whatsapp": return <WhatsAppSection s={section} />;
    case "text": return <Text s={section} />;
    case "gallery": return <Gallery s={section} />;
    default: return null;
  }
}
