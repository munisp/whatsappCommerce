/**
 * ValidationChecklist — pass/fail panel shown while the session is in the
 * validating / live / failed states. Renders each check with an icon, a
 * muted pass-rate summary, and (on failure) the repair guidance lines
 * extracted from the transcript.
 */
import React from "react";
import { CheckCircle2, XCircle } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { checklistSummary, type ValidationCheck } from "@/lib/copilotLogic";

export function ValidationChecklist({
  checks,
  guidance,
}: {
  checks: ValidationCheck[];
  /** Repair guidance lines from the transcript (failed sessions only). */
  guidance?: string[];
}) {
  const summary = checklistSummary(checks);
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Validation</CardTitle>
        <CardDescription>
          {summary.total === 0
            ? "Waiting for the validation run to report checks…"
            : `${summary.passed}/${summary.total} checks passed (${summary.passRate}%)`}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {summary.total > 0 && <Progress value={summary.passRate} className="h-1.5" />}
        {summary.total === 0 ? (
          <p className="text-sm text-muted-foreground italic">No checks reported yet.</p>
        ) : (
          <ul className="space-y-1.5 text-sm">
            {checks.map((c, i) => (
              <li key={`${c.name}-${i}`} className="flex items-start gap-2">
                {c.ok ? (
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
                ) : (
                  <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
                )}
                <div>
                  <span>{c.name}</span>
                  {c.detail && <p className="text-xs text-muted-foreground">{c.detail}</p>}
                </div>
              </li>
            ))}
          </ul>
        )}
        {summary.failed > 0 && guidance && guidance.length > 0 && (
          <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 space-y-1">
            <p className="text-xs font-medium text-amber-400">Repair guidance</p>
            {guidance.map((g, i) => (
              <p key={i} className="text-xs text-muted-foreground">{g}</p>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
