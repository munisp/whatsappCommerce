/**
 * CopilotAskWidget — W22 merchant "Ask" box.
 *
 * Simple question box backed by the tenant-guarded `copilot.ask` mutation.
 * The server answers from tenant-scoped AGGREGATES only (today's sales in
 * integer cents, order count, top products, credit balance); when the LLM
 * provider is disabled the deterministic template answer is returned with
 * fallbackUsed=true. `copilot.ask` is delivered by a parallel wave, so the
 * call goes through a narrowly cast handle (see Compliance.tsx for the same
 * seam) — the runtime contract below is FIXED.
 */
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { trpc } from "@/lib/trpc";
import { Bot } from "lucide-react";

const copilotApi = (trpc as any).copilot;

export type CopilotAskResult = {
  answer: string;
  fallbackUsed: boolean;
  latencyMs: number;
  snapshot: {
    salesCentsToday: number;
    ordersToday: number;
    topProducts: Array<{ name: string; quantity: number }>;
    creditOutstandingCents: number;
    creditLimitCents: number;
  };
};

export function CopilotAskWidget({ tenantId }: { tenantId?: string }) {
  const [question, setQuestion] = useState("");
  const ask = copilotApi.ask.useMutation() as {
    mutate: (v: { tenantId: string; question: string }) => void;
    isPending: boolean;
    isError: boolean;
    data?: CopilotAskResult;
  };

  const submit = () => {
    const q = question.trim();
    if (!tenantId || !q || ask.isPending) return;
    ask.mutate({ tenantId, question: q });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
          <Bot className="h-4 w-4" /> Merchant Copilot — Ask
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex gap-2">
          <input
            className="flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm"
            placeholder="Ask about your sales, top products, credit balance…"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            disabled={!tenantId}
          />
          <Button size="sm" onClick={submit} disabled={!tenantId || !question.trim() || ask.isPending}>
            {ask.isPending ? "Asking…" : "Ask"}
          </Button>
        </div>
        {!tenantId && (
          <p className="text-sm text-muted-foreground">Select a tenant to ask the copilot.</p>
        )}
        {ask.isError && <p className="text-sm text-yellow-400">Copilot unavailable right now.</p>}
        {ask.data && (
          <div className="space-y-2 rounded-md border border-border p-3">
            <div className="flex items-center gap-2">
              <Badge variant="outline">{ask.data.fallbackUsed ? "offline summary" : "AI answer"}</Badge>
              <span className="text-xs text-muted-foreground">{ask.data.latencyMs} ms</span>
            </div>
            <p className="text-sm">{ask.data.answer}</p>
            <p className="text-xs text-muted-foreground">
              Today: {ask.data.snapshot.ordersToday} orders · ₦{(ask.data.snapshot.salesCentsToday / 100).toFixed(2)}
              {ask.data.snapshot.topProducts.length > 0 &&
                ` · Top: ${ask.data.snapshot.topProducts.map((p) => p.name).join(", ")}`}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default CopilotAskWidget;
