/**
 * onboardingCopilot/tools.ts — the copilot's fixed tool registry.
 *
 * The agent loop (agent.ts) offers these tools to the LLM; the deterministic
 * fallback path calls the same handlers directly. ALL mutating tools
 * (applyProposal / pushProfile / goLive) enforce the CHECKPOINT INVARIANT in
 * this service layer — never in the prompt: a proposal must be 'approved'
 * (or 'edited', carrying the caller-supplied payload) before it is applied.
 */
import { z } from "zod";
import { eq } from "drizzle-orm";
import type { Tool } from "../../_core/llm";
import { getDb } from "../../db";
import { tenants } from "../../../drizzle/schema";
import {
  parseWaMenuConfig,
  waUseCaseSchema,
  WA_USE_CASE_IDS,
  DEFAULT_WA_MENU,
  type WaMenuConfig,
  type WaUseCaseId,
} from "../../../shared/waMenu";
import { brandingConfigSchema, INTEGRATION_PROVIDERS } from "../../../shared/tenantConfig";
import {
  createTenant,
  getOnboardingState,
  runTenantValidation,
  setOnboardingStatus,
  updateTenantSettings,
  validationFailureReasons,
  type ValidationReport,
} from "../onboarding";
import { generateBrandKit, pushWhatsappProfile } from "../brandStudio";
import { writeAuditLog } from "../../routers/audit";
import {
  addProposal,
  assertProposalApproved,
  findProposal,
  type CopilotReply,
  type IntakeFacts,
  type OnboardingSession,
  type Proposal,
  type ProposalKind,
} from "./session";
import { sessionLanguage, t } from "./language";

// ─── Zod payloads ────────────────────────────────────────────────────────────

export const intakeFactsSchema = z.object({
  businessName: z.string().trim().min(1).max(120).optional(),
  industry: z.string().trim().min(1).max(80).optional(),
  city: z.string().trim().min(1).max(80).optional(),
  delivery: z.string().trim().min(1).max(200).optional(),
  paymentPrefs: z.array(z.string().trim().min(1).max(40)).max(10).optional(),
  useCaseHints: z.array(z.string().trim().min(1).max(40)).max(10).optional(),
});

const rankedUseCasesSchema = z.object({
  ranked: z.array(z.enum(WA_USE_CASE_IDS)).min(1).max(WA_USE_CASE_IDS.length),
  summary: z.string().max(300).optional(),
});

const integrationSuggestionsSchema = z.object({
  providers: z
    .array(
      z.object({
        provider: z.enum(INTEGRATION_PROVIDERS),
        reason: z.string().max(300),
      }),
    )
    .min(1)
    .max(3),
  summary: z.string().max(300).optional(),
});

// ─── Audit helper ────────────────────────────────────────────────────────────

async function auditCopilot(
  session: OnboardingSession,
  action: string,
  summary: string,
  after?: unknown,
): Promise<void> {
  await writeAuditLog({
    actorId: `copilot:${session.id}`,
    actorRole: "system",
    action,
    entityType: "onboarding_session",
    entityId: session.id,
    tenantId: session.tenantId ?? undefined,
    summary,
    after: after === undefined ? undefined : (after as Record<string, unknown>),
  });
}

export async function auditStateTransition(
  session: OnboardingSession,
  from: string,
  to: string,
): Promise<void> {
  await auditCopilot(session, "onboarding_copilot.state", `state ${from} → ${to}`, {
    from,
    to,
  });
}

// ─── Pure template builders (LLM-down fallbacks, never dead-end) ─────────────

const USE_CASE_LABELS: Record<WaUseCaseId, string> = Object.fromEntries(
  DEFAULT_WA_MENU.useCases.map((u) => [u.id, u.label]),
) as Record<WaUseCaseId, string>;

/** Rank waMenu use cases from intake hints/industry keywords. */
export function buildRankedUseCases(facts: IntakeFacts): WaUseCaseId[] {
  const haystack = [facts.industry, ...(facts.useCaseHints ?? [])]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const score: Record<WaUseCaseId, number> = {
    shop: 1,
    track: 1,
    support: 0,
    booking: 0,
    handoff: 0,
    procurement: 0,
  };
  if (/restaurant|food|cafe|bakery|meal/.test(haystack)) score.shop += 2;
  if (/shop|store|retail|fashion|boutique|sell|product|market/.test(haystack)) score.shop += 2;
  if (/deliver|logistic|courier|dispatch/.test(haystack)) score.track += 2;
  if (/appoint|book|salon|clinic|consult|service/.test(haystack)) score.booking += 2;
  if (/wholesale|b2b|restock|suppl|procure/.test(haystack)) score.procurement += 3;
  if (/support|help|complain/.test(haystack)) score.support += 2;
  return (WA_USE_CASE_IDS as readonly WaUseCaseId[])
    .slice()
    .sort((a, b) => score[b] - score[a] || WA_USE_CASE_IDS.indexOf(a) - WA_USE_CASE_IDS.indexOf(b));
}

/** Full waMenu contract JSON from facts (template fallback / LLM-free path). */
export function buildTemplateWaMenu(facts: IntakeFacts): WaMenuConfig {
  const ranked = buildRankedUseCases(facts);
  const enableCount = Math.min(3, ranked.length);
  return parseWaMenuConfig({
    greeting: `Welcome to {businessName}! How can we help you today?`,
    useCases: ranked.map((id, i) => ({
      id,
      label: USE_CASE_LABELS[id],
      enabled: i < enableCount,
      order: i + 1,
    })),
    customItems: [],
    fallback: "nlp",
  });
}

/** Integration suggestions from facts — propose only, NEVER credentials. */
export function buildIntegrationSuggestions(
  facts: IntakeFacts,
): { provider: (typeof INTEGRATION_PROVIDERS)[number]; reason: string }[] {
  const haystack = [facts.industry, ...(facts.useCaseHints ?? [])].filter(Boolean).join(" ").toLowerCase();
  const out: { provider: (typeof INTEGRATION_PROVIDERS)[number]; reason: string }[] = [];
  if (/store|retail|shop|fashion|product|catalog|e-?commerce/.test(haystack)) {
    out.push({ provider: "medusa", reason: "Product catalog + inventory sync for your storefront" });
  }
  if (/wholesale|b2b|suppl|restock|inventory|warehouse/.test(haystack)) {
    out.push({ provider: "odoo", reason: "Stock + purchase management for restocking" });
  }
  if (/crm|customer|follow.?up|lead|client/.test(haystack) || out.length === 0) {
    out.push({ provider: "twenty", reason: "CRM to track customer conversations and follow-ups" });
  }
  return out.slice(0, 3);
}

// ─── LLM tool schemas (fixed registry) ───────────────────────────────────────

export const COPILOT_TOOL_SCHEMAS: Tool[] = [
  {
    type: "function",
    function: {
      name: "extractIntake",
      description:
        "Store structured business facts extracted from the user's message (name, industry, city, delivery, payment preferences, use-case hints).",
      parameters: {
        type: "object",
        properties: {
          businessName: { type: "string" },
          industry: { type: "string" },
          city: { type: "string" },
          delivery: { type: "string" },
          paymentPrefs: { type: "array", items: { type: "string" } },
          useCaseHints: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "proposeWaMenu",
      description:
        "Propose a full WhatsApp menu config (greeting/useCases/customItems/fallback) matching the waMenu contract. Creates a pending proposal for human approval.",
      parameters: {
        type: "object",
        properties: {
          menu: { type: "object" },
          summary: { type: "string" },
        },
        required: ["menu"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "proposeUseCases",
      description: "Propose a ranked list of WhatsApp use cases for this business. Creates a pending proposal.",
      parameters: {
        type: "object",
        properties: {
          ranked: { type: "array", items: { type: "string", enum: [...WA_USE_CASE_IDS] } },
          summary: { type: "string" },
        },
        required: ["ranked"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "proposeBranding",
      description: "Generate a brand kit (logo, colors, tagline) via the brand studio and propose it for approval.",
      parameters: {
        type: "object",
        properties: {
          vibe: { type: "string" },
          summary: { type: "string" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "proposeIntegrations",
      description:
        "Suggest backend integrations (medusa/odoo/twenty) for this business. Propose-only: never collects or stores credentials.",
      parameters: {
        type: "object",
        properties: {
          providers: {
            type: "array",
            items: {
              type: "object",
              properties: {
                provider: { type: "string", enum: [...INTEGRATION_PROVIDERS] },
                reason: { type: "string" },
              },
              required: ["provider", "reason"],
            },
          },
          summary: { type: "string" },
        },
        required: ["providers"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "applyProposal",
      description:
        "Apply a proposal to the tenant configuration. REFUSES unless the proposal is approved (checkpoint).",
      parameters: {
        type: "object",
        properties: { proposalId: { type: "string" } },
        required: ["proposalId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "pushProfile",
      description:
        "Push the approved branding to the WhatsApp business profile. REFUSES unless the branding proposal is approved (checkpoint).",
      parameters: {
        type: "object",
        properties: { proposalId: { type: "string" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "runValidation",
      description: "Run the live onboarding validation checks (WhatsApp Graph + enabled integrations).",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "goLive",
      description: "Advance the tenant to live. REFUSES unless validation has passed (checkpoint).",
      parameters: { type: "object", properties: {} },
    },
  },
];

// ─── Tenant provisioning helper ──────────────────────────────────────────────

/** Create the tenant lazily on first apply (session.tenantId is null until then). */
async function ensureTenant(session: OnboardingSession): Promise<string> {
  if (session.tenantId) return session.tenantId;
  const facts = session.intake.facts;
  const { tenantId } = await createTenant({
    name: facts.businessName?.trim() || "New Business",
    businessType: facts.industry,
  });
  session.tenantId = tenantId;
  await auditCopilot(session, "onboarding_copilot.tenant_created", `tenant ${tenantId} provisioned`, {
    tenantId,
    businessName: facts.businessName ?? null,
  });
  return tenantId;
}

// ─── Tool handlers ───────────────────────────────────────────────────────────

export interface ToolResult {
  ok: boolean;
  /** Machine-readable result fed back to the LLM as the tool message. */
  result: unknown;
  /** User-facing replies (cards/text) produced by the tool, if any. */
  replies?: CopilotReply[];
}

function proposalCard(p: Proposal, lang?: string): CopilotReply {
  return {
    type: "card",
    text: `${p.summary}\n\n${JSON.stringify(p.payload, null, 2)}`,
    actions: [
      { id: `approve:${p.id}`, label: t(lang, "actionApprove") },
      { id: `edit:${p.id}`, label: t(lang, "actionEdit") },
      { id: `reject:${p.id}`, label: t(lang, "actionReject") },
    ],
  };
}

const handlers: Record<
  string,
  (args: Record<string, unknown>, session: OnboardingSession) => Promise<ToolResult>
> = {
  async extractIntake(args, session) {
    const parsed = intakeFactsSchema.safeParse(args);
    if (!parsed.success) {
      return { ok: false, result: { error: "invalid facts", issues: parsed.error.issues } };
    }
    session.intake.facts = { ...session.intake.facts, ...parsed.data };
    await auditCopilot(session, "onboarding_copilot.tool", "tool extractIntake", parsed.data);
    return { ok: true, result: { facts: session.intake.facts } };
  },

  async proposeWaMenu(args, session) {
    const parsed = parseWaMenuConfigSafe(args.menu);
    if (!parsed.ok) {
      // Feed the zod error back to the LLM for regeneration — never persist
      // an invalid menu proposal.
      return { ok: false, result: { error: "waMenu failed contract validation", issues: parsed.issues } };
    }
    const p = addProposal(session, {
      kind: "waMenu",
      summary:
        (typeof args.summary === "string" && args.summary) ||
        `WhatsApp menu: ${parsed.menu.useCases.filter((u) => u.enabled).length} options enabled`,
      payload: parsed.menu,
    });
    await auditCopilot(session, "onboarding_copilot.tool", "tool proposeWaMenu", { proposalId: p.id });
    return { ok: true, result: { proposalId: p.id }, replies: [proposalCard(p, sessionLanguage(session))] };
  },

  async proposeUseCases(args, session) {
    const parsed = rankedUseCasesSchema.safeParse(args);
    if (!parsed.success) {
      return { ok: false, result: { error: "invalid ranked use cases", issues: parsed.error.issues } };
    }
    const p = addProposal(session, {
      kind: "useCases",
      summary: parsed.data.summary || `Suggested use cases: ${parsed.data.ranked.slice(0, 3).join(", ")}`,
      payload: { ranked: parsed.data.ranked },
    });
    await auditCopilot(session, "onboarding_copilot.tool", "tool proposeUseCases", { proposalId: p.id });
    return { ok: true, result: { proposalId: p.id }, replies: [proposalCard(p, sessionLanguage(session))] };
  },

  async proposeBranding(args, session) {
    const facts = session.intake.facts;
    if (!facts.businessName) {
      return { ok: false, result: { error: "businessName required before branding — run extractIntake first" } };
    }
    const kit = await generateBrandKit({
      tenantId: session.tenantId ?? undefined,
      businessName: facts.businessName,
      industry: facts.industry,
      vibe: typeof args.vibe === "string" ? args.vibe : undefined,
    });
    const p = addProposal(session, {
      kind: "branding",
      summary:
        (typeof args.summary === "string" && args.summary) ||
        `Brand kit: ${kit.primaryColor} / ${kit.secondaryColor} — “${kit.tagline}”`,
      payload: kit,
    });
    await auditCopilot(session, "onboarding_copilot.tool", "tool proposeBranding", { proposalId: p.id });
    return { ok: true, result: { proposalId: p.id }, replies: [proposalCard(p, sessionLanguage(session))] };
  },

  async proposeIntegrations(args, session) {
    const parsed = integrationSuggestionsSchema.safeParse(args);
    if (!parsed.success) {
      return { ok: false, result: { error: "invalid integration suggestions", issues: parsed.error.issues } };
    }
    const p = addProposal(session, {
      kind: "integrations",
      summary:
        parsed.data.summary ||
        `Suggested integrations: ${parsed.data.providers.map((x) => x.provider).join(", ")}`,
      payload: parsed.data,
    });
    await auditCopilot(session, "onboarding_copilot.tool", "tool proposeIntegrations", {
      proposalId: p.id,
    });
    return { ok: true, result: { proposalId: p.id }, replies: [proposalCard(p, sessionLanguage(session))] };
  },

  async applyProposal(args, session) {
    const proposalId = String(args.proposalId ?? "");
    // CHECKPOINT — throws unless approved/edited.
    const proposal = assertProposalApproved(findProposal(session, proposalId), proposalId);
    const tenantId = await ensureTenant(session);
    await applyProposalPayload(session, tenantId, proposal);
    await auditCopilot(session, "onboarding_copilot.apply", `applied proposal ${proposal.id}`, {
      proposalId: proposal.id,
      kind: proposal.kind,
      status: proposal.status,
    });
    return {
      ok: true,
      result: { applied: proposal.id, kind: proposal.kind, tenantId },
      replies: [
        {
          type: "text",
          text: t(sessionLanguage(session), "appliedSummary", { summary: proposal.summary }),
        },
      ],
    };
  },

  async pushProfile(args, session) {
    // Find the referenced (or latest approved) branding proposal — checkpoint.
    let proposal: Proposal | null = null;
    if (typeof args.proposalId === "string" && args.proposalId) {
      proposal = assertProposalApproved(findProposal(session, args.proposalId), args.proposalId);
    } else {
      proposal =
        [...session.proposals]
          .reverse()
          .find((p) => p.kind === "branding" && (p.status === "approved" || p.status === "edited")) ?? null;
      if (!proposal) {
        throw new Error("No approved branding proposal — approve one before pushing the WhatsApp profile");
      }
    }
    const tenantId = session.tenantId;
    if (!tenantId) {
      // Profile push needs a tenant — apply the branding proposal first.
      return { ok: false, result: { error: "apply the branding proposal before pushProfile" } };
    }
    const kit = proposal.payload as {
      tagline?: string;
      waProfileAbout?: string;
      logoSvgDataUri?: string;
    };
    const res = await pushWhatsappProfile({
      tenantId,
      about: kit.waProfileAbout ?? kit.tagline,
      description: kit.tagline,
      logoDataUri: kit.logoSvgDataUri,
    });
    await auditCopilot(session, "onboarding_copilot.tool", "tool pushProfile", res);
    return {
      ok: res.ok,
      result: res,
      replies: [
        {
          type: "text",
          text: res.ok
            ? t(sessionLanguage(session), "pushOk", { pushed: res.pushed.join(", ") || "nothing to push" })
            : t(sessionLanguage(session), "pushFail", { failed: res.failed.join(", ") || "unknown error" }),
        },
      ],
    };
  },

  async runValidation(_args, session) {
    if (!session.tenantId) {
      return { ok: false, result: { error: "no tenant yet — apply a proposal first" } };
    }
    const db = await getDb();
    if (!db) throw new Error("Database unavailable");
    const [tenant] = await db
      .select({
        id: tenants.id,
        whatsappPhoneNumberId: tenants.whatsappPhoneNumberId,
        whatsappBusinessAccountId: tenants.whatsappBusinessAccountId,
        settings: tenants.settings,
      })
      .from(tenants)
      .where(eq(tenants.id, session.tenantId))
      .limit(1);
    if (!tenant) return { ok: false, result: { error: `tenant ${session.tenantId} not found` } };

    await setOnboardingStatus(session.tenantId, "validating");
    const report: ValidationReport = await runTenantValidation(tenant);
    if (report.passed) {
      await setOnboardingStatus(session.tenantId, "validating", {
        validationPassed: true,
        validatedAt: new Date().toISOString(),
        reasons: [],
      });
    } else {
      await setOnboardingStatus(session.tenantId, "failed", {
        reasons: validationFailureReasons(report),
        validationPassed: false,
      });
    }
    await auditCopilot(session, "onboarding_copilot.tool", "tool runValidation", {
      passed: report.passed,
      checks: report.checks,
    });
    return { ok: report.passed, result: report };
  },

  async goLive(_args, session) {
    if (!session.tenantId) {
      return { ok: false, result: { error: "no tenant yet — apply a proposal first" } };
    }
    const db = await getDb();
    if (!db) throw new Error("Database unavailable");
    const [tenant] = await db
      .select({ id: tenants.id, settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, session.tenantId))
      .limit(1);
    if (!tenant) return { ok: false, result: { error: `tenant ${session.tenantId} not found` } };
    const state = getOnboardingState(tenant.settings);
    if (state.status === "live") {
      return { ok: true, result: { alreadyLive: true } };
    }
    // CHECKPOINT — go-live requires passed validation.
    if (state.status !== "validating" || !state.validationPassed) {
      throw new Error(
        `Cannot go live: validation has not passed (status=${state.status}). Run runValidation first.`,
      );
    }
    await setOnboardingStatus(session.tenantId, "live");
    await db
      .update(tenants)
      .set({ status: "active", updatedAt: new Date() })
      .where(eq(tenants.id, session.tenantId));
    await auditCopilot(session, "onboarding_copilot.go_live", `tenant ${session.tenantId} is live`);
    return { ok: true, result: { live: true } };
  },
};

// ─── Apply-by-kind (post-checkpoint) ─────────────────────────────────────────

async function applyProposalPayload(
  session: OnboardingSession,
  tenantId: string,
  proposal: Proposal,
): Promise<void> {
  const kind: ProposalKind = proposal.kind;
  if (kind === "waMenu") {
    const menu = parseWaMenuConfig(proposal.payload); // re-validate at write time
    await updateTenantSettings(tenantId, (s) => {
      s.waMenu = menu;
    });
    await markStepCompleted(tenantId, "useCases");
    return;
  }
  if (kind === "useCases") {
    const payload = proposal.payload as { ranked?: WaUseCaseId[]; useCases?: unknown };
    await updateTenantSettings(tenantId, (s) => {
      const base = s.waMenu ?? (JSON.parse(JSON.stringify(DEFAULT_WA_MENU)) as WaMenuConfig);
      if (Array.isArray(payload.useCases)) {
        base.useCases = z.array(waUseCaseSchema).parse(payload.useCases);
      } else if (Array.isArray(payload.ranked)) {
        const enableCount = Math.min(3, payload.ranked.length);
        base.useCases = payload.ranked.map((id, i) => ({
          id,
          label: USE_CASE_LABELS[id],
          enabled: i < enableCount,
          order: i + 1,
        }));
      }
      s.waMenu = parseWaMenuConfig(base);
    });
    await markStepCompleted(tenantId, "useCases");
    return;
  }
  if (kind === "branding") {
    const kit = proposal.payload as {
      logoUrl?: string | null;
      primaryColor?: string;
      secondaryColor?: string;
      tagline?: string;
    };
    const core = brandingConfigSchema.parse({
      name: session.intake.facts.businessName ?? "New Business",
      logoUrl: kit.logoUrl ?? null,
      primaryColor: kit.primaryColor,
    });
    await updateTenantSettings(tenantId, (s) => {
      // Core fields validated by brandingConfigSchema; brand-studio extras
      // (secondaryColor/tagline/waProfileAbout, w9 C2) are additive optionals.
      const extras: Record<string, unknown> = {};
      if (kit.secondaryColor) extras.secondaryColor = kit.secondaryColor;
      if (kit.tagline) extras.tagline = kit.tagline;
      if (kit.tagline) extras.waProfileAbout = kit.tagline.slice(0, 139);
      s.branding = { ...s.branding, ...core, ...extras } as typeof s.branding;
    });
    await markStepCompleted(tenantId, "branding");
    return;
  }
  // integrations — propose-only: record the plan, never write credentials.
  const payload = proposal.payload as { providers?: { provider: string; reason: string }[] };
  session.intake.integrationsPlanned = payload.providers ?? [];
}

async function markStepCompleted(tenantId: string, step: "whatsapp" | "useCases" | "integrations" | "branding") {
  const db = await getDb();
  if (!db) return;
  const [tenant] = await db
    .select({ settings: tenants.settings })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  if (!tenant) return;
  const state = getOnboardingState(tenant.settings);
  if (state.status === "live") return;
  const completedSteps = Array.from(new Set([...state.completedSteps, step]));
  await setOnboardingStatus(tenantId, "configuring", { completedSteps, validationPassed: false });
}

// ─── Dispatcher ──────────────────────────────────────────────────────────────

export const COPILOT_TOOL_NAMES = Object.keys(handlers);

/**
 * Execute one tool call against the session (in-memory; caller persists).
 * Checkpoint violations THROW — callers convert them to user-facing refusals.
 */
export async function executeCopilotTool(
  name: string,
  args: Record<string, unknown>,
  session: OnboardingSession,
): Promise<ToolResult> {
  const handler = handlers[name];
  if (!handler) throw new Error(`Unknown copilot tool "${name}"`);
  return handler(args, session);
}

function parseWaMenuConfigSafe(input: unknown):
  | { ok: true; menu: WaMenuConfig }
  | { ok: false; issues: unknown } {
  try {
    return { ok: true, menu: parseWaMenuConfig(input) };
  } catch (e: any) {
    return { ok: false, issues: e?.issues ?? String(e?.message ?? e) };
  }
}
