import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { startLogin } from "@/const";
import { Bot, Building2, MessageSquare, ShoppingCart, Zap, ArrowRight, Globe, Shield, BarChart3, Package, Users, CreditCard, Wallet } from "lucide-react";
import { useLocation } from "wouter";

// This page is shared between the legacy combined client's root (/) and
// ui/tenant-portal's own root (/tenant-portal/), built with different Vite
// `base` values. On the legacy root there's no real signed-in experience to
// return to, so "Sign In" first funnels into the tenant portal — its own
// copy of this page then starts the real login and correctly returns there.
const IS_LEGACY_ROOT = import.meta.env.BASE_URL === "/";

export default function Home() {
  const { isAuthenticated } = useAuth();
  const [, navigate] = useLocation();

  // Signed-in visitors still see the landing page (no auto-redirect/blank
  // flash) — the CTA just becomes a way back into the app they're already
  // signed into instead of a login prompt.
  const handleCta = () => {
    if (isAuthenticated) {
      navigate("/dashboard");
    } else if (IS_LEGACY_ROOT) {
      window.location.href = "/tenant-portal/";
    } else {
      startLogin();
    }
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Nav */}
      <nav className="border-b border-border px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center">
            <MessageSquare className="w-4 h-4 text-primary-foreground" />
          </div>
          <span className="font-bold text-lg">WhatsApp Commerce</span>
        </div>
        <Button onClick={handleCta} className="bg-primary text-primary-foreground hover:bg-primary/90">
          {isAuthenticated ? "Go to Dashboard" : "Sign In"}
        </Button>
      </nav>

      {/* Hero */}
      <section className="px-6 py-24 max-w-5xl mx-auto text-center">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-primary/30 bg-primary/10 text-primary text-xs font-medium mb-8">
          <Zap className="w-3 h-3" />
          The All-in-One WhatsApp Commerce Platform
        </div>
        <h1 className="text-5xl md:text-6xl font-bold leading-tight mb-6">
          Sell Smarter on{" "}
          <span className="text-primary">WhatsApp</span>
        </h1>
        <p className="text-xl text-muted-foreground max-w-2xl mx-auto mb-10">
          Everything you need to run and grow your business on WhatsApp — showcase your products,
          take orders, get paid, offer customer credit, and keep every conversation in one place.
        </p>
        <div className="flex items-center justify-center gap-4 flex-wrap">
          <Button size="lg" onClick={handleCta} className="bg-primary text-primary-foreground hover:bg-primary/90 gap-2">
            {isAuthenticated ? "Go to Dashboard" : "Launch Console"} <ArrowRight className="w-4 h-4" />
          </Button>
        </div>
      </section>

      {/* Features */}
      <section className="px-6 py-16 max-w-5xl mx-auto">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {[
            { icon: Bot, title: "Smart Assistant", desc: "Answers customers instantly, recommends the right products, and hands over to your team when a human touch is needed.", color: "text-primary" },
            { icon: ShoppingCart, title: "Sell Right in Chat", desc: "Share your catalog, take orders, and manage stock — your customers buy without ever leaving WhatsApp.", color: "text-blue-400" },
            { icon: Building2, title: "Your Business, Your Way", desc: "Your own storefront, your own currency, your own WhatsApp number — fully private and fully yours.", color: "text-purple-400" },
            { icon: Shield, title: "Get Paid Your Way", desc: "Accept mobile money, cards, and bank transfers with bank-grade security on every transaction.", color: "text-green-400" },
            { icon: Globe, title: "Always On, Everywhere", desc: "Fast and reliable wherever your customers are — orders keep flowing even while you sleep.", color: "text-cyan-400" },
            { icon: BarChart3, title: "Know Your Numbers", desc: "See what's selling, who your best customers are, and where your money goes — in real time.", color: "text-yellow-400" },
          ].map((f) => (
            <Card key={f.title} className="bg-card border-border hover:border-primary/40 transition-colors">
              <CardContent className="p-6 space-y-3">
                <f.icon className={`w-8 h-8 ${f.color}`} />
                <h3 className="font-semibold text-lg">{f.title}</h3>
                <p className="text-sm text-muted-foreground">{f.desc}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      {/* How it works */}
      <section className="px-6 py-16 max-w-5xl mx-auto border-t border-border">
        <h2 className="text-2xl font-bold text-center mb-10">Start Selling in Four Simple Steps</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[
            { icon: MessageSquare, title: "1. Connect WhatsApp", points: ["Link your business number in minutes", "No new app for your customers"], color: "border-cyan-500/40 bg-cyan-500/10 text-cyan-400" },
            { icon: Package, title: "2. Add Your Products", points: ["Upload photos, prices, and stock", "Your catalog updates itself everywhere"], color: "border-orange-500/40 bg-orange-500/10 text-orange-400" },
            { icon: Users, title: "3. Chat & Sell", points: ["Customers browse and order in chat", "Campaigns and broadcasts bring them back"], color: "border-blue-500/40 bg-blue-500/10 text-blue-400" },
            { icon: CreditCard, title: "4. Get Paid & Grow", points: ["Instant payment links in every chat", "Offer trusted customers buy-now-pay-later"], color: "border-yellow-500/40 bg-yellow-500/10 text-yellow-400" },
          ].map((s) => (
            <div key={s.title} className={`rounded-lg border p-4 ${s.color}`}>
              <s.icon className="w-6 h-6 mb-2" />
              <div className="font-bold text-lg mb-3">{s.title}</div>
              <ul className="space-y-1">
                {s.points.map((p) => (
                  <li key={p} className="text-xs opacity-80">{p}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>

      {/* Final CTA */}
      <section className="px-6 py-20 max-w-5xl mx-auto text-center border-t border-border">
        <Wallet className="w-10 h-10 mx-auto mb-4 text-primary" />
        <h2 className="text-3xl font-bold mb-4">Ready to grow your business on WhatsApp?</h2>
        <p className="text-muted-foreground max-w-xl mx-auto mb-8">
          Join merchants already selling, collecting payments, and building loyal customers — all through the app their customers use every day.
        </p>
        <Button size="lg" onClick={handleCta} className="bg-primary text-primary-foreground hover:bg-primary/90 gap-2">
          {isAuthenticated ? "Go to Dashboard" : "Get Started"} <ArrowRight className="w-4 h-4" />
        </Button>
      </section>
    </div>
  );
}
