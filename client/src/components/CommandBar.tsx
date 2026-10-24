// === W65 conversational ===
/**
 * CommandBar — R7 universal NL command bar (Cmd+K / Ctrl+K), mounted in all
 * 3 app shells (client, ui/tenant-portal, ui/platform-admin).
 *
 * Flow: type natural language → commandBar.parse drafts the real tRPC
 * mutation → drafted action card shows {intent, params, missingFields} →
 * user confirms (filling missing fields inline) → commandBar.execute runs
 * the REAL mutation server-side → result card. Admin-only intents are
 * flagged and gated server-side.
 */
import { useCallback, useEffect, useState } from "react";
import { trpc } from "@/lib/trpc";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Loader2, Lock, Sparkles, Terminal } from "lucide-react";
import { toast } from "sonner";

interface Draft {
  intent: string;
  params: Record<string, unknown>;
  missingFields: string[];
  summary: string;
  adminOnly: boolean;
  confirmToken: string | null;
}

export function CommandBar() {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [extra, setExtra] = useState<Record<string, string>>({});
  const [result, setResult] = useState<string | null>(null);

  const parse = trpc.commandBar.parse.useMutation({
    onSuccess: (d) => {
      setDraft(d as Draft);
      setExtra({});
      setResult(null);
    },
    onError: (e) => toast.error(`Command parse failed: ${e.message}`),
  });
  const execute = trpc.commandBar.execute.useMutation({
    onSuccess: (r) => {
      setResult(JSON.stringify(r.result, null, 2)?.slice(0, 2000) ?? "done");
      toast.success(`Done: ${r.summary}`);
    },
    onError: (e) => {
      setResult(null);
      toast.error(e.message);
    },
  });

  const onKey = useCallback((e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      setOpen((v) => !v);
    }
  }, []);
  useEffect(() => {
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onKey]);

  const submit = () => {
    if (!text.trim() || parse.isPending) return;
    setDraft(null);
    setResult(null);
    parse.mutate({ text: text.trim() });
  };

  const confirm = () => {
    if (!draft?.confirmToken || execute.isPending) return;
    execute.mutate({ confirmToken: draft.confirmToken, params: Object.keys(extra).length ? extra : undefined });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-xl" data-testid="command-bar">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Terminal className="h-4 w-4" /> Command bar
            <Badge variant="secondary" className="text-[10px]">⌘K</Badge>
          </DialogTitle>
          <DialogDescription>
            Type what you want to do — e.g. “create invoice for Musa ₦45,000”, “wallet balance”, “order status SIM-1042”.
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-2">
          <Input
            autoFocus
            placeholder="Type a command…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
          <Button onClick={submit} disabled={parse.isPending || !text.trim()}>
            {parse.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
          </Button>
        </div>

        {draft && (
          <Card data-testid="command-draft-card">
            <CardContent className="pt-4 space-y-3">
              <div className="flex items-center gap-2">
                <Badge>{draft.intent}</Badge>
                {draft.adminOnly && (
                  <Badge variant="destructive" className="flex items-center gap-1">
                    <Lock className="h-3 w-3" /> admin
                  </Badge>
                )}
              </div>
              <p className="text-sm">{draft.summary}</p>
              {draft.missingFields.length > 0 && (
                <div className="space-y-2" data-testid="command-missing-fields">
                  <p className="text-xs text-muted-foreground">Still needed:</p>
                  {draft.missingFields.map((f) => (
                    <Input
                      key={f}
                      placeholder={f}
                      value={extra[f] ?? ""}
                      onChange={(e) => setExtra((x) => ({ ...x, [f]: e.target.value }))}
                    />
                  ))}
                </div>
              )}
              <Button
                className="w-full"
                onClick={confirm}
                disabled={execute.isPending || !draft.confirmToken}
              >
                {execute.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Confirm & run"}
              </Button>
            </CardContent>
          </Card>
        )}

        {result && (
          <Card data-testid="command-result-card">
            <CardContent className="pt-4">
              <pre className="max-h-64 overflow-auto text-xs whitespace-pre-wrap">{result}</pre>
            </CardContent>
          </Card>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default CommandBar;
