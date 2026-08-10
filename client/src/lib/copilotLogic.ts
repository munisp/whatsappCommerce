/**
 * copilotLogic.ts — PURE logic for the wave-9 onboarding-copilot admin UI.
 * No React, no tRPC, no I/O — every function here is unit-testable in a node
 * environment. Shared by the OnboardingCopilot page, the copilot/*
 * components, and the test suite.
 *
 * Data shapes mirror the backend contract of the wave-9 C1 tRPC router
 * `onboardingCopilot.*` (startSession / postMessage / decideProposal /
 * getSession / listSessions). Everything is normalized defensively: the
 * backend may evolve during the wave, and missing fields must degrade to
 * placeholders instead of crashing the chat UI.
 */

// ─── Contract shapes (mirror backend; adjust on rebase) ─────────────────────

export type CopilotState =
  | "intake"
  | "proposing"
  | "approving"
  | "configuring"
  | "validating"
  | "live"
  | "failed"
  | "abandoned";

/** 'goLive' is the terminal checkpoint proposal emitted when validation passes. */
export type ProposalKind = "waMenu" | "branding" | "useCases" | "integrations" | "goLive";

export const PROPOSAL_KINDS: readonly ProposalKind[] = ["waMenu", "branding", "useCases", "integrations", "goLive"];

export type ProposalStatus = "pending" | "approved" | "rejected" | "edited";

export interface CopilotReplyAction {
  id: string;
  label: string;
}

export interface CopilotReply {
  type: "text" | "card";
  text: string;
  actions?: CopilotReplyAction[];
  /** Backend may reference the proposal a card reply renders. */
  proposalId?: string | null;
}

export interface CopilotProposal {
  id: string;
  kind: ProposalKind | string;
  summary: string;
  payload: unknown;
  status: ProposalStatus | string;
  createdAt?: string | null;
}

export interface TranscriptMessage {
  id?: string;
  role: "user" | "agent" | "system";
  text: string;
  at?: string | null;
  /** Set when the message announced a proposal (renders its card in-thread). */
  proposalId?: string | null;
}

export interface ValidationCheck {
  name: string;
  ok: boolean;
  detail?: string | null;
}

export interface CopilotSessionSummary {
  id: string;
  state: CopilotState | string;
  title?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface CopilotSessionDetail {
  id: string;
  state: CopilotState | string;
  transcript: TranscriptMessage[];
  proposals: CopilotProposal[];
  /** Present once the backend runs validation; otherwise derived. */
  checks?: ValidationCheck[];
}

/** UI-local chat message (optimistic entries merge with server transcript). */
export interface ChatMessage {
  key: string;
  role: "user" | "agent" | "system";
  text: string;
  proposalId?: string | null;
}

// ─── Proposal kinds ──────────────────────────────────────────────────────────

export function proposalKindMeta(kind: string): { label: string; className: string } {
  switch (kind) {
    case "waMenu":
      return { label: "WhatsApp menu", className: "border-emerald-500/40 text-emerald-400" };
    case "branding":
      return { label: "Brand kit", className: "border-violet-500/40 text-violet-400" };
    case "useCases":
      return { label: "Use cases", className: "border-sky-500/40 text-sky-400" };
    case "integrations":
      return { label: "Integrations", className: "border-amber-500/40 text-amber-400" };
    case "goLive":
      return { label: "Go live", className: "border-emerald-500/40 text-emerald-400" };
    default:
      return { label: kind.replace(/_/g, " ") || "Proposal", className: "border-border text-muted-foreground" };
  }
}

/** Group proposals by kind, preserving input order within each group. */
export function groupProposalsByKind(
  proposals: CopilotProposal[],
): Partial<Record<ProposalKind, CopilotProposal[]>> {
  const out: Partial<Record<ProposalKind, CopilotProposal[]>> = {};
  for (const p of proposals ?? []) {
    const kind = PROPOSAL_KINDS.includes(p.kind as ProposalKind) ? (p.kind as ProposalKind) : undefined;
    if (!kind) continue;
    (out[kind] ??= []).push(p);
  }
  return out;
}

/** Pending proposals first (stable), then the rest in original order. */
export function sortProposalsPendingFirst(proposals: CopilotProposal[]): CopilotProposal[] {
  return (proposals ?? [])
    .map((p, i) => ({ p, i }))
    .sort((a, b) => {
      const ap = a.p.status === "pending" ? 0 : 1;
      const bp = b.p.status === "pending" ? 0 : 1;
      return ap - bp || a.i - b.i;
    })
    .map(({ p }) => p);
}

export function proposalStatusMeta(status: string): { label: string; className: string } {
  switch (status) {
    case "pending":
      return { label: "Awaiting decision", className: "border-amber-500/40 text-amber-400" };
    case "approved":
      return { label: "Approved", className: "border-emerald-500/40 text-emerald-400" };
    case "edited":
      return { label: "Approved with edits", className: "border-sky-500/40 text-sky-400" };
    case "rejected":
      return { label: "Rejected", className: "border-red-500/40 text-red-400" };
    default:
      return { label: status.replace(/_/g, " ") || "Unknown", className: "border-border text-muted-foreground" };
  }
}

// ─── Session state → UI ─────────────────────────────────────────────────────

export interface CopilotStateMeta {
  label: string;
  className: string;
  /** True while the backend is working and the UI should poll. */
  active: boolean;
  /** True for terminal states (no resume, no polling). */
  terminal: boolean;
}

export function copilotStateMeta(state: string): CopilotStateMeta {
  switch (state) {
    case "intake":
      return { label: "Intake", className: "border-sky-500/40 text-sky-400", active: true, terminal: false };
    case "proposing":
      return { label: "Drafting proposals", className: "border-sky-500/40 text-sky-400", active: true, terminal: false };
    case "approving":
      return { label: "Awaiting approvals", className: "border-amber-500/40 text-amber-400", active: true, terminal: false };
    case "configuring":
      return { label: "Configuring", className: "border-amber-500/40 text-amber-400", active: true, terminal: false };
    case "validating":
      return { label: "Validating", className: "border-amber-500/40 text-amber-400", active: true, terminal: false };
    case "live":
      return { label: "Live", className: "border-emerald-500/40 text-emerald-400", active: false, terminal: true };
    case "failed":
      return { label: "Failed", className: "border-red-500/40 text-red-400", active: false, terminal: true };
    case "abandoned":
      return { label: "Abandoned", className: "border-border text-muted-foreground", active: false, terminal: true };
    default:
      return { label: state.replace(/_/g, " ") || "Unknown", className: "border-border text-muted-foreground", active: false, terminal: false };
  }
}

// ─── Validation checklist ───────────────────────────────────────────────────

export interface ChecklistSummary {
  total: number;
  passed: number;
  failed: number;
  /** 0–100, integer. 0 when there are no checks. */
  passRate: number;
  allPassed: boolean;
}

export function checklistSummary(checks: ValidationCheck[]): ChecklistSummary {
  const list = checks ?? [];
  const passed = list.filter((c) => c.ok).length;
  const total = list.length;
  const failed = total - passed;
  return {
    total,
    passed,
    failed,
    passRate: total === 0 ? 0 : Math.round((passed / total) * 100),
    allPassed: total > 0 && failed === 0,
  };
}

const CHECK_PASS_RE = /^(?:✅|✓|\[pass(?:ed)?\]|pass(?:ed)?:)\s*(.+)$/i;
const CHECK_FAIL_RE = /^(?:❌|✗|✕|\[fail(?:ed)?\]|fail(?:ed)?:)\s*(.+)$/i;
/** Real backend repair anchor: system line "validation failed (round N): r1 | r2". */
const VALIDATION_FAILED_RE = /^validation failed\b(?:\s*\(round\s*\d+\))?\s*:?\s*(.*)$/i;

function parseCheckLine(text: string): ValidationCheck | null {
  const trimmed = text.trim();
  const pass = CHECK_PASS_RE.exec(trimmed);
  if (pass) return splitCheckDetail(pass[1], true);
  const fail = CHECK_FAIL_RE.exec(trimmed);
  if (fail) return splitCheckDetail(fail[1], false);
  return null;
}

function splitCheckDetail(body: string, ok: boolean): ValidationCheck {
  const [name, ...rest] = body.split(/\s[—–-]\s/);
  return {
    name: name.trim() || (ok ? "Check passed" : "Check failed"),
    ok,
    detail: rest.length ? rest.join(" — ").trim() : null,
  };
}

/**
 * Checks carried by a goLive proposal payload: { checks: [{check, ok, detail?}] }.
 * Newest (last) goLive proposal wins. Returns [] when none.
 */
export function checksFromGoLiveProposal(proposals: CopilotProposal[] | null | undefined): ValidationCheck[] {
  const goLive = [...(proposals ?? [])].reverse().find((p) => p.kind === "goLive");
  const checks = goLive ? asRecord(goLive.payload).checks : undefined;
  if (!Array.isArray(checks)) return [];
  return checks
    .filter((c) => c && typeof c === "object")
    .map((c) => {
      const r = c as Record<string, unknown>;
      return {
        // Backend ValidationCheckResult uses `check`; tolerate `name` too.
        name: String(r.check ?? r.name ?? "Check"),
        ok: Boolean(r.ok),
        detail: r.detail != null ? String(r.detail) : null,
      };
    });
}

/**
 * Validation checks for the checklist panel, in priority order:
 *  1. an explicit `checks` array (forward-compatible),
 *  2. the newest goLive proposal's payload checks (all-pass report),
 *  3. failed checks parsed from "validation failed (round N): …" system lines,
 *  4. ✅/❌-prefixed transcript lines (defensive fallback).
 * Never throws.
 */
export function extractValidationChecks(
  session:
    | { transcript?: TranscriptMessage[]; checks?: ValidationCheck[]; proposals?: CopilotProposal[] }
    | null
    | undefined,
): ValidationCheck[] {
  if (!session) return [];
  if (Array.isArray(session.checks) && session.checks.length > 0) {
    return session.checks.map((c) => ({
      name: String(c?.name ?? "Check"),
      ok: Boolean(c?.ok),
      detail: c?.detail != null ? String(c.detail) : null,
    }));
  }
  const fromProposal = checksFromGoLiveProposal(session.proposals);
  if (fromProposal.length > 0) return fromProposal;
  const out: ValidationCheck[] = [];
  for (const m of session.transcript ?? []) {
    if (m.role === "user") continue;
    const text = String(m.text ?? "");
    const failedMatch = VALIDATION_FAILED_RE.exec(text.trim());
    if (failedMatch && m.role === "system") {
      // "validation failed (round 2): whatsapp:waba: Graph 403 | integration:odoo: timeout"
      for (const reason of (failedMatch[1] ?? "").split("|")) {
        const r = reason.trim();
        if (!r) continue;
        const [check, ...rest] = r.split(": ");
        out.push({
          name: check.trim() || "validation",
          ok: false,
          detail: rest.length ? rest.join(": ").trim() : null,
        });
      }
      continue;
    }
    for (const line of text.split("\n")) {
      const check = parseCheckLine(line);
      if (check) out.push(check);
    }
  }
  return out;
}

/**
 * Repair guidance for a failed validation. Anchors on the LAST failure
 * marker — a system "validation failed (round N): …" line (real backend
 * format) or a ❌-prefixed line — and returns the agent messages that follow
 * it (the backend's targeted repair questions), verbatim.
 */
export function repairGuidance(transcript: TranscriptMessage[]): string[] {
  const msgs = transcript ?? [];
  let anchorIdx = -1;
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.role === "user") continue;
    const text = String(m.text ?? "").trim();
    if (
      (m.role === "system" && VALIDATION_FAILED_RE.test(text)) ||
      text.split("\n").some((l) => CHECK_FAIL_RE.test(l.trim()))
    ) {
      anchorIdx = i; // keep scanning — last failure round wins
    }
  }
  if (anchorIdx === -1) return [];
  const out: string[] = [];
  for (let i = anchorIdx + 1; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.role !== "agent") continue;
    const text = String(m.text ?? "").trim();
    if (text) out.push(text);
  }
  return out;
}

/** Go-live is offered once validation is running/done and every check passed. */
export function canGoLive(state: string, checks: ValidationCheck[]): boolean {
  return state === "validating" && checklistSummary(checks).allPassed;
}

/** The terminal goLive checkpoint proposal awaiting a human decision, if any. */
export function findPendingGoLiveProposal(proposals: CopilotProposal[]): CopilotProposal | null {
  return (proposals ?? []).find((p) => p.kind === "goLive" && p.status === "pending") ?? null;
}

/** Next-step bullets for the success panel once state === "live". */
export function liveNextSteps(): string[] {
  return [
    "Connect your WhatsApp Business number (WhatsApp Profile page)",
    "Invite staff members to the merchant portal",
    "Send a test message to the number and walk the menu as a customer",
    "Review integrations you deferred and configure them in Integration Settings",
  ];
}

// ─── Resume banner ──────────────────────────────────────────────────────────

/**
 * The most recently updated session that is not in a terminal state —
 * offered in the "Resume onboarding" banner. Null when none qualifies.
 */
export function findResumableSession(sessions: CopilotSessionSummary[]): CopilotSessionSummary | null {
  const candidates = (sessions ?? []).filter((s) => !copilotStateMeta(String(s.state)).terminal);
  if (candidates.length === 0) return null;
  const ts = (s: CopilotSessionSummary) => {
    const raw = s.updatedAt ?? s.createdAt ?? "";
    const t = Date.parse(raw);
    return Number.isNaN(t) ? 0 : t;
  };
  return candidates.reduce((best, s) => (ts(s) >= ts(best) ? s : best));
}

// ─── Proposal payload normalizers (defensive) ───────────────────────────────

export interface WaMenuUseCaseChip {
  id: string;
  label: string;
  enabled: boolean;
  order: number;
}

export interface WaMenuCustomItem {
  label: string;
  response: string;
}

export interface WaMenuView {
  greeting: string;
  useCases: WaMenuUseCaseChip[];
  customItems: WaMenuCustomItem[];
  fallback: string;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function asString(v: unknown, fallback: string): string {
  return typeof v === "string" && v.trim() ? v.trim() : fallback;
}

/** Backend WaMenuConfig.fallback is an enum; map it to a human sentence. */
const WA_FALLBACK_LABELS: Record<string, string> = {
  nlp: "Free-form messages are answered by the AI assistant.",
  menu: "Free-form messages show the menu options again.",
};

/** Normalize a waMenu proposal payload (WaMenuConfig); missing fields become placeholders. */
export function normalizeWaMenu(payload: unknown): WaMenuView {
  const p = asRecord(payload);
  const useCases = Array.isArray(p.useCases) ? p.useCases : [];
  const customItems = Array.isArray(p.customItems) ? p.customItems : [];
  const fallbackRaw = asString(p.fallback, "");
  return {
    greeting: asString(p.greeting, "Hello! How can we help you today?"),
    useCases: useCases.map((u, i) => {
      const r = asRecord(u);
      return {
        id: asString(r.id, `use-case-${i + 1}`),
        label: asString(r.label ?? r.name, `Use case ${i + 1}`),
        enabled: r.enabled !== false,
        order: typeof r.order === "number" && Number.isFinite(r.order) ? r.order : i + 1,
      };
    }),
    customItems: customItems.map((c, i) => {
      const r = asRecord(c);
      return {
        label: asString(r.label ?? r.title, `Item ${i + 1}`),
        response: asString(r.response ?? r.text, "No response configured"),
      };
    }),
    fallback:
      WA_FALLBACK_LABELS[fallbackRaw] ??
      (fallbackRaw || "Sorry, I didn't understand that — please pick an option."),
  };
}

export interface BrandKitColor {
  name: string;
  hex: string;
}

export interface BrandKitView {
  brandName: string;
  logoSvgDataUri: string | null;
  tagline: string;
  colors: BrandKitColor[];
}

/**
 * Normalize a branding proposal payload. Real backend shape (brand studio
 * BrandKit): { logoSvgDataUri, logoUrl, primaryColor, secondaryColor,
 * tagline, waProfileAbout? }; colors/palette arrays also tolerated.
 */
export function normalizeBrandKit(payload: unknown): BrandKitView {
  const p = asRecord(payload);
  const colors: BrandKitColor[] = [];
  const pushColor = (name: string, hex: unknown) => {
    const h = asString(hex, "");
    if (/^#[0-9a-fA-F]{6}$/.test(h) && !colors.some((c) => c.hex === h)) {
      colors.push({ name, hex: h });
    }
  };
  pushColor("Primary", p.primaryColor);
  pushColor("Secondary", p.secondaryColor);
  const colorsRaw = Array.isArray(p.colors) ? p.colors : Array.isArray(p.palette) ? p.palette : [];
  colorsRaw.forEach((c, i) => {
    if (typeof c === "string") return pushColor(c, c);
    const r = asRecord(c);
    pushColor(asString(r.name ?? r.role, `Color ${i + 1}`), r.hex);
  });
  const logo = typeof p.logoSvgDataUri === "string" && p.logoSvgDataUri.startsWith("data:image/")
    ? p.logoSvgDataUri
    : null;
  return {
    brandName: asString(p.brandName ?? p.name, "Your brand"),
    logoSvgDataUri: logo,
    tagline: asString(p.tagline ?? p.waProfileAbout, ""),
    colors,
  };
}

export interface UseCaseSuggestion {
  label: string;
  rationale: string;
  rank: number;
}

/** Display labels for backend use-case ids (mirror of shared/waMenu DEFAULT_WA_MENU). */
const WA_USE_CASE_LABELS: Record<string, string> = {
  shop: "Shop products",
  track: "Track my order",
  support: "Get support",
  booking: "Book an appointment",
  handoff: "Talk to a human",
  procurement: "Restock / Buy supplies",
};

/**
 * Normalize a useCases proposal payload into ranked chips. Real backend
 * shape: { ranked: WaUseCaseId[] } (ids only); object entries with labels /
 * rationales also tolerated.
 */
export function normalizeUseCases(payload: unknown): UseCaseSuggestion[] {
  const p = asRecord(payload);
  const list = Array.isArray(p.ranked)
    ? p.ranked
    : Array.isArray(p.useCases)
      ? p.useCases
      : Array.isArray(p.suggestions)
        ? p.suggestions
        : [];
  return list.map((u, i) => {
    if (typeof u === "string") {
      return { label: WA_USE_CASE_LABELS[u] ?? u, rationale: "", rank: i + 1 };
    }
    const r = asRecord(u);
    const id = asString(r.id, "");
    return {
      label: asString(r.label ?? r.name, WA_USE_CASE_LABELS[id] ?? `Use case ${i + 1}`),
      rationale: asString(r.rationale ?? r.reason, ""),
      rank: typeof r.rank === "number" && Number.isFinite(r.rank) ? r.rank : i + 1,
    };
  });
}

export interface IntegrationSuggestion {
  provider: string;
  note: string;
  required: boolean;
}

/** Normalize an integrations proposal payload into a provider checklist. */
export function normalizeIntegrations(payload: unknown): IntegrationSuggestion[] {
  const p = asRecord(payload);
  const list = Array.isArray(p.providers) ? p.providers : Array.isArray(p.integrations) ? p.integrations : [];
  return list.map((it, i) => {
    if (typeof it === "string") {
      return { provider: it, note: "", required: false };
    }
    const r = asRecord(it);
    return {
      provider: asString(r.provider ?? r.name ?? r.id, `Provider ${i + 1}`),
      note: asString(r.note ?? r.reason ?? r.why ?? r.rationale, ""),
      required: r.required === true,
    };
  });
}

// ─── Edit payload assembly ──────────────────────────────────────────────────

/**
 * Build the editedPayload for decideProposal from the admin's edit text.
 *
 * UX decision: the Edit box is pre-filled with the proposal payload as
 * pretty-printed JSON. If the admin's text parses as a JSON object it is
 * shallow-merged over the original payload (admin keys win); otherwise the
 * free text is attached as `adminNote` so the agent can interpret it in
 * natural language. Empty text returns null (no edit to send).
 */
export function assembleEditedPayload(originalPayload: unknown, editText: string): Record<string, unknown> | null {
  const text = (editText ?? "").trim();
  if (!text) return null;
  const base = asRecord(originalPayload);
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { ...base, ...(parsed as Record<string, unknown>) };
    }
    // JSON but not an object (string/number/array) — treat as a note.
    return { ...base, adminNote: text };
  } catch {
    return { ...base, adminNote: text };
  }
}

// ─── Transcript merging ─────────────────────────────────────────────────────

/**
 * Merge optimistic local messages with the server transcript for display.
 * Server messages win by position; optimistic entries not yet echoed are
 * appended. Keyed stably so the auto-scroll can anchor on length changes.
 */
export function mergeTranscript(server: TranscriptMessage[], optimistic: ChatMessage[]): ChatMessage[] {
  const fromServer: ChatMessage[] = (server ?? []).map((m, i) => ({
    key: m.id ?? `srv-${i}`,
    role: m.role === "user" || m.role === "system" ? m.role : "agent",
    text: String(m.text ?? ""),
    proposalId: m.proposalId ?? null,
  }));
  const serverTexts = new Set(fromServer.map((m) => `${m.role}:${m.text}`));
  const extras = (optimistic ?? []).filter((o) => !serverTexts.has(`${o.role}:${o.text}`));
  return [...fromServer, ...extras];
}
