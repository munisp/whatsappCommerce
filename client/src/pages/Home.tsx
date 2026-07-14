import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { startLogin } from "@/const";
import { Bot, Building2, MessageSquare, ShoppingCart, Zap, ArrowRight, Globe, Shield, BarChart3 } from "lucide-react";
import { useEffect } from "react";
import { useLocation } from "wouter";

export default function Home() {
  const { isAuthenticated, loading } = useAuth();
  const [, navigate] = useLocation();

  useEffect(() => {
    if (!loading && isAuthenticated) {
      navigate("/dashboard");
    }
  }, [loading, isAuthenticated, navigate]);

  if (!loading && isAuthenticated) return null;

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
        <Button onClick={() => startLogin()} className="bg-primary text-primary-foreground hover:bg-primary/90">
          Sign In
        </Button>
      </nav>

      {/* Hero */}
      <section className="px-6 py-24 max-w-5xl mx-auto text-center">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-primary/30 bg-primary/10 text-primary text-xs font-medium mb-8">
          <Zap className="w-3 h-3" />
          Next-Generation WhatsApp Commerce Platform
        </div>
        <h1 className="text-5xl md:text-6xl font-bold leading-tight mb-6">
          Sell Smarter on{" "}
          <span className="text-primary">WhatsApp</span>
        </h1>
        <p className="text-xl text-muted-foreground max-w-2xl mx-auto mb-10">
          Multi-tenant, AI-native commerce platform built on Go, Rust, Python, and TypeScript.
          LangGraph agents, Mojaloop payments, TigerBeetle ledger, and real-time Kubernetes orchestration.
        </p>
        <div className="flex items-center justify-center gap-4 flex-wrap">
          <Button size="lg" onClick={() => startLogin()} className="bg-primary text-primary-foreground hover:bg-primary/90 gap-2">
            Launch Console <ArrowRight className="w-4 h-4" />
          </Button>
        </div>
      </section>

      {/* Features */}
      <section className="px-6 py-16 max-w-5xl mx-auto">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {[
            { icon: Bot, title: "AI Agent Layer", desc: "LangGraph orchestrator with NLU, guardrails, tool registry, and conversation memory. Built in Python.", color: "text-primary" },
            { icon: ShoppingCart, title: "Commerce Engine", desc: "Catalog, cart, checkout, orders, and inventory — all in Go with sub-10ms response times.", color: "text-blue-400" },
            { icon: Building2, title: "Multi-Tenant", desc: "Isolated tenant namespaces with per-tenant AI models, currency, and WhatsApp Business accounts.", color: "text-purple-400" },
            { icon: Shield, title: "Payment Orchestration", desc: "Mojaloop, Stripe, Paystack, and Flutterwave with TigerBeetle two-phase ledger accounting in Rust.", color: "text-green-400" },
            { icon: Globe, title: "Kubernetes-Native", desc: "Full K8s manifests with HPA, PodDisruptionBudgets, NetworkPolicies, and Istio service mesh.", color: "text-cyan-400" },
            { icon: BarChart3, title: "Real-Time Analytics", desc: "Conversation funnels, revenue dashboards, agent performance metrics, and escalation tracking.", color: "text-yellow-400" },
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

      {/* Architecture Stack */}
      <section className="px-6 py-16 max-w-5xl mx-auto border-t border-border">
        <h2 className="text-2xl font-bold text-center mb-10">Technology Stack</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[
            { lang: "Go", services: ["API Gateway", "Webhook Ingestor", "Conversation Orchestrator", "Commerce Engine", "Payment Orchestrator"], color: "border-cyan-500/40 bg-cyan-500/10 text-cyan-400" },
            { lang: "Rust", services: ["Event Processor", "Ledger Bridge", "Recon Worker"], color: "border-orange-500/40 bg-orange-500/10 text-orange-400" },
            { lang: "Python", services: ["AI Agent (LangGraph)", "NLU Pipeline", "Guardrails", "Tool Registry"], color: "border-blue-500/40 bg-blue-500/10 text-blue-400" },
            { lang: "TypeScript", services: ["Admin Dashboard", "tRPC API", "React 19 UI", "Drizzle ORM"], color: "border-yellow-500/40 bg-yellow-500/10 text-yellow-400" },
          ].map((s) => (
            <div key={s.lang} className={`rounded-lg border p-4 ${s.color}`}>
              <div className="font-bold text-lg mb-3">{s.lang}</div>
              <ul className="space-y-1">
                {s.services.map((svc) => (
                  <li key={svc} className="text-xs opacity-80">{svc}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
