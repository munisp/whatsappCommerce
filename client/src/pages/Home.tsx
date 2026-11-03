import { useLocation } from "wouter";
import { useAuth } from "@/_core/hooks/useAuth";
import { ChatScene } from "@/components/landing/ChatScene";
import { LandingHero } from "@/components/landing/LandingHero";
import { MarketsScene } from "@/components/landing/MarketsScene";
import { Photo } from "@/components/landing/Photo";
import { Reveal } from "@/components/landing/Reveal";
import { RingsScene } from "@/components/landing/RingsScene";
import "@/components/landing/landing.css";
import { OakLogo } from "@/components/OakLogo";
import { startLogin } from "@/const";
import { ADMIN_APP_PATH, belongsInAdminApp } from "@/lib/tenantAccess";

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
      <div className="relative">
        <LandingHero
          ctaLabel={isAuthenticated ? "Go to Dashboard" : "Open your shop"}
          signInLabel={isAuthenticated ? "Go to Dashboard" : "Sign In"}
          onCta={handleCta}
          onSeeSale={() => document.getElementById("a-sale")?.scrollIntoView({ behavior: "smooth" })}
        />
        <ChatScene id="a-sale" />
      </div>

      <MarketsScene />

      <section className="relative z-[1] bg-[var(--oak-paper)]">
        <div className="mx-auto grid max-w-7xl items-center gap-14 px-6 py-24 lg:grid-cols-2 lg:px-10 lg:py-32">
          <Reveal>
            <Photo
              name="boutique-customer"
              lazy
              sizes="(min-width: 1024px) 50vw, 100vw"
              alt="A boutique owner talking with a customer"
              className="aspect-[4/3] w-full rounded-sm object-cover"
            />
          </Reveal>
          <div>
            <Reveal>
              <h2 className="oak-display text-4xl leading-tight text-[var(--oak-forest)] lg:text-5xl">Everything your shop needs, and nothing it doesn't.</h2>
            </Reveal>
            <dl className="mt-10 divide-y divide-border">
              {CAPABILITIES.map((item, index) => (
                <Reveal key={item.title} delay={index * 80} className="py-5">
                  <dt className="font-semibold">{item.title}</dt>
                  <dd className="mt-1 text-sm leading-relaxed text-muted-foreground">{item.text}</dd>
                </Reveal>
              ))}
            </dl>
          </div>
        </div>
      </section>

      <RingsScene ctaLabel={isAuthenticated ? "Go to Dashboard" : "Get started"} onCta={handleCta} />

      <footer className="relative z-[1] bg-background">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-6 py-8 text-sm text-muted-foreground lg:px-10">
          <OakLogo size="sm" />
          <span>African roots. Global standards.</span>
        </div>
      </footer>
    </div>
  );
}
