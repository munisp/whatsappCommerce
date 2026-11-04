import { useEffect, useState } from "react";
import { trpc } from "@/lib/trpc";
import { useStore } from "./context";
import { Link } from "./parts";
import { formatMoney, ORDER_STATUS_LABEL, PAYMENT_STATUS_LABEL } from "./format";

const Field = ({ label, children }: { label: string; children: React.ReactNode }) => <label className="sf-field"><span>{label}</span>{children}</label>;

function AuthForm({ next }: { next: string }) {
  const { store, go } = useStore();
  const utils = trpc.useUtils();
  const [mode, setMode] = useState<"login" | "register" | "forgot">("login");
  const [form, setForm] = useState({ name: "", email: "", phone: "", password: "", marketing: false });
  const [sent, setSent] = useState(false);
  const done = async () => { await utils.storefront.shop.account.invalidate(); go(next); };
  const login = trpc.storefront.shop.account.login.useMutation({ onSuccess: done });
  const register = trpc.storefront.shop.account.register.useMutation({ onSuccess: done });
  const forgot = trpc.storefront.shop.account.forgotPassword.useMutation({ onSuccess: () => setSent(true) });
  const error = login.error ?? register.error ?? forgot.error;
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });
  return (
    <div className="sf-wrap sf-page sf-narrow">
      <h1>{mode === "login" ? "Sign in" : mode === "register" ? "Create your account" : "Reset your password"}</h1>
      <p className="sf-muted">{mode === "forgot" ? "We'll email you a link." : `Your account is for ${store.name} only. You can also check out as a guest.`}</p>
      {sent ? <p role="status">If there's an account with that email, a reset link is on its way.</p> : (
        <form className="sf-stack" onSubmit={(e) => {
          e.preventDefault();
          if (mode === "login") login.mutate({ slug: store.slug, email: form.email, password: form.password });
          else if (mode === "register") register.mutate({ slug: store.slug, name: form.name, email: form.email, phone: form.phone || null, password: form.password, marketingOptIn: form.marketing });
          else forgot.mutate({ slug: store.slug, email: form.email });
        }}>
          {mode === "register" && <Field label="Full name"><input required minLength={2} autoComplete="name" value={form.name} onChange={set("name")} /></Field>}
          <Field label="Email"><input required type="email" autoComplete="email" value={form.email} onChange={set("email")} /></Field>
          {mode === "register" && <Field label="Phone (optional)"><input type="tel" autoComplete="tel" value={form.phone} onChange={set("phone")} /></Field>}
          {mode !== "forgot" && <Field label="Password"><input required type="password" minLength={mode === "register" ? 8 : 1} autoComplete={mode === "register" ? "new-password" : "current-password"} value={form.password} onChange={set("password")} /></Field>}
          {mode === "register" && <label className="sf-check"><input type="checkbox" checked={form.marketing} onChange={(e) => setForm({ ...form, marketing: e.target.checked })} /> Send me offers by email</label>}
          {error && <p className="sf-error" role="alert">{error.message}</p>}
          <button type="submit" className="sf-btn sf-btn-accent" disabled={login.isPending || register.isPending || forgot.isPending}>{mode === "login" ? "Sign in" : mode === "register" ? "Create account" : "Send reset link"}</button>
        </form>
      )}
      <div className="sf-auth-links">
        {mode !== "login" && <button type="button" className="sf-text-btn" onClick={() => { setMode("login"); setSent(false); }}>Back to sign in</button>}
        {mode === "login" && <><button type="button" className="sf-text-btn" onClick={() => setMode("register")}>Create an account</button><button type="button" className="sf-text-btn" onClick={() => setMode("forgot")}>Forgot your password?</button></>}
      </div>
    </div>
  );
}

export function ResetPassword({ token }: { token: string }) {
  const { store, go } = useStore();
  const [password, setPassword] = useState("");
  const reset = trpc.storefront.shop.account.resetPassword.useMutation();
  if (reset.isSuccess) return <div className="sf-wrap sf-page sf-narrow"><h1>Password changed</h1><button type="button" className="sf-btn sf-btn-accent" onClick={() => go("account")}>Sign in</button></div>;
  return (
    <div className="sf-wrap sf-page sf-narrow">
      <h1>Choose a new password</h1>
      <form className="sf-stack" onSubmit={(e) => { e.preventDefault(); reset.mutate({ slug: store.slug, token, password }); }}>
        <Field label="New password"><input required type="password" minLength={8} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
        {reset.error && <p className="sf-error" role="alert">{reset.error.message}</p>}
        <button type="submit" className="sf-btn sf-btn-accent" disabled={reset.isPending}>Save password</button>
      </form>
    </div>
  );
}

function Profile({ me }: { me: { name: string; email: string; phone: string | null; marketingOptIn: boolean } }) {
  const { store } = useStore();
  const utils = trpc.useUtils();
  const [form, setForm] = useState({ name: me.name, phone: me.phone ?? "", marketing: me.marketingOptIn });
  const [pw, setPw] = useState({ current: "", next: "" });
  const update = trpc.storefront.shop.account.updateProfile.useMutation({ onSuccess: () => utils.storefront.shop.account.me.invalidate() });
  const change = trpc.storefront.shop.account.changePassword.useMutation({ onSuccess: () => setPw({ current: "", next: "" }) });
  return (
    <div className="sf-stack-lg">
      <form className="sf-stack" onSubmit={(e) => { e.preventDefault(); update.mutate({ slug: store.slug, name: form.name, phone: form.phone || null, marketingOptIn: form.marketing }); }}>
        <h2>Profile</h2>
        <Field label="Email"><input value={me.email} disabled /></Field>
        <Field label="Name"><input required minLength={2} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
        <Field label="Phone"><input type="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
        <label className="sf-check"><input type="checkbox" checked={form.marketing} onChange={(e) => setForm({ ...form, marketing: e.target.checked })} /> Send me offers by email</label>
        {update.isSuccess && <p role="status">Saved.</p>}
        {update.error && <p className="sf-error" role="alert">{update.error.message}</p>}
        <button type="submit" className="sf-btn sf-btn-accent" disabled={update.isPending}>Save</button>
      </form>
      <form className="sf-stack" onSubmit={(e) => { e.preventDefault(); change.mutate({ slug: store.slug, ...pw }); }}>
        <h2>Password</h2>
        <Field label="Current password"><input required type="password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} /></Field>
        <Field label="New password"><input required type="password" minLength={8} autoComplete="new-password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} /></Field>
        {change.isSuccess && <p role="status">Password changed.</p>}
        {change.error && <p className="sf-error" role="alert">{change.error.message}</p>}
        <button type="submit" className="sf-btn sf-btn-outline" disabled={change.isPending}>Change password</button>
      </form>
    </div>
  );
}

const EMPTY_ADDRESS = { label: "", recipient: "", phone: "", line1: "", city: "", state: "", isDefault: false };

function Addresses() {
  const { store } = useStore();
  const utils = trpc.useUtils();
  const list = trpc.storefront.shop.account.addresses.useQuery({ slug: store.slug });
  const [form, setForm] = useState<(typeof EMPTY_ADDRESS & { id?: string }) | null>(null);
  const refresh = () => utils.storefront.shop.account.addresses.invalidate();
  const save = trpc.storefront.shop.account.saveAddress.useMutation({ onSuccess: () => { setForm(null); void refresh(); } });
  const remove = trpc.storefront.shop.account.deleteAddress.useMutation({ onSuccess: refresh });
  const set = (k: keyof typeof EMPTY_ADDRESS) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => (f ? { ...f, [k]: e.target.value } : f));
  return (
    <div className="sf-stack">
      <h2>Saved addresses</h2>
      {list.data?.length === 0 && !form && <p className="sf-muted">No saved addresses yet.</p>}
      {list.data?.map((a) => (
        <div className="sf-address" key={a.id}>
          <div><strong>{a.label || a.recipient}</strong>{a.isDefault && <span className="sf-badge-inline">Default</span>}<p>{a.recipient}, {a.phone}<br />{a.line1}, {a.city}{a.state ? `, ${a.state}` : ""}</p></div>
          <div><button type="button" className="sf-text-btn" onClick={() => setForm({ id: a.id, label: a.label ?? "", recipient: a.recipient, phone: a.phone, line1: a.line1, city: a.city, state: a.state ?? "", isDefault: a.isDefault })}>Edit</button>
            <button type="button" className="sf-text-btn" onClick={() => remove.mutate({ slug: store.slug, id: a.id })}>Remove</button></div>
        </div>
      ))}
      {form ? (
        <form className="sf-stack" onSubmit={(e) => { e.preventDefault(); save.mutate({ slug: store.slug, ...form, id: form.id ?? null }); }}>
          <Field label="Label (Home, Office…)"><input value={form.label} onChange={set("label")} /></Field>
          <Field label="Recipient"><input required value={form.recipient} onChange={set("recipient")} /></Field>
          <Field label="Phone"><input required type="tel" minLength={7} value={form.phone} onChange={set("phone")} /></Field>
          <Field label="Address"><input required minLength={3} value={form.line1} onChange={set("line1")} /></Field>
          <Field label="City"><input required value={form.city} onChange={set("city")} /></Field>
          <Field label="State"><input value={form.state} onChange={set("state")} /></Field>
          <label className="sf-check"><input type="checkbox" checked={form.isDefault} onChange={(e) => setForm({ ...form, isDefault: e.target.checked })} /> Make this my default</label>
          {save.error && <p className="sf-error" role="alert">{save.error.message}</p>}
          <div className="sf-inline"><button type="submit" className="sf-btn sf-btn-accent" disabled={save.isPending}>Save address</button><button type="button" className="sf-btn sf-btn-outline" onClick={() => setForm(null)}>Cancel</button></div>
        </form>
      ) : <button type="button" className="sf-btn sf-btn-outline" onClick={() => setForm({ ...EMPTY_ADDRESS })}>Add an address</button>}
    </div>
  );
}

function Orders() {
  const { store } = useStore();
  const list = trpc.storefront.shop.account.orders.useQuery({ slug: store.slug });
  if (list.isLoading) return <p role="status">Loading your orders…</p>;
  return (
    <div className="sf-stack">
      <h2>Your orders</h2>
      {list.data?.length === 0 && <div className="sf-empty"><p>You haven't ordered while signed in yet.</p><Link to="products" className="sf-btn sf-btn-accent">Start shopping</Link></div>}
      {list.data?.map((o) => (
        <Link key={o.token} to={`orders/${o.token}`} className="sf-order-row">
          <span><strong>{o.orderNumber}</strong><small>{new Date(o.createdAt).toLocaleDateString()} · {o.itemCount} {o.itemCount === 1 ? "item" : "items"}</small></span>
          <span>{ORDER_STATUS_LABEL[o.status] ?? o.status}<small>{o.paymentMethod === "cod" && o.paymentStatus !== "completed" ? "Pay on delivery" : PAYMENT_STATUS_LABEL[o.paymentStatus] ?? o.paymentStatus}</small></span>
          <strong>{formatMoney(o.total, o.currency)}</strong>
        </Link>
      ))}
    </div>
  );
}

export function Account({ tab, next }: { tab: string; next: string | null }) {
  const { store, demo, go } = useStore();
  const utils = trpc.useUtils();
  const me = trpc.storefront.shop.account.me.useQuery({ slug: store.slug }, { enabled: !demo, retry: false });
  const logout = trpc.storefront.shop.account.logout.useMutation({ onSuccess: async () => { await utils.storefront.shop.account.invalidate(); go(""); } });
  useEffect(() => { if (me.data && next) go(next); }, [me.data, next, go]);
  if (demo) return <div className="sf-wrap sf-page sf-narrow"><h1>Customer accounts</h1><p className="sf-muted">On your live store, customers can sign up, save addresses and see their orders here. This is a template preview, so sign-in is switched off.</p></div>;
  if (me.isLoading) return <div className="sf-wrap sf-page"><p role="status">Loading…</p></div>;
  if (!me.data) return <AuthForm next={next ?? "account"} />;
  const tabs: [string, string][] = [["orders", "Orders"], ["addresses", "Addresses"], ["profile", "Profile"]];
  const active = tabs.some(([k]) => k === tab) ? tab : "orders";
  return (
    <div className="sf-wrap sf-page sf-account">
      <div className="sf-account-head"><h1>Hello, {me.data.name.split(" ")[0]}</h1><button type="button" className="sf-text-btn" onClick={() => logout.mutate({ slug: store.slug })}>Sign out</button></div>
      <nav className="sf-tabs" aria-label="Account">{tabs.map(([k, label]) => <Link key={k} to={`account/${k}`} className={active === k ? "is-on" : ""}>{label}</Link>)}</nav>
      {active === "orders" && <Orders />}
      {active === "addresses" && <Addresses />}
      {active === "profile" && <Profile me={me.data} />}
    </div>
  );
}
