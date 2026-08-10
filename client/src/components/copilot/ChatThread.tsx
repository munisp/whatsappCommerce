/**
 * ChatThread — the copilot conversation: user bubbles right, agent bubbles
 * left, system messages as centered muted lines. Shows a typing indicator
 * while a postMessage mutation is in flight and auto-scrolls to the newest
 * message. Proposal cards are rendered in-thread via renderProposal when a
 * message references a proposalId.
 */
import React from "react";
import { useEffect, useRef } from "react";
import { Bot, Loader2, User } from "lucide-react";
import type { ChatMessage } from "@/lib/copilotLogic";

export function ChatThread({
  messages,
  typing,
  renderProposal,
}: {
  messages: ChatMessage[];
  /** True while postMessage is in flight → typing indicator bubble. */
  typing: boolean;
  /** Optional in-thread renderer for proposal cards referenced by messages. */
  renderProposal?: (proposalId: string) => React.ReactNode;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const count = messages.length + (typing ? 1 : 0);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [count]);

  if (messages.length === 0 && !typing) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
        No messages yet — say hello to start the onboarding interview.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {messages.map((m) => {
        if (m.role === "system") {
          return (
            <div key={m.key} className="text-center text-xs text-muted-foreground italic px-8">
              {m.text}
            </div>
          );
        }
        const isUser = m.role === "user";
        return (
          <div key={m.key} className={`flex items-start gap-2 ${isUser ? "flex-row-reverse" : ""}`}>
            <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border bg-muted/40">
              {isUser ? <User className="h-3.5 w-3.5 text-muted-foreground" /> : <Bot className="h-3.5 w-3.5 text-muted-foreground" />}
            </div>
            <div className={`max-w-[75%] space-y-2 ${isUser ? "text-right" : ""}`}>
              <div
                className={`inline-block rounded-lg border px-3 py-2 text-sm whitespace-pre-wrap text-left ${
                  isUser ? "bg-accent/60" : "bg-card"
                }`}
              >
                {m.text}
              </div>
              {m.proposalId && renderProposal?.(m.proposalId)}
            </div>
          </div>
        );
      })}
      {typing && (
        <div className="flex items-start gap-2">
          <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border bg-muted/40">
            <Bot className="h-3.5 w-3.5 text-muted-foreground" />
          </div>
          <div className="inline-flex items-center gap-2 rounded-lg border bg-card px-3 py-2 text-sm text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Copilot is thinking…
          </div>
        </div>
      )}
      <div ref={bottomRef} />
    </div>
  );
}
