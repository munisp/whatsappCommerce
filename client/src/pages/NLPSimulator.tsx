import { useState, useRef, useEffect } from "react";
import { Send, Bot, User, Globe, RefreshCw, ShoppingCart, Wifi, WifiOff, Signal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";

const DEMO_TENANTS = [
  { id: "tenant-001", name: "Lagos Fresh Market" },
  { id: "tenant-002", name: "Abuja Electronics Hub" },
];

const LANGUAGE_STARTERS: Record<string, string[]> = {
  english: ["Hi, what do you sell?", "I want to buy something", "Show me your products"],
  yoruba: ["Ẹ jẹ ki n mọ ohun tí ẹ n ta", "Mo fẹ ra nkan", "Kini owo rẹ?"],
  hausa: ["Ina son saya wani abu", "Kuna da menene?", "Nawa ne farashin?"],
  igbo: ["Achọrọ m ịzụta ihe", "Gwa m ihe ị na-ere", "Ego ole?"],
  pidgin: ["Abeg wetin you dey sell?", "I wan buy something sharp sharp", "How much e cost?"],
};

interface Message {
  role: "user" | "bot";
  content: string;
  intent?: string;
  language?: string;
  timestamp: Date;
  confidence?: number;
}

export default function NLPSimulator() {
  const [tenantId, setTenantId] = useState(DEMO_TENANTS[0].id);
  const [phone, setPhone] = useState("+2348012345678");
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [networkQuality, setNetworkQuality] = useState<"good" | "2g" | "offline">("good");
  const [dataLiteMode, setDataLiteMode] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const processMessage = trpc.nlp.processMessage.useMutation();
  const resetSession = trpc.nlp.resetSession.useMutation();
  const { data: session } = trpc.nlp.getSession.useQuery({ tenantId, waPhoneNumber: phone });

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const sendMessage = async (text?: string) => {
    const msg = text ?? input.trim();
    if (!msg) return;
    if (networkQuality === "offline") {
      toast.error("No connection — message queued for retry when signal restores.");
      setMessages(prev => [...prev, { role: "user", content: msg + " ⏳", timestamp: new Date() }]);
      return;
    }
    setInput("");
    setIsLoading(true);

    setMessages(prev => [...prev, { role: "user", content: msg, timestamp: new Date() }]);

    try {
      if (networkQuality === "2g") {
        await new Promise(r => setTimeout(r, 2200 + Math.random() * 1800));
      }
      const result = await processMessage.mutateAsync({
        tenantId,
        waPhoneNumber: phone,
        message: msg,
        customerName: "Demo Buyer",
      });
      setMessages(prev => [...prev, {
        role: "bot",
        content: result.reply,
        intent: result.intent,
        language: result.language,
        timestamp: new Date(),
        confidence: result.confidence,
      }]);
    } catch (e: any) {
      toast.error(e.message ?? "Failed to process message");
    } finally {
      setIsLoading(false);
    }
  };

  const handleReset = async () => {
    if (session?.id) {
      await resetSession.mutateAsync({ sessionId: session.id });
    }
    setMessages([]);
    toast.success("Session reset");
  };

  const detectedLang = session?.language ?? "english";
  const starters = LANGUAGE_STARTERS[detectedLang] ?? LANGUAGE_STARTERS.english;

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">NLP Conversation Simulator</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Test the multilingual buyer flow — type freely in English, Yoruba, Hausa, Igbo, or Pidgin
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={handleReset}>
          <RefreshCw className="h-4 w-4 mr-2" /> Reset Session
        </Button>
      </div>

      {/* Config */}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="text-sm font-medium mb-1 block">Tenant</label>
          <Select value={tenantId} onValueChange={setTenantId}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {DEMO_TENANTS.map(t => (
                <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <label className="text-sm font-medium mb-1 block">Buyer Phone</label>
          <Input value={phone} onChange={e => setPhone(e.target.value)} placeholder="+234..." />
        </div>
      </div>

      {/* Network quality + data-lite controls */}
      <div className="flex items-center gap-3 flex-wrap">
        <span className="text-xs font-medium text-muted-foreground">Network:</span>
        {(["good", "2g", "offline"] as const).map(q => {
          const cfg = {
            good: { label: "4G", icon: <Wifi className="w-3 h-3" />, cls: "border-emerald-500/40 text-emerald-400 bg-emerald-500/10" },
            "2g": { label: "2G (slow)", icon: <Signal className="w-3 h-3" />, cls: "border-amber-500/40 text-amber-400 bg-amber-500/10" },
            offline: { label: "Offline", icon: <WifiOff className="w-3 h-3" />, cls: "border-red-500/40 text-red-400 bg-red-500/10" },
          }[q];
          return (
            <button
              key={q}
              onClick={() => setNetworkQuality(q)}
              className={`flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full border transition-colors ${networkQuality === q ? cfg.cls : "border-border text-muted-foreground hover:bg-accent"}`}
            >
              {cfg.icon}{cfg.label}
            </button>
          );
        })}
        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Data-Lite</span>
          <button
            onClick={() => setDataLiteMode(v => !v)}
            className={`relative w-9 h-5 rounded-full transition-colors ${dataLiteMode ? "bg-emerald-600" : "bg-zinc-700"}`}
          >
            <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${dataLiteMode ? "translate-x-4" : ""}`} />
          </button>
        </div>
      </div>
      {dataLiteMode && (
        <div className="flex items-start gap-2 bg-blue-500/10 border border-blue-500/20 rounded-lg px-3 py-2">
          <Signal className="w-3.5 h-3.5 text-blue-400 mt-0.5 shrink-0" />
          <p className="text-xs text-blue-300">
            <strong>Data-Lite ON:</strong> Replies compressed to plain text — no rich cards, no images, no emoji. Optimised for feature phones and EDGE connections.
          </p>
        </div>
      )}
      {networkQuality === "offline" && (
        <div className="flex items-center gap-2 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
          <WifiOff className="w-3.5 h-3.5 text-red-400 shrink-0" />
          <p className="text-xs text-red-300">
            <strong>Offline simulation active.</strong> Messages queued with ⏳. WhatsApp queues messages for up to 30 days in production.
          </p>
        </div>
      )}
      {networkQuality === "2g" && (
        <div className="flex items-center gap-2 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2">
          <Signal className="w-3.5 h-3.5 text-amber-400 shrink-0" />
          <p className="text-xs text-amber-300">
            <strong>2G simulation:</strong> 2–4 second latency per message to replicate rural network conditions.
          </p>
        </div>
      )}

      {/* Session info */}
      {session && (
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <Globe className="h-4 w-4" />
          <span>Detected language: <Badge variant="secondary">{session.language}</Badge></span>
          <span>State: <Badge variant="outline">{session.state}</Badge></span>
          {session.cartSessionId && (
            <span className="flex items-center gap-1"><ShoppingCart className="h-3 w-3" /> Cart active</span>
          )}
        </div>
      )}

      {/* Quick starters */}
      <div className="flex flex-wrap gap-2">
        <span className="text-xs text-muted-foreground self-center">Try:</span>
        {starters.map(s => (
          <button
            key={s}
            onClick={() => sendMessage(s)}
            className="text-xs px-3 py-1 rounded-full border border-border hover:bg-accent transition-colors"
          >
            {s}
          </button>
        ))}
      </div>

      {/* Chat window */}
      <div className="grid grid-cols-3 gap-4">
      <div className="col-span-2">
      <Card className="h-[420px] flex flex-col">
        <CardHeader className="py-3 px-4 border-b">
          <CardTitle className="text-sm flex items-center gap-2">
            <div className="h-2 w-2 rounded-full bg-green-500 animate-pulse" />
            WhatsApp Simulation
          </CardTitle>
        </CardHeader>
        <CardContent className="flex-1 overflow-y-auto p-4 space-y-3">
          {messages.length === 0 && (
            <div className="text-center text-muted-foreground text-sm mt-12">
              Send a message to start the conversation
            </div>
          )}
          {messages.map((msg, i) => (
            <div key={i} className={`flex gap-2 ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
              {msg.role === "bot" && (
                <div className="h-7 w-7 rounded-full bg-green-600 flex items-center justify-center flex-shrink-0">
                  <Bot className="h-4 w-4 text-white" />
                </div>
              )}
              <div className={`max-w-[75%] rounded-2xl px-4 py-2 text-sm ${
                msg.role === "user"
                  ? "bg-primary text-primary-foreground rounded-br-sm"
                  : "bg-muted rounded-bl-sm"
              }`}>
                <p>{msg.content}</p>
                {msg.intent && msg.role === "bot" && (
                  <p className="text-xs opacity-60 mt-1">intent: {msg.intent}</p>
                )}
              </div>
              {msg.role === "user" && (
                <div className="h-7 w-7 rounded-full bg-primary flex items-center justify-center flex-shrink-0">
                  <User className="h-4 w-4 text-primary-foreground" />
                </div>
              )}
            </div>
          ))}
          {isLoading && (
            <div className="flex gap-2 justify-start">
              <div className="h-7 w-7 rounded-full bg-green-600 flex items-center justify-center">
                <Bot className="h-4 w-4 text-white" />
              </div>
              <div className="bg-muted rounded-2xl rounded-bl-sm px-4 py-2">
                <div className="flex gap-1">
                  <span className="h-2 w-2 rounded-full bg-muted-foreground animate-bounce" style={{ animationDelay: "0ms" }} />
                  <span className="h-2 w-2 rounded-full bg-muted-foreground animate-bounce" style={{ animationDelay: "150ms" }} />
                  <span className="h-2 w-2 rounded-full bg-muted-foreground animate-bounce" style={{ animationDelay: "300ms" }} />
                </div>
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </CardContent>
        <div className="p-4 border-t flex gap-2">
          <Input
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === "Enter" && !e.shiftKey && sendMessage()}
            placeholder="Type in any language..."
            disabled={isLoading}
          />
          <Button onClick={() => sendMessage()} disabled={isLoading || !input.trim()}>
            <Send className="h-4 w-4" />
          </Button>
        </div>
      </Card>
      </div>

      {/* Confidence Heatmap Panel */}
      <div className="col-span-1">
        <Card className="h-[420px] flex flex-col">
          <CardHeader className="py-3 px-4 border-b">
            <CardTitle className="text-sm">Intent Confidence</CardTitle>
          </CardHeader>
          <CardContent className="flex-1 overflow-y-auto p-3 space-y-2">
            {messages.filter(m => m.role === "bot" && m.intent).length === 0 ? (
              <p className="text-xs text-muted-foreground text-center mt-8">No intents yet</p>
            ) : (
              messages.filter(m => m.role === "bot" && m.intent).slice(-10).map((m, i) => {
                const conf = m.confidence ?? 0;
                const pct = Math.round(conf * 100);
                const color = pct >= 80 ? "bg-green-500" : pct >= 50 ? "bg-amber-500" : "bg-red-500";
                return (
                  <div key={i} className="space-y-1">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-muted-foreground capitalize">{m.intent?.replace(/_/g, " ")}</span>
                      <span className={`font-mono font-semibold ${pct >= 80 ? "text-green-600" : pct >= 50 ? "text-amber-600" : "text-red-600"}`}>{pct}%</span>
                    </div>
                    <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                      <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                );
              })
            )}
          </CardContent>
        </Card>
      </div>
      </div>
    </div>
  );
}
