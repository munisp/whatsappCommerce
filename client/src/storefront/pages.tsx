import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { CheckCircle2, ChevronLeft, MessageCircle, Package, ShieldCheck, Truck } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { useStore, type StoreProduct } from "./context";
import { Section } from "./sections";
import { CartLines, cartRows, CartWhatsApp, Img, Link, Price, ProductGrid, Qty, WhatsAppButton } from "./parts";
import { formatMoney, ORDER_STATUS_LABEL, PAYMENT_STATUS_LABEL, waLink } from "./format";

export const Home = () => {
  const { store } = useStore();
  return <>{store.config.sections.map((s) => <Section key={s.id} section={s} />)}</>;
};

const SORTS: [string, string][] = [["featured", "Featured"], ["popular", "Most popular"], ["newest", "Newest"], ["price_asc", "Price: low to high"], ["price_desc", "Price: high to low"], ["name", "Name"]];

export function Listing({ search }: { search: URLSearchParams }) {
  const { store, go } = useStore();
  const q = search.get("q") ?? "";
  const category = search.get("category") ?? "";
  const sort = search.get("sort") ?? "featured";
  const onSale = search.get("sale") === "1";
  const inStock = search.get("stock") === "1";
  const min = search.get("min") ?? "";
  const max = search.get("max") ?? "";
  const page = Math.max(1, Number(search.get("page") ?? 1));
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (search.get("focus")) inputRef.current?.focus(); }, [search]);

  const set = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(search);
    next.delete("page"); next.delete("focus");
    for (const [k, v] of Object.entries(patch)) { if (v) next.set(k, v); else next.delete(k); }
    go(`products${next.toString() ? `?${next}` : ""}`);
  };
  const pageSize = 24;
  const results = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    let list = store.catalog.filter((p) => {
      const price = Number(p.price);
      if (category && p.category !== category) return false;
      if (onSale && !p.compareAtPrice) return false;
      if (inStock && !p.inStock) return false;
      if (min && price < Number(min)) return false;
      if (max && price > Number(max)) return false;
      const hay = `${p.name} ${p.description ?? ""} ${p.category ?? ""}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
    const byPrice = (a: StoreProduct, b: StoreProduct) => Number(a.price) - Number(b.price);
    if (sort === "price_asc") list = [...list].sort(byPrice);
    else if (sort === "price_desc") list = [...list].sort((a, b) => byPrice(b, a));
    else if (sort === "popular") list = [...list].sort((a, b) => b.sold - a.sold);
    else if (sort === "name") list = [...list].sort((a, b) => a.name.localeCompare(b.name));
    else if (sort === "featured") list = [...list].sort((a, b) => Number(b.featured) - Number(a.featured) || b.sold - a.sold);
    return list;
  }, [store.catalog, q, category, onSale, inStock, min, max, sort]);
  const pageCount = Math.max(1, Math.ceil(results.length / pageSize));
  const shown = results.slice((page - 1) * pageSize, page * pageSize);
  const activeFilters = !!(q || category || onSale || inStock || min || max);

  const filters = (
    <div className="sf-filters">
      <label className="sf-field"><span>Category</span>
        <select value={category} onChange={(e) => set({ category: e.target.value || null })}>
          <option value="">All</option>{store.categories.map((c) => <option key={c.name} value={c.name}>{c.name} ({c.count})</option>)}
        </select>
      </label>
      <div className="sf-field sf-price-range"><span>Price</span><div>
        <input type="number" min={0} inputMode="numeric" defaultValue={min} key={`min${min}`} placeholder="Min" aria-label="Minimum price" onBlur={(e) => set({ min: e.target.value || null })} />
        <input type="number" min={0} inputMode="numeric" defaultValue={max} key={`max${max}`} placeholder="Max" aria-label="Maximum price" onBlur={(e) => set({ max: e.target.value || null })} />
      </div></div>
      <label className="sf-check"><input type="checkbox" checked={inStock} onChange={(e) => set({ stock: e.target.checked ? "1" : null })} /> In stock only</label>
      <label className="sf-check"><input type="checkbox" checked={onSale} onChange={(e) => set({ sale: e.target.checked ? "1" : null })} /> On sale</label>
    </div>
  );
  return (
    <div className={`sf-wrap sf-page sf-listing sf-listing-${store.config.product.filters}`}>
      <div className="sf-list-head">
        <h1>{category || (onSale ? "On sale" : q ? `Results for “${q}”` : "All products")}</h1>
        <p className="sf-muted" role="status">{results.length} {results.length === 1 ? "product" : "products"}</p>
      </div>
      <div className="sf-list-tools">
        <form role="search" onSubmit={(e) => { e.preventDefault(); set({ q: inputRef.current?.value || null }); }} className="sf-list-search">
          <input ref={inputRef} defaultValue={q} key={q} placeholder="Search this store" aria-label="Search this store" />
        </form>
        <label className="sf-sort"><span>Sort</span>
          <select value={sort} onChange={(e) => set({ sort: e.target.value === "featured" ? null : e.target.value })}>{SORTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        </label>
      </div>
      <div className="sf-list-body">
        {filters}
        <div>
          {shown.length ? <ProductGrid products={shown} /> : (
            <div className="sf-empty"><p>{activeFilters ? "Nothing matches those filters." : "No products here yet."}</p>
              {activeFilters && <button type="button" className="sf-btn sf-btn-outline" onClick={() => go("products")}>Clear filters</button>}</div>
          )}
          {pageCount > 1 && <nav className="sf-pages" aria-label="Pages">{Array.from({ length: pageCount }, (_, i) => <button key={i} type="button" aria-current={i + 1 === page ? "page" : undefined} onClick={() => { const n = new URLSearchParams(search); n.set("page", String(i + 1)); go(`products?${n}`); }}>{i + 1}</button>)}</nav>}
        </div>
      </div>
    </div>
  );
}

export function ProductPage({ id }: { id: string }) {
  const { store, cart, setDrawerOpen, demo } = useStore();
  const product = store.catalog.find((p) => p.id === id);
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [qty, setQty] = useState(1);
  const [image, setImage] = useState(0);
  const [needsChoice, setNeedsChoice] = useState(false);
  const reviews = trpc.storefront.shop.product.useQuery({ slug: store.slug, productId: id }, { enabled: !demo && !!product, retry: false });
  useEffect(() => { setSelected({}); setQty(1); setImage(0); window.scrollTo(0, 0); }, [id]);
  if (!product) return <NotFound what="That product isn't available any more." />;
  const variants = product.variants ?? [];
  const allChosen = product.options.every((o) => selected[o.name]);
  const variant = variants.find((v) => product.options.every((o) => v.attributes[o.name] === selected[o.name]));
  const isAvailable = (option: string, value: string) => variants.length === 0 || variants.some((v) => v.inStock && v.attributes[option] === value && Object.entries(selected).every(([k, val]) => k === option || v.attributes[k] === val));
  const inStock = variants.length > 0 ? (allChosen ? !!variant?.inStock : product.inStock) : product.inStock;
  const add = () => {
    if (!allChosen) { setNeedsChoice(true); return; }
    const variantId = variant?.id ?? (demo && product.options.length ? `demo:${Object.values(selected).join(" / ")}` : null);
    cart.add(product.id, variantId, qty);
    setDrawerOpen(true);
  };
  const related = store.catalog.filter((p) => p.id !== product.id && p.category === product.category).concat(store.catalog.filter((p) => p.id !== product.id && p.category !== product.category)).slice(0, 4);
  const choice = Object.values(selected).join(" / ");
  const enquiry = waLink(store, `Hello ${store.name}! I'm interested in ${product.name}${choice ? ` (${choice})` : ""}, ${formatMoney(product.price, store.currency)}.`);
  const list = reviews.data?.reviews ?? [];
  return (
    <div className="sf-wrap sf-page sf-pdp">
      <Link to="products" className="sf-back"><ChevronLeft size={16} aria-hidden="true" /> All products</Link>
      <div className="sf-pdp-grid">
        <div className="sf-pdp-media">
          <Img src={product.images[image] ?? product.imageUrl} alt={product.name} priority ratio={store.config.theme.imageRatio === "free" ? "4/5" : store.config.theme.imageRatio} />
          {product.images.length > 1 && <div className="sf-thumbs">{product.images.map((src, i) => <button key={src} type="button" aria-label={`Photo ${i + 1}`} aria-current={i === image} onClick={() => setImage(i)}><img src={src} alt="" /></button>)}</div>}
        </div>
        <div className="sf-pdp-info">
          {product.category && <Link to={`products?category=${encodeURIComponent(product.category)}`} className="sf-eyebrow">{product.category}</Link>}
          <h1>{product.name}</h1>
          <p className="sf-pdp-price"><Price product={product} /></p>
          <p className={`sf-stock ${inStock ? "is-in" : "is-out"}`} role="status">{!inStock ? "Sold out" : product.lowStock ? "In stock, only a few left" : product.preorder ? "Available to pre-order" : "In stock"}</p>
          {product.options.map((o) => (
            <fieldset key={o.name} className="sf-options"><legend>{o.name}{selected[o.name] ? `: ${selected[o.name]}` : ""}</legend>
              <div>{o.values.map((value) => (
                <button key={value} type="button" className={selected[o.name] === value ? "is-on" : ""} aria-pressed={selected[o.name] === value} disabled={!isAvailable(o.name, value)} onClick={() => { setSelected((s) => ({ ...s, [o.name]: value })); setNeedsChoice(false); }}>{value}</button>
              ))}</div>
            </fieldset>
          ))}
          {needsChoice && <p className="sf-error" role="alert">Choose {product.options.filter((o) => !selected[o.name]).map((o) => o.name.toLowerCase()).join(" and ")} first.</p>}
          <div className="sf-buy"><Qty value={qty} onChange={setQty} label={product.name} /><button type="button" className="sf-btn sf-btn-accent sf-grow" disabled={!inStock} onClick={add}>{inStock ? "Add to cart" : "Sold out"}</button></div>
          {enquiry && <a className="sf-btn sf-btn-wa sf-btn-full" href={enquiry} target="_blank" rel="noreferrer"><MessageCircle size={18} aria-hidden="true" /> Ask about this on WhatsApp</a>}
          {product.description && <div className="sf-desc"><p>{product.description}</p></div>}
          {product.ageRestricted && <p className="sf-muted">For ages {product.minAge ?? 18} and over. We'll ask you to confirm at checkout.</p>}
          <ul className="sf-assure"><li><ShieldCheck size={16} aria-hidden="true" /> Secure payment</li><li><Truck size={16} aria-hidden="true" /> Track your order online</li></ul>
        </div>
      </div>
      {list.length > 0 && <section className="sf-section"><h2>Reviews</h2><div className="sf-quote-grid">{list.map((r, i) => <figure key={i}><div className="sf-stars" aria-label={`${r.rating} out of 5`}>{"★".repeat(r.rating)}</div><blockquote>{r.text}</blockquote><figcaption>Verified buyer</figcaption></figure>)}</div></section>}
      {related.length > 0 && <section className="sf-section"><h2>You may also like</h2><ProductGrid products={related} columns={4} card={store.config.product.card === "row" || store.config.product.card === "menu" ? "boxed" : undefined} /></section>}
      <WhatsAppMessageSetter message={`Hello ${store.name}! I'm looking at ${product.name}.`} />
    </div>
  );
}

const WhatsAppMessageSetter = ({ message }: { message: string }) => <span data-wa-message={message} hidden />;

export function CartPage() {
  const { store, cart, go } = useStore();
  const rows = cartRows(store.catalog, cart.lines);
  const subtotal = rows.reduce((n, r) => n + Number(r.product.price) * r.line.quantity, 0);
  if (rows.length === 0) return <div className="sf-wrap sf-page"><div className="sf-empty"><h1>Your cart is empty</h1><Link to="products" className="sf-btn sf-btn-accent">Start shopping</Link></div></div>;
  return (
    <div className="sf-wrap sf-page sf-cart-page">
      <h1>Your cart</h1>
      <div className="sf-two-col">
        <div className="sf-lines"><CartLines rows={rows} /></div>
        <aside className="sf-summary">
          <div className="sf-sum-row"><span>Subtotal</span><strong>{formatMoney(subtotal, store.currency)}</strong></div>
          <small>Delivery and discount codes are added at checkout.</small>
          <button type="button" className="sf-btn sf-btn-accent sf-btn-full" onClick={() => go("checkout")}>Checkout</button>
          <CartWhatsApp rows={rows} subtotal={subtotal} />
        </aside>
      </div>
    </div>
  );
}

const Field = ({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) => (
  <label className="sf-field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>
);

export function Checkout() {
  const { store, cart, demo, go } = useStore();
  const lines = cart.lines.filter((l) => !l.variantId?.startsWith("demo:") || demo);
  const me = trpc.storefront.shop.account.me.useQuery({ slug: store.slug }, { enabled: !demo, retry: false });
  const saved = trpc.storefront.shop.account.addresses.useQuery({ slug: store.slug }, { enabled: !demo && !!me.data, retry: false });
  const [contact, setContact] = useState({ name: "", phone: "", email: "" });
  const [fulfillment, setFulfillment] = useState<"delivery" | "pickup">("delivery");
  const [address, setAddress] = useState({ line1: "", city: "", state: "" });
  const [payment, setPayment] = useState<"online" | "cod">(store.checkout.online ? "online" : "cod");
  const [promoInput, setPromoInput] = useState("");
  const [promo, setPromo] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [age, setAge] = useState("");
  const [saveAddress, setSaveAddress] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checkoutKey] = useState(() => crypto.randomUUID());
  const addressText = [address.line1, address.city, address.state].filter(Boolean).join(", ");
  const [debouncedAddress, setDebounced] = useState("");
  useEffect(() => { const t = setTimeout(() => setDebounced(addressText), 500); return () => clearTimeout(t); }, [addressText]);
  useEffect(() => {
    if (!me.data) return;
    setContact((c) => ({ name: c.name || me.data!.name, phone: c.phone || (me.data!.phone ?? ""), email: c.email || me.data!.email }));
  }, [me.data]);
  useEffect(() => {
    const first = saved.data?.[0];
    if (first && !address.line1) setAddress({ line1: first.line1, city: first.city, state: first.state ?? "" });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved.data]);
  const quote = trpc.storefront.shop.quote.useQuery(
    { slug: store.slug, lines: lines.map((l) => ({ productId: l.productId, variantId: l.variantId, quantity: l.quantity })), fulfillment, address: debouncedAddress || null, promoCode: promo },
    { enabled: !demo && lines.length > 0, placeholderData: (prev) => prev, retry: false },
  );
  const place = trpc.storefront.shop.checkout.useMutation({
    onSuccess: (result) => {
      if (!result.ok) return;
      cart.clear();
      if (result.paymentMethod === "online" && result.paymentUrl) window.location.assign(result.paymentUrl);
      else go(`orders/${result.trackingToken}`);
    },
    onError: (e) => setError(e.message),
  });
  if (lines.length === 0) return <div className="sf-wrap sf-page"><div className="sf-empty"><h1>Your cart is empty</h1><Link to="products" className="sf-btn sf-btn-accent">Start shopping</Link></div></div>;
  if (demo) return <div className="sf-wrap sf-page"><div className="sf-empty"><h1>Checkout works on your live store</h1><p>This is a template preview with sample products, so nothing can be bought here.</p><Link to="products" className="sf-btn sf-btn-accent">Keep browsing</Link></div></div>;

  const q = quote.data;
  const rows = q?.lines ?? [];
  const unavailable = rows.find((l) => !l.available);
  const needsAge = q?.ageRestriction ?? null;
  const belowMin = !!q && q.minOrder > 0 && q.subtotal < q.minOrder;
  const noPayment = !store.checkout.online && !store.checkout.cod;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    place.mutate({
      slug: store.slug, checkoutKey,
      lines: lines.map((l) => ({ productId: l.productId, variantId: l.variantId, quantity: l.quantity })),
      contact: { name: contact.name, phone: contact.phone, email: contact.email || null },
      fulfillment,
      deliveryAddress: fulfillment === "delivery" ? { line1: address.line1, city: address.city, state: address.state || null } : null,
      paymentMethod: payment, promoCode: promo, note: note || null,
      ageAttestedAge: needsAge ? Number(age) || null : null,
      saveAddress: saveAddress || undefined,
    });
  };
  return (
    <div className="sf-wrap sf-page sf-checkout">
      <h1>Checkout</h1>
      <form className="sf-two-col" onSubmit={submit}>
        <div className="sf-steps">
          <section><h2><span>1</span> Contact</h2>
            {!me.data && <p className="sf-muted">Checking out as a guest. <Link to="account?next=checkout">Sign in</Link> to use saved details and see this order in your account.</p>}
            <div className="sf-form-grid">
              <Field label="Full name"><input required minLength={2} autoComplete="name" value={contact.name} onChange={(e) => setContact({ ...contact, name: e.target.value })} /></Field>
              <Field label="Phone" hint="For delivery and order updates."><input required type="tel" autoComplete="tel" value={contact.phone} onChange={(e) => setContact({ ...contact, phone: e.target.value })} /></Field>
              <Field label="Email" hint="Optional. We'll send your order details here."><input type="email" autoComplete="email" value={contact.email} onChange={(e) => setContact({ ...contact, email: e.target.value })} /></Field>
            </div>
          </section>
          <section><h2><span>2</span> Delivery</h2>
            <div className="sf-choice-row">
              <label className={`sf-choice ${fulfillment === "delivery" ? "is-on" : ""}`}><input type="radio" name="fulfillment" checked={fulfillment === "delivery"} onChange={() => setFulfillment("delivery")} /><Truck size={18} aria-hidden="true" /> Delivery</label>
              {store.checkout.pickup && <label className={`sf-choice ${fulfillment === "pickup" ? "is-on" : ""}`}><input type="radio" name="fulfillment" checked={fulfillment === "pickup"} onChange={() => setFulfillment("pickup")} /><Package size={18} aria-hidden="true" /> Pick up</label>}
            </div>
            {fulfillment === "delivery" ? (
              <>
                {(saved.data?.length ?? 0) > 0 && <Field label="Saved addresses"><select onChange={(e) => { const a = saved.data!.find((x) => x.id === e.target.value); if (a) setAddress({ line1: a.line1, city: a.city, state: a.state ?? "" }); }}>{saved.data!.map((a) => <option key={a.id} value={a.id}>{a.label || a.line1}, {a.city}</option>)}</select></Field>}
                <div className="sf-form-grid">
                  <Field label="Address"><input required minLength={3} autoComplete="street-address" value={address.line1} onChange={(e) => setAddress({ ...address, line1: e.target.value })} /></Field>
                  <Field label="City"><input required autoComplete="address-level2" value={address.city} onChange={(e) => setAddress({ ...address, city: e.target.value })} /></Field>
                  <Field label="State"><input autoComplete="address-level1" value={address.state} onChange={(e) => setAddress({ ...address, state: e.target.value })} /></Field>
                </div>
                {me.data && <label className="sf-check"><input type="checkbox" checked={saveAddress} onChange={(e) => setSaveAddress(e.target.checked)} /> Save this address to my account</label>}
              </>
            ) : <p className="sf-muted">{store.config.contact.address ? `Pick up from ${store.config.contact.address}.` : "The store will tell you where and when to collect."}</p>}
            <Field label="Note for the store (optional)"><textarea rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
          </section>
          <section><h2><span>3</span> Payment</h2>
            <div className="sf-choice-col">
              {store.checkout.online && <label className={`sf-choice ${payment === "online" ? "is-on" : ""}`}><input type="radio" name="payment" checked={payment === "online"} onChange={() => setPayment("online")} /><span><strong>Pay online</strong><small>Card, bank transfer or USSD on a secure payment page.</small></span></label>}
              {store.checkout.cod && fulfillment === "delivery" && <label className={`sf-choice ${payment === "cod" ? "is-on" : ""}`}><input type="radio" name="payment" checked={payment === "cod"} onChange={() => setPayment("cod")} /><span><strong>Pay on delivery</strong><small>Pay the rider when your order arrives.</small></span></label>}
            </div>
            {noPayment && <p className="sf-error" role="alert">This store isn't taking payments online right now. Please contact them on WhatsApp.</p>}
          </section>
          {needsAge && <section><h2><span>4</span> Confirm your age</h2><Field label={`Some items are for ages ${needsAge}+. How old are you?`}><input required type="number" min={1} max={120} value={age} onChange={(e) => setAge(e.target.value)} /></Field></section>}
        </div>
        <aside className="sf-summary">
          <h2>Your order</h2>
          {quote.isLoading && !q && <p className="sf-muted" role="status">Working out your total…</p>}
          {quote.error && <p className="sf-error" role="alert">{quote.error.message}</p>}
          <div className="sf-sum-lines">{rows.map((l) => (
            <div key={`${l.productId}:${l.variantId ?? ""}`} className={l.available ? "" : "is-unavailable"}>
              <span>{l.quantity} × {l.name}{l.variantLabel ? ` (${l.variantLabel})` : ""}{!l.available && <em> {l.reason === "choose_option" ? "needs an option" : "unavailable"}</em>}</span>
              <span>{formatMoney(l.unitPrice * l.quantity, q!.currency)}</span>
            </div>
          ))}</div>
          <div className="sf-promo">
            <input value={promoInput} onChange={(e) => setPromoInput(e.target.value)} placeholder="Discount code" aria-label="Discount code" />
            <button type="button" className="sf-btn sf-btn-outline" onClick={() => setPromo(promoInput.trim() || null)}>Apply</button>
          </div>
          {q?.promoError && <p className="sf-error" role="alert">{q.promoError}</p>}
          {q && <>
            <div className="sf-sum-row"><span>Subtotal</span><span>{formatMoney(q.subtotal, q.currency)}</span></div>
            {fulfillment === "delivery" && <div className="sf-sum-row"><span>Delivery{q.deliveryNote ? <small> {q.deliveryNote}</small> : null}</span><span>{formatMoney(q.deliveryFee, q.currency)}</span></div>}
            {q.discount > 0 && <div className="sf-sum-row is-discount"><span>Discount ({q.promoCode})</span><span>-{formatMoney(q.discount, q.currency)}</span></div>}
            <div className="sf-sum-row sf-sum-total"><span>Total</span><strong>{formatMoney(q.total, q.currency)}</strong></div>
          </>}
          {belowMin && <p className="sf-error" role="alert">The minimum order here is {formatMoney(q!.minOrder, q!.currency)}.</p>}
          {unavailable && <p className="sf-error" role="alert">Please <Link to="cart">update your cart</Link> before checking out.</p>}
          {error && <p className="sf-error" role="alert">{error}</p>}
          <button type="submit" className="sf-btn sf-btn-accent sf-btn-full" disabled={place.isPending || !q || !!unavailable || belowMin || noPayment}>
            {place.isPending ? "Placing your order…" : payment === "online" ? `Pay ${q ? formatMoney(q.total, q.currency) : ""}` : "Place order"}
          </button>
          <small className="sf-assure-line"><ShieldCheck size={14} aria-hidden="true" /> Your card details never reach this store.</small>
        </aside>
      </form>
    </div>
  );
}

export function OrderPage({ token, justPlaced }: { token: string; justPlaced?: boolean }) {
  const { store, demo } = useStore();
  const order = trpc.storefront.shop.order.useQuery({ slug: store.slug, token }, {
    enabled: !demo, retry: false,
    // A payment confirmation arrives by webhook, so an unpaid order checks back.
    refetchInterval: (q) => (q.state.data && q.state.data.paymentMethod === "online" && q.state.data.paymentStatus !== "completed" && q.state.data.status !== "cancelled" ? 8000 : false),
  });
  if (order.isLoading) return <div className="sf-wrap sf-page"><p role="status">Loading your order…</p></div>;
  if (!order.data) return <NotFound what="We couldn't find that order." />;
  const o = order.data;
  const paid = o.paymentStatus === "completed";
  const help = waLink(store, `Hello ${store.name}! I need help with order ${o.orderNumber}.`);
  const headline = paid ? "Thanks, your order is confirmed" : o.paymentMethod === "cod" ? "Thanks, your order is placed" : o.status === "cancelled" ? "This order was cancelled" : "Your order is waiting for payment";
  return (
    <div className="sf-wrap sf-page sf-order">
      <header className="sf-order-head">
        {(paid || o.paymentMethod === "cod") && o.status !== "cancelled" && <CheckCircle2 size={36} aria-hidden="true" />}
        <h1>{headline}</h1>
        <p>Order <strong>{o.orderNumber}</strong>{justPlaced ? ". Keep this page, or find it again from the link we send you." : ""}</p>
      </header>
      {!paid && o.paymentMethod === "online" && o.status !== "cancelled" && (
        <div className="sf-notice">
          <p>{o.paymentStatus === "failed" ? "The last payment attempt failed." : "If you've just paid, this page updates by itself once the payment is confirmed."}</p>
          {o.paymentUrl ? <a className="sf-btn sf-btn-accent" href={o.paymentUrl}>Pay {formatMoney(o.total, o.currency)}</a> : help && <a className="sf-btn sf-btn-outline" href={help} target="_blank" rel="noreferrer">Ask the store how to pay</a>}
        </div>
      )}
      <div className="sf-two-col">
        <div>
          <dl className="sf-order-status">
            <div><dt>Order</dt><dd>{ORDER_STATUS_LABEL[o.status] ?? o.status}</dd></div>
            <div><dt>Payment</dt><dd>{o.paymentMethod === "cod" && !paid ? "Pay on delivery" : PAYMENT_STATUS_LABEL[o.paymentStatus] ?? o.paymentStatus}</dd></div>
            <div><dt>{o.fulfillment === "pickup" ? "Collection" : "Delivery"}</dt><dd>{o.shipment ? String((o.shipment as { status?: string }).status ?? "").replace(/_/g, " ") || "Booked" : "Not dispatched yet"}{o.etaMinutes ? `, about ${Math.round(o.etaMinutes / 60) || 1}h` : ""}</dd></div>
          </dl>
          {o.history.length > 0 && <ol className="sf-history">{o.history.map((h) => <li key={h.status}><strong>{h.status.replace(/_/g, " ")}</strong>{h.at && <time>{new Date(h.at).toLocaleString()}</time>}</li>)}</ol>}
          {o.address && <p className="sf-muted"><strong>Delivering to:</strong> {o.address}</p>}
          {help && <a className="sf-btn sf-btn-wa" href={help} target="_blank" rel="noreferrer"><MessageCircle size={18} aria-hidden="true" /> Get help with this order</a>}
        </div>
        <aside className="sf-summary">
          <h2>Summary</h2>
          <div className="sf-sum-lines">{o.items.map((i, n) => <div key={n}><span>{i.qty} × {i.name}</span><span>{formatMoney(Number(i.price) * i.qty, o.currency)}</span></div>)}</div>
          <div className="sf-sum-row"><span>Subtotal</span><span>{formatMoney(o.subtotal, o.currency)}</span></div>
          {Number(o.deliveryFee) > 0 && <div className="sf-sum-row"><span>Delivery</span><span>{formatMoney(o.deliveryFee, o.currency)}</span></div>}
          {o.discount && <div className="sf-sum-row is-discount"><span>Discount</span><span>-{formatMoney(o.discount, o.currency)}</span></div>}
          <div className="sf-sum-row sf-sum-total"><span>Total</span><strong>{formatMoney(o.total, o.currency)}</strong></div>
        </aside>
      </div>
    </div>
  );
}

export function Track() {
  const { store, go, demo } = useStore();
  const [orderNumber, setNumber] = useState("");
  const [phone, setPhone] = useState("");
  const lookup = trpc.storefront.shop.lookupOrder.useMutation({ onSuccess: (r) => go(`orders/${r.token}`) });
  return (
    <div className="sf-wrap sf-page sf-narrow">
      <h1>Track an order</h1>
      <p className="sf-muted">Use the order number from your confirmation, and the phone number you ordered with.</p>
      <form onSubmit={(e) => { e.preventDefault(); if (!demo) lookup.mutate({ slug: store.slug, orderNumber, phone }); }} className="sf-stack">
        <Field label="Order number"><input required value={orderNumber} onChange={(e) => setNumber(e.target.value)} placeholder="ORD-…" /></Field>
        <Field label="Phone"><input required type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} /></Field>
        {lookup.error && <p className="sf-error" role="alert">{lookup.error.message}</p>}
        <button type="submit" className="sf-btn sf-btn-accent" disabled={lookup.isPending}>Find my order</button>
      </form>
    </div>
  );
}

export function Policy({ kind }: { kind: string }) {
  const { store } = useStore();
  const policies = store.config.policies as Record<string, string>;
  const titles: Record<string, string> = { delivery: "Delivery", returns: "Returns", privacy: "Privacy", terms: "Terms" };
  const text = policies[kind];
  if (!titles[kind]) return <NotFound what="That page doesn't exist." />;
  return <div className="sf-wrap sf-page sf-narrow"><h1>{titles[kind]}</h1>{text ? text.split(/\n{2,}/).map((p, i) => <p key={i}>{p}</p>) : <><p className="sf-muted">The store hasn't added this yet. Ask them directly.</p><Link to="whatsapp" className="sf-btn sf-btn-outline">Contact the store</Link></>}</div>;
}

export function Contact() {
  const { store } = useStore();
  const c = store.config.contact;
  const url = waLink(store, `Hello ${store.name}! I have a question.`);
  return (
    <div className="sf-wrap sf-page sf-narrow">
      <h1>Contact {store.name}</h1>
      {url && <a className="sf-btn sf-btn-wa" href={url} target="_blank" rel="noreferrer"><MessageCircle size={18} aria-hidden="true" /> Chat on WhatsApp</a>}
      <dl className="sf-contact">
        {c.phone && <div><dt>Phone</dt><dd><a href={`tel:${c.phone.replace(/\s/g, "")}`}>{c.phone}</a></dd></div>}
        {c.email && <div><dt>Email</dt><dd><a href={`mailto:${c.email}`}>{c.email}</a></dd></div>}
        {c.address && <div><dt>Address</dt><dd>{c.address}</dd></div>}
        {c.hours && <div><dt>Hours</dt><dd>{c.hours}</dd></div>}
      </dl>
      {!url && !c.phone && !c.email && <p className="sf-muted">This store hasn't added contact details yet.</p>}
    </div>
  );
}

export const NotFound = ({ what }: { what: string }) => <div className="sf-wrap sf-page"><div className="sf-empty"><h1>{what}</h1><Link to="" className="sf-btn sf-btn-accent">Back to the store</Link></div></div>;

export { WhatsAppButton };
