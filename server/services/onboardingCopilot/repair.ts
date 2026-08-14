/**
 * onboardingCopilot/repair.ts — validation-repair loop.
 *
 * After runValidation fails, map each failure reason to a TARGETED follow-up
 * question, append it to the transcript, and move the session back to
 * 'configuring'. After MAX_REPAIR_ROUNDS failed rounds the session is marked
 * 'failed' with the reasons preserved in `error`.
 */
import type { ValidationReport } from "../onboarding";
import { validationFailureReasons } from "../onboarding";
import { writeAuditLog } from "../../routers/audit";
import {
  appendTranscript,
  MAX_REPAIR_ROUNDS,
  type CopilotReply,
  type OnboardingSession,
} from "./session";
import { sessionLanguage, t, type CopilotLanguage } from "./language";

/**
 * Map a validation failure reason ("check: detail") to a targeted question.
 * Wave 15: optional `lang` renders the question in the session language;
 * English (default) is byte-identical to the wave-9 strings.
 */
export function repairQuestionFor(reason: string, lang?: CopilotLanguage): string {
  // Reasons look like "whatsapp:waba: Graph API returned 403…" — the check id
  // is everything before the FIRST ": " (check ids themselves contain colons).
  const check = reason.split(": ")[0]?.trim() ?? "";
  if (check === "whatsapp") {
    return t(lang, "repairWhatsapp");
  }
  if (check === "whatsapp:waba") {
    return t(lang, "repairWaba");
  }
  if (check.startsWith("integration:")) {
    const provider = check.slice("integration:".length);
    return t(lang, "repairIntegration", { provider });
  }
  return t(lang, "repairGeneric", { reason });
}

export interface RepairOutcome {
  /** true when the session was marked permanently 'failed' (cap reached). */
  failed: boolean;
  replies: CopilotReply[];
  reasons: string[];
  round: number;
}

/**
 * Run one repair round for a failed validation report. Mutates the session
 * in-memory (caller persists): appends a system note + targeted agent
 * questions, bumps the repair-round counter, sets state back to
 * 'configuring' — or 'failed' once MAX_REPAIR_ROUNDS is reached.
 */
export async function runRepairRound(
  session: OnboardingSession,
  report: ValidationReport,
): Promise<RepairOutcome> {
  const reasons = validationFailureReasons(report);
  const round = (session.intake.repairRounds ?? 0) + 1;
  session.intake.repairRounds = round;
  session.intake.lastFailureReasons = reasons;

  appendTranscript(session, "system", `validation failed (round ${round}): ${reasons.join(" | ")}`);

  const lang = sessionLanguage(session);
  if (round >= MAX_REPAIR_ROUNDS) {
    session.state = "failed";
    session.error = reasons.join(" | ");
    const text = t(lang, "repairCap", { reasons: reasons.map((r) => `• ${r}`).join(" ") });
    appendTranscript(session, "agent", text);
    await writeAuditLog({
      actorId: `copilot:${session.id}`,
      actorRole: "system",
      action: "onboarding_copilot.repair_exhausted",
      entityType: "onboarding_session",
      entityId: session.id,
      tenantId: session.tenantId ?? undefined,
      summary: `repair cap (${MAX_REPAIR_ROUNDS}) reached — session failed`,
      after: { reasons, round },
    });
    return { failed: true, replies: [{ type: "text", text }], reasons, round };
  }

  session.state = "configuring";
  const replies: CopilotReply[] = reasons.map((r) => {
    const text = repairQuestionFor(r, lang);
    appendTranscript(session, "agent", text);
    return { type: "text" as const, text };
  });
  await writeAuditLog({
    actorId: `copilot:${session.id}`,
    actorRole: "system",
    action: "onboarding_copilot.repair_round",
    entityType: "onboarding_session",
    entityId: session.id,
    tenantId: session.tenantId ?? undefined,
    summary: `repair round ${round}: ${reasons.length} failing check(s)`,
    after: { reasons, round },
  });
  return { failed: false, replies, reasons, round };
}
