/**
 * StateBadge — muted outline chip for the copilot session state machine
 * (intake → proposing → approving → configuring → validating → live /
 * failed / abandoned). Purely presentational; mapping lives in copilotLogic.
 */
import React from "react";
import { Badge } from "@/components/ui/badge";
import { copilotStateMeta } from "@/lib/copilotLogic";

export function StateBadge({ state }: { state: string }) {
  const meta = copilotStateMeta(state);
  return (
    <Badge variant="outline" className={`font-normal ${meta.className}`}>
      {meta.label}
    </Badge>
  );
}
