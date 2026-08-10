/**
 * ProposalCard — an onboarding-copilot proposal rendered in the chat thread.
 * Dispatches to the kind-specific preview (waMenu / branding / useCases /
 * integrations) and, while status === "pending", offers Approve / Reject /
 * Edit actions.
 *
 * Edit UX: the editor is pre-filled with the payload as pretty-printed JSON.
 * Valid JSON objects are merged over the original payload; anything else is
 * sent as `{ adminNote: text }` (see assembleEditedPayload) so the agent can
 * interpret natural-language edits.
 */
import React from "react";
import { useState } from "react";
import { Check, Loader2, Pencil, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { WaMenuPreview } from "./WaMenuPreview";
import { BrandKitPreview } from "./BrandKitPreview";
import {
  assembleEditedPayload,
  normalizeIntegrations,
  normalizeUseCases,
  proposalKindMeta,
  proposalStatusMeta,
  type CopilotProposal,
} from "@/lib/copilotLogic";

function UseCasesPreview({ payload }: { payload: unknown }) {
  const items = [...normalizeUseCases(payload)].sort((a, b) => a.rank - b.rank);
  if (items.length === 0) return <p className="text-xs text-muted-foreground italic">No use cases proposed yet.</p>;
  return (
    <ul className="space-y-1.5 text-sm">
      {items.map((u) => (
        <li key={`${u.rank}-${u.label}`} className="flex items-start gap-2">
          <Badge variant="outline" className="font-normal border-sky-500/40 text-sky-400 shrink-0">
            #{u.rank}
          </Badge>
          <div>
            <span className="font-medium">{u.label}</span>
            {u.rationale && <p className="text-xs text-muted-foreground">{u.rationale}</p>}
          </div>
        </li>
      ))}
    </ul>
  );
}

function IntegrationsPreview({ payload }: { payload: unknown }) {
  const items = normalizeIntegrations(payload);
  if (items.length === 0) return <p className="text-xs text-muted-foreground italic">No integrations suggested yet.</p>;
  return (
    <div className="space-y-1.5 text-sm">
      <ul className="space-y-1.5">
        {items.map((it) => (
          <li key={it.provider} className="flex items-start gap-2">
            <span className="mt-1 h-2 w-2 shrink-0 rounded-full border border-amber-500/60" />
            <div>
              <span className="font-medium">{it.provider}</span>
              {it.required && (
                <Badge variant="outline" className="ml-1.5 font-normal border-red-500/40 text-red-400">required</Badge>
              )}
              {it.note && <p className="text-xs text-muted-foreground">{it.note}</p>}
            </div>
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground italic">
        These can be configured later in Integration Settings.
      </p>
    </div>
  );
}

export function ProposalPreview({ proposal }: { proposal: CopilotProposal }) {
  switch (proposal.kind) {
    case "waMenu":
      return <WaMenuPreview payload={proposal.payload} />;
    case "branding":
      return <BrandKitPreview payload={proposal.payload} />;
    case "useCases":
      return <UseCasesPreview payload={proposal.payload} />;
    case "integrations":
      return <IntegrationsPreview payload={proposal.payload} />;
    default:
      return (
        <pre className="max-h-48 overflow-auto rounded-md border bg-muted/30 p-2 text-xs">
          {JSON.stringify(proposal.payload ?? {}, null, 2)}
        </pre>
      );
  }
}

export function ProposalCard({
  proposal,
  pending: busy,
  onDecide,
}: {
  proposal: CopilotProposal;
  /** True while a decideProposal mutation is in flight. */
  pending: boolean;
  onDecide: (input: { proposalId: string; approve: boolean; editedPayload?: Record<string, unknown> }) => void;
}) {
  const kind = proposalKindMeta(proposal.kind);
  const status = proposalStatusMeta(proposal.status);
  const isPending = proposal.status === "pending";
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState("");

  const startEdit = () => {
    setEditText(JSON.stringify(proposal.payload ?? {}, null, 2));
    setEditing(true);
  };

  const submitEdit = () => {
    const payload = assembleEditedPayload(proposal.payload, editText);
    if (!payload) return;
    onDecide({ proposalId: proposal.id, approve: true, editedPayload: payload });
    setEditing(false);
  };

  return (
    <Card className="w-full max-w-xl">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Badge variant="outline" className={`font-normal ${kind.className}`}>{kind.label}</Badge>
            <span className="font-normal text-muted-foreground truncate">
              {proposal.summary || "Proposal"}
            </span>
          </CardTitle>
          {!isPending && (
            <Badge variant="outline" className={`font-normal shrink-0 ${status.className}`}>{status.label}</Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <ProposalPreview proposal={proposal} />
        {isPending && !editing && (
          <div className="flex flex-wrap gap-2 pt-1">
            <Button size="sm" disabled={busy} onClick={() => onDecide({ proposalId: proposal.id, approve: true })}>
              {busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Check className="mr-1 h-3.5 w-3.5" />}
              Approve
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={startEdit}>
              <Pencil className="mr-1 h-3.5 w-3.5" />
              Edit
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-muted-foreground"
              disabled={busy}
              onClick={() => onDecide({ proposalId: proposal.id, approve: false })}
            >
              <X className="mr-1 h-3.5 w-3.5" />
              Reject
            </Button>
          </div>
        )}
        {isPending && editing && (
          <div className="space-y-2 pt-1">
            <p className="text-xs text-muted-foreground">
              Edit the JSON below, or replace it with plain-language feedback (sent as an admin note).
            </p>
            <Textarea
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              rows={8}
              className="font-mono text-xs"
            />
            <div className="flex gap-2">
              <Button size="sm" disabled={busy || !editText.trim()} onClick={submitEdit}>
                {busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Check className="mr-1 h-3.5 w-3.5" />}
                Approve with edits
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(false)}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
