import { ArrowRight } from "lucide-react";
import { useLocation } from "wouter";
import { useAuth } from "@/_core/hooks/useAuth";
import { OakLogo, OakMark } from "@/components/OakLogo";
import { Button } from "@/components/ui/button";
import { startLogin } from "@/const";
import { ADMIN_APP_PATH, belongsInAdminApp } from "@/lib/tenantAccess";

const MARKETS = [
  { word: "Oja", language: "Yoruba", text: "From Balogun to Dugbe, trade built on names people know and trust." },
  { word: "Ahia", language: "Igbo", text: "From Onitsha to Ariaria, the craft of buying well and selling better." },
  { word: "Kasuwa", language: "Hausa", text: "From Kurmi to Sabon Gari, centuries of commerce across the Sahel." },
];

const CAPABILITIES = [
  { title: "Your catalogue, in the chat", text: "Customers browse and order in the app they already use, with no download and no learning curve." },
  { title: "Payments held safely", text: "Money stays in escrow until the order arrives, so buyers can trust a shop they've only just met." },
  { title: "Orders and delivery in one place", text: "See what's been paid, what's on its way and what needs you, from a single dashboard." },
  { title: "Invoices and a storefront", text: "Send professional invoices, and give your shop a home of its own on the web." },
];

// Signed-in visitors still see this page. The call to action takes them back into their app.
export default function Home() {
  const { isAuthenticated, user } = useAuth();
  const [, navigate] = useLocation();
  const handleCta = () => {
    if (isAuthenticated && belongsInAdminApp(user)) {
      window.location.assign(ADMIN_APP_PATH);
    } else if (isAuthenticated) {
      navigate("/dashboard");
    } else {
      startLogin();
    }
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <nav className="mx-auto flex max-w-7xl items-center justify-between px-6 py-6 lg:px-10">
        <OakLogo />
        <Button variant="outline" onClick={handleCta}>
          {isAuthenticated ? "Go to Dashboard" : "Sign In"}
        </Button>
      </nav>

      <header className="mx-auto grid max-w-7xl items-center gap-12 px-6 pb-20 pt-8 lg:grid-cols-[1fr_1.15fr] lg:px-10">
        <div>
          <p className="oak-eyebrow text-[#A64B27]">Oja · Ahia · Kasuwa</p>
          <h1 className="oak-display mt-5 text-5xl leading-[1.05] text-[var(--oak-forest)] sm:text-6xl">
            African commerce has deep roots. Now it has a home.
          </h1>
          <p className="mt-6 max-w-lg text-lg leading-relaxed text-muted-foreground">
            OAK gives merchants what a good market always has: trust, regular customers and money that moves safely, in the chat apps people already use.
          </p>
          <Button size="lg" onClick={handleCta} className="mt-9 gap-2">
            {isAuthenticated ? "Go to Dashboard" : "Open your shop"} <ArrowRight className="h-4 w-4" />
          </Button>
        </div>
        <figure className="relative">
          <img
            src="/images/oak/photos/market-traders.webp"
            srcSet="/images/oak/photos/market-traders-800.webp 800w, /images/oak/photos/market-traders.webp 1600w"
            sizes="(min-width: 1024px) 55vw, 100vw"
            alt="Two women trading vegetables at a busy market"
            className="aspect-[4/3] w-full rounded-sm object-cover"
          />
          <div className="oak-weave-band !h-3" />
        </figure>
      </header>

      <section className="border-y border-border bg-card">
        <div className="mx-auto grid max-w-7xl gap-12 px-6 py-20 lg:grid-cols-[1fr_2fr] lg:px-10">
          <div>
            <OakMark className="h-14 w-14" />
            <h2 className="oak-display mt-6 text-4xl text-[var(--oak-forest)]">Three words for market. One name.</h2>
            <p className="mt-4 text-muted-foreground">OAK stands for Oja, Ahia and Kasuwa. Like the tree, it's built to last, with rings that grow year on year.</p>
          </div>
          <div className="grid gap-10 sm:grid-cols-3">
            {MARKETS.map((market) => (
              <div key={market.word} className="border-t-2 border-[var(--oak-brass)] pt-5">
                <h3 className="oak-display text-3xl text-[var(--oak-forest)]">{market.word}</h3>
                <p className="oak-eyebrow mt-1 text-muted-foreground">{market.language}</p>
                <p className="mt-4 text-sm leading-relaxed text-muted-foreground">{market.text}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="mx-auto grid max-w-7xl items-center gap-14 px-6 py-24 lg:grid-cols-2 lg:px-10">
        <img
          src="/images/oak/photos/merchant-shop.webp"
          srcSet="/images/oak/photos/merchant-shop-800.webp 800w, /images/oak/photos/merchant-shop.webp 1600w"
          sizes="(min-width: 1024px) 50vw, 100vw"
          loading="lazy"
          alt="A shopkeeper smiling at the counter of her well-stocked store"
          className="aspect-[4/3] w-full rounded-sm object-cover"
        />
        <div>
          <h2 className="oak-display text-4xl text-[var(--oak-forest)]">Everything your shop needs, and nothing it doesn't.</h2>
          <dl className="mt-10 divide-y divide-border">
            {CAPABILITIES.map((item) => (
              <div key={item.title} className="py-5">
                <dt className="font-semibold">{item.title}</dt>
                <dd className="mt-1 text-sm leading-relaxed text-muted-foreground">{item.text}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      <section className="mx-auto grid max-w-7xl gap-3 px-6 pb-24 sm:grid-cols-3 lg:px-10">
        <img loading="lazy" src="/images/oak/photos/aso-oke-portrait-800.webp" alt="A woman wearing hand-woven aso-oke" className="aspect-[4/5] w-full rounded-sm object-cover" />
        <img loading="lazy" src="/images/oak/photos/ankara-textiles-800.webp" alt="Stacks of Ankara fabric on display" className="aspect-[4/5] w-full rounded-sm object-cover" />
        <img loading="lazy" src="/images/oak/photos/boutique-customer-800.webp" alt="A boutique owner talking with a customer" className="aspect-[4/5] w-full rounded-sm object-cover" />
      </section>

      <section className="bg-[var(--oak-forest)] text-[var(--oak-ivory)]">
        <div className="oak-weave-band" />
        <div className="mx-auto flex max-w-7xl flex-col items-start justify-between gap-8 px-6 py-20 md:flex-row md:items-center lg:px-10">
          <h2 className="oak-display max-w-2xl text-4xl sm:text-5xl">Plant your shop. Watch it grow.</h2>
          <Button size="lg" onClick={handleCta} className="gap-2 bg-[var(--oak-ivory)] text-[var(--oak-forest)] hover:bg-white">
            {isAuthenticated ? "Go to Dashboard" : "Get started"} <ArrowRight className="h-4 w-4" />
          </Button>
        </div>
      </section>

      <footer className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-6 py-8 text-sm text-muted-foreground lg:px-10">
        <OakLogo size="sm" />
        <span>African roots. Global standards.</span>
      </footer>
    </div>
  );
}
