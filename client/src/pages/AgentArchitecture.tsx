import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  ArrowRight,
  Bot,
  Brain,
  Building2,
  Database,
  Globe,
  MessageSquare,
  Package,
  RefreshCw,
  Shield,
  Users,
  Zap,
} from "lucide-react";

// ─── Data ─────────────────────────────────────────────────────────────────────
const integrationFlows = [
  {
    id: "whatsapp",
    icon: MessageSquare,
    color: "text-green-400",
    bg: "bg-green-400/10 border-green-400/20",
    title: "WhatsApp Cloud API",
    subtitle: "Inbound & Outbound",
    steps: [
      {
        step: "1. Webhook Ingest",
        desc: "Meta POSTs incoming messages to APISix Gateway → Go Event Gateway validates HMAC-SHA256 signature and publishes to Kafka topic `wa.messages.inbound`.",
      },
      {
        step: "2. Rust Deduplication",
        desc: "Rust Message Processor consumes the Kafka topic, deduplicates by message ID (Redis SETNX, 5-min TTL), and routes to the Node.js app.",
      },
      {
        step: "3. AI Agent Decision",
        desc: "The Node.js app invokes the Ollama LLM (or built-in Forge LLM) with a system prompt containing tenant context, product catalog, conversation history, and order state.",
      },
      {
        step: "4. Intent Classification",
        desc: "The agent classifies intent: browse_products, place_order, track_order, escalate_to_human, request_support. Each intent triggers a different response path.",
      },
      {
        step: "5. Response & Escalation",
        desc: "Structured response is sent back via WhatsApp Cloud API. If confidence < 0.7 or intent = escalate, the conversation is flagged and a human agent is notified via WebSocket.",
      },
    ],
  },
  {
    id: "crm",
    icon: Users,
    color: "text-blue-400",
    bg: "bg-blue-400/10 border-blue-400/20",
    title: "Twenty CRM",
    subtitle: "Contact & Lead Sync",
    steps: [
      {
        step: "1. Contact Upsert",
        desc: "Every new WhatsApp sender is upserted into Twenty CRM via the Twenty GraphQL API. Phone number is the primary key. Contact record includes first message, channel, and tenant.",
      },
      {
        step: "2. Conversation Linking",
        desc: "Each conversation is linked to a Twenty CRM contact via `twenty_contact_id`. The Agent Console shows the CRM record inline so operators see full customer history.",
      },
      {
        step: "3. Lead Scoring",
        desc: "The AI agent updates a custom `wa_lead_score` field in Twenty based on conversation signals: product views, cart additions, repeat visits, and purchase history.",
      },
      {
        step: "4. Pipeline Automation",
        desc: "When an order is placed, a Twenty CRM opportunity is created and moved to 'Won'. When a conversation is escalated, a Twenty task is created and assigned to the on-call agent.",
      },
      {
        step: "5. Dashboard Sync",
        desc: "The Customers KPI on the Dashboard counts distinct `twenty_contact_id` values from the conversations table, giving a live unique-customer count without a separate CRM query.",
      },
    ],
  },
  {
    id: "odoo",
    icon: Package,
    color: "text-orange-400",
    bg: "bg-orange-400/10 border-orange-400/20",
    title: "Odoo ERP",
    subtitle: "Inventory & Orders",
    steps: [
      {
        step: "1. Stock Sync (Heartbeat)",
        desc: "Every 5 minutes, the Temporal `InventorySyncWorkflow` calls Odoo XML-RPC (`product.product` model, `qty_available` field) and writes diffs to `inventory_snapshots`.",
      },
      {
        step: "2. Oversell Guard",
        desc: "When the AI agent confirms an order, an atomic SQL UPDATE reserves stock: `SET reservedQty = reservedQty + qty WHERE availableQty >= qty`. Zero rows updated = reject order.",
      },
      {
        step: "3. Order Push",
        desc: "Confirmed orders are pushed to Odoo via XML-RPC (`sale.order.create`). Odoo handles fulfilment, shipping, and invoicing. The order ID is stored in `orders.odooOrderId`.",
      },
      {
        step: "4. Low-Stock Alerts",
        desc: "After each sync, products where `availableQty < lowStockThreshold` trigger an owner notification (push alert) and appear in the Dashboard low-stock widget.",
      },
      {
        step: "5. Revenue Reconciliation",
        desc: "The Dashboard Revenue KPI sums `orders.totalAmount` for confirmed orders. Odoo invoices are reconciled nightly via a Temporal workflow that updates `orders.odooInvoiceId`.",
      },
    ],
  },
  {
    id: "dashboard",
    icon: Brain,
    color: "text-purple-400",
    bg: "bg-purple-400/10 border-purple-400/20",
    title: "Dashboard & Analytics",
    subtitle: "Real-time Observability",
    steps: [
      {
        step: "1. KPI Aggregation",
        desc: "Dashboard KPIs are computed by tRPC `analytics.getPlatformOverview` which runs aggregation queries across tenants, orders, conversations, and inventory in a single round-trip.",
      },
      {
        step: "2. Agent Event Tracking",
        desc: "Every AI agent interaction writes to `agent_events` (intent, confidence, latency, model used, escalated). The Dashboard AI Interactions KPI counts these events.",
      },
      {
        step: "3. WebSocket Live Feed",
        desc: "The `/api/ws/conversations` WebSocket broadcasts conversation state changes (new message, escalation, resolution) to all connected Dashboard clients in real time.",
      },
      {
        step: "4. Tenant Metrics",
        desc: "Per-tenant metrics (message volume, order count, revenue, AI interactions) are computed from the same tables, filtered by `tenantId`, and displayed in the Tenant Metrics table.",
      },
      {
        step: "5. Audit Trail",
        desc: "All KYC status changes, template approvals, and billing events are logged to append-only audit tables. The Dashboard Audit Log page surfaces these with full timestamps and actor IDs.",
      },
    ],
  },
];

const middlewareComponents = [
  {
    name: "APISix Gateway",
    lang: "Lua/Go",
    role: "Rate limiting, JWT auth, webhook routing, SSL termination",
    badge: "Go",
    color: "bg-cyan-500/10 text-cyan-400 border-cyan-500/20",
  },
  {
    name: "Go Event Gateway",
    lang: "Go 1.23",
    role: "WhatsApp webhook ingestion, HMAC verification, Kafka fan-out, retry backoff",
    badge: "Go",
    color: "bg-cyan-500/10 text-cyan-400 border-cyan-500/20",
  },
  {
    name: "Rust Message Processor",
    lang: "Rust 1.83",
    role: "High-performance deduplication (DashMap), message routing, DLQ management",
    badge: "Rust",
    color: "bg-orange-500/10 text-orange-400 border-orange-500/20",
  },
  {
    name: "Python KYC Verifier",
    lang: "Python 3.12",
    role: "PaddleOCR document extraction, Docling PDF parsing, VLM analysis, liveness detection",
    badge: "Python",
    color: "bg-yellow-500/10 text-yellow-400 border-yellow-500/20",
  },
  {
    name: "TypeScript Node App",
    lang: "TypeScript 5",
    role: "Business logic, tRPC API, Drizzle ORM, WebSocket, AI agent orchestration",
    badge: "TS",
    color: "bg-blue-500/10 text-blue-400 border-blue-500/20",
  },
  {
    name: "Temporal Workflows",
    lang: "TypeScript SDK",
    role: "Durable workflow orchestration: onboarding, order fulfilment, inventory sync, broadcasts",
    badge: "TS",
    color: "bg-blue-500/10 text-blue-400 border-blue-500/20",
  },
  {
    name: "Kafka Event Bus",
    lang: "JVM",
    role: "7 topics: wa.messages, kyc.events, orders.created, inventory.sync, agent.events, broadcasts",
    badge: "Kafka",
    color: "bg-red-500/10 text-red-400 border-red-500/20",
  },
  {
    name: "Redis Cache",
    lang: "C",
    role: "Session store, rate limiting, liveness session state, dedup cache, pub/sub",
    badge: "Redis",
    color: "bg-red-500/10 text-red-400 border-red-500/20",
  },
  {
    name: "Dapr Sidecar",
    lang: "Go",
    role: "Service mesh abstraction, state management, pub/sub, secret injection",
    badge: "Dapr",
    color: "bg-green-500/10 text-green-400 border-green-500/20",
  },
];

const agentCapabilities = [
  { icon: MessageSquare, title: "Natural Language Understanding", desc: "Processes Arabic, English, French, and 20+ languages via multilingual LLM. Handles typos, slang, and voice-to-text transcriptions." },
  { icon: Package, title: "Product Discovery", desc: "Searches product catalog by name, category, price range, and availability. Returns rich WhatsApp list messages with images and CTAs." },
  { icon: Zap, title: "Order Processing", desc: "Guides customer through cart → address → payment. Validates inventory in real time before confirming. Pushes confirmed orders to Odoo." },
  { icon: RefreshCw, title: "Order Tracking", desc: "Queries Odoo for shipment status and returns real-time tracking info. Sends proactive delivery updates via WhatsApp template messages." },
  { icon: Shield, title: "Fraud Detection", desc: "Flags suspicious patterns: rapid order velocity, mismatched phone/address, known fraud indicators. Escalates to human review queue." },
  { icon: Users, title: "Human Escalation", desc: "Detects frustration, complex queries, and explicit escalation requests. Routes to the next available agent with full conversation context." },
  { icon: Globe, title: "Multi-Tenant Isolation", desc: "Each tenant has a separate system prompt, product catalog, and conversation history. Agent responses are fully scoped to the tenant's brand voice." },
  { icon: Brain, title: "Learning & Feedback", desc: "Agent events (intent, confidence, outcome) are logged to `agent_events`. Low-confidence interactions are reviewed and used to fine-tune prompts." },
];

// ─── Component ────────────────────────────────────────────────────────────────
export default function AgentArchitecture() {
  return (
    <DashboardLayout>
      <div className="p-6 space-y-8 max-w-6xl mx-auto">
        {/* Header */}
        <div>
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 rounded-lg bg-green-500/10 border border-green-500/20">
              <Bot className="h-6 w-6 text-green-400" />
            </div>
            <div>
              <h1 className="text-2xl font-bold">AI Agent Architecture</h1>
              <p className="text-muted-foreground text-sm">How the AI agent integrates with WhatsApp, CRM, Odoo, and the Dashboard</p>
            </div>
          </div>
        </div>

        {/* Architecture Diagram (text-based) */}
        <Card className="border-zinc-800 bg-zinc-900/50">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Database className="h-4 w-4 text-muted-foreground" />
              End-to-End Message Flow
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="font-mono text-xs text-muted-foreground bg-zinc-950 rounded-lg p-4 overflow-x-auto">
              <pre>{`WhatsApp User
      │  (HTTPS POST)
      ▼
┌─────────────────┐   HMAC verify   ┌──────────────────┐   Kafka publish
│  APISix Gateway │ ──────────────▶ │  Go Event Gateway│ ──────────────▶ wa.messages.inbound
│  (rate limit,   │                 │  (webhook ingest, │
│   JWT, routing) │                 │   fan-out, retry) │
└─────────────────┘                 └──────────────────┘
                                                                │
                                                                ▼
                                              ┌──────────────────────────────┐
                                              │  Rust Message Processor      │
                                              │  (dedup, route, DLQ)         │
                                              └──────────────┬───────────────┘
                                                             │
                                                             ▼
                                              ┌──────────────────────────────┐
                                              │  TypeScript Node App         │
                                              │  ┌──────────────────────┐    │
                                              │  │  AI Agent (Ollama /  │    │
                                              │  │  Forge LLM)          │    │
                                              │  │  - Intent classify   │    │
                                              │  │  - Product search    │    │
                                              │  │  - Order processing  │    │
                                              │  │  - Escalation detect │    │
                                              │  └──────────┬───────────┘    │
                                              │             │                 │
                                              │    ┌────────┴────────┐        │
                                              │    ▼                ▼        │
                                              │ Twenty CRM      Odoo ERP    │
                                              │ (contact upsert) (stock,    │
                                              │                  orders)    │
                                              └──────────────────────────────┘
                                                             │
                                                             ▼
                                              ┌──────────────────────────────┐
                                              │  WhatsApp Cloud API          │
                                              │  (send response / template)  │
                                              └──────────────────────────────┘
                                                             │
                                                             ▼
                                                      WhatsApp User`}</pre>
            </div>
          </CardContent>
        </Card>

        {/* Integration Flows */}
        <Tabs defaultValue="whatsapp">
          <TabsList className="grid grid-cols-4 w-full">
            <TabsTrigger value="whatsapp" className="text-xs">WhatsApp</TabsTrigger>
            <TabsTrigger value="crm" className="text-xs">CRM</TabsTrigger>
            <TabsTrigger value="odoo" className="text-xs">Odoo ERP</TabsTrigger>
            <TabsTrigger value="dashboard" className="text-xs">Dashboard</TabsTrigger>
          </TabsList>

          {integrationFlows.map((flow) => (
            <TabsContent key={flow.id} value={flow.id} className="mt-4">
              <Card className={`border ${flow.bg}`}>
                <CardHeader className="pb-3">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <flow.icon className={`h-5 w-5 ${flow.color}`} />
                    {flow.title}
                    <Badge variant="outline" className="ml-auto text-xs">{flow.subtitle}</Badge>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  {flow.steps.map((s, i) => (
                    <div key={i} className="flex gap-3">
                      <div className={`flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${flow.bg} ${flow.color}`}>
                        {i + 1}
                      </div>
                      <div>
                        <p className="text-sm font-semibold mb-0.5">{s.step}</p>
                        <p className="text-xs text-muted-foreground leading-relaxed">{s.desc}</p>
                      </div>
                    </div>
                  ))}
                </CardContent>
              </Card>
            </TabsContent>
          ))}
        </Tabs>

        {/* Agent Capabilities */}
        <div>
          <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
            <Brain className="h-5 w-5 text-purple-400" />
            Agent Capabilities
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
            {agentCapabilities.map((cap) => (
              <Card key={cap.title} className="border-zinc-800 bg-zinc-900/50 hover:bg-zinc-900 transition-colors">
                <CardContent className="p-4">
                  <cap.icon className="h-5 w-5 text-green-400 mb-2" />
                  <p className="text-sm font-semibold mb-1">{cap.title}</p>
                  <p className="text-xs text-muted-foreground leading-relaxed">{cap.desc}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>

        <Separator className="bg-zinc-800" />

        {/* Middleware Components */}
        <div>
          <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
            <Building2 className="h-5 w-5 text-cyan-400" />
            Middleware Components
          </h2>
          <div className="space-y-2">
            {middlewareComponents.map((comp) => (
              <div key={comp.name} className="flex items-start gap-3 p-3 rounded-lg border border-zinc-800 bg-zinc-900/30 hover:bg-zinc-900/60 transition-colors">
                <Badge variant="outline" className={`flex-shrink-0 text-xs font-mono ${comp.color}`}>
                  {comp.badge}
                </Badge>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="text-sm font-semibold">{comp.name}</span>
                    <span className="text-xs text-muted-foreground">({comp.lang})</span>
                  </div>
                  <p className="text-xs text-muted-foreground">{comp.role}</p>
                </div>
                <ArrowRight className="h-4 w-4 text-muted-foreground flex-shrink-0 mt-0.5" />
              </div>
            ))}
          </div>
        </div>

        {/* Deployment Note */}
        <Card className="border-amber-500/20 bg-amber-500/5">
          <CardContent className="p-4 flex gap-3">
            <Zap className="h-5 w-5 text-amber-400 flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-semibold text-amber-400 mb-1">Deployment Note</p>
              <p className="text-xs text-muted-foreground leading-relaxed">
                The Go Event Gateway, Rust Message Processor, and Python KYC Verifier run as separate Docker containers
                (see <code className="bg-zinc-800 px-1 rounded">services/middleware/docker-compose.middleware.yml</code>).
                The Temporal worker and Dapr sidecar are co-deployed alongside the Node.js app.
                The Heartbeat inventory sync job activates automatically after the first Publish — it cannot run
                in the sandbox dev environment because the platform requires a live HTTPS URL to register the schedule.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
