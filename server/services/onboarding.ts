/**
 * server/services/onboarding.ts — tenant provisioning + onboarding pipeline.
 *
 * createTenant(draft) inserts a tenant row and seeds the full settings
 * skeleton (commerce / branding / crm / inventory / integrations / waMenu —
 * see shared/tenantConfig.ts and shared/waMenu.ts).
 *
 * Onboarding state machine (persisted at tenants.settings.onboarding):
 *   draft → configuring → validating → live
 *                                  ↘ failed (with reasons)
 */
import { randomUUID } from "crypto";
import { eq, sql } from "drizzle-orm";
import { getDb } from "../db";
import { tenants } from "../../drizzle/schema";
import {
  buildDefaultTenantSettings,
  INTEGRATION_PROVIDERS,
  type IntegrationCreds,
  type IntegrationProvider,
  type TenantSettings,
} from "../../shared/tenantConfig";
import { decryptSecret } from "./crypto/secrets";

export const ONBOARDING_STATUSES = ["draft", "configuring", "validating", "live", "failed"] as const;
export type OnboardingStatus = (typeof ONBOARDING_STATUSES)[number];

// === W47 merchant === ONB-M-14: "payout" joins the provisioning checklist.
export const ONBOARDING_STEPS = ["whatsapp", "useCases", "integrations", "branding", "payout"] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export interface CreateTenantDraft {
  name: string;
  slug?: string;
  plan?: "starter" | "growth" | "enterprise";
  businessType?: string;
}

export interface OnboardingState {
  status: OnboardingStatus;
  reasons: string[];
  completedSteps: OnboardingStep[];
  validationPassed: boolean;
  validatedAt: string | null;
}

export interface ValidationCheckResult {
  check: string;
  ok: boolean;
  detail?: string;
}

export interface ValidationReport {
  passed: boolean;
  checks: ValidationCheckResult[];
}

const GRAPH_BASE = "https://graph.facebook.com/v21.0";

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return base || "tenant";
}

// ─── Provisioning ────────────────────────────────────────────────────────────

/**
 * Provision a new tenant end-to-end: row + seeded settings skeleton +
 * onboarding state 'draft'. Returns the new tenant id.
 */
export async function createTenant(
  draft: CreateTenantDraft,
  dbOverride?: any, // W47 crosscutting (ONB-SM-3): caller-scoped transaction
): Promise<{ tenantId: string; slug: string; settings: TenantSettings }> {
  const db = dbOverride ?? (await getDb());
  if (!db) throw new Error("Database unavailable");

  const tenantId = randomUUID();
  let slug = draft.slug?.trim() || slugify(draft.name);

  // Ensure slug uniqueness by suffixing when taken.
  const [existing] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.slug, slug))
    .limit(1);
  if (existing) slug = `${slug}-${tenantId.slice(0, 8)}`;

  const settings = buildDefaultTenantSettings(draft.name);

  // === W47 merchant === ONB-M-10: the slug check-then-insert above still
  // races (two concurrent same-name signups both pass the SELECT). Catch
  // the unique-violation and retry once with a deterministic suffix instead
  // of leaking a raw 23505 to the caller.
  try {
    await db.insert(tenants).values({
      id: tenantId,
      name: draft.name,
      slug,
      plan: draft.plan ?? "starter",
      status: "trial",
      settings: settings as unknown as Record<string, unknown>,
    });
  } catch (e: any) {
    const code = e?.code ?? e?.cause?.code;
    if (code !== "23505") throw e;
    slug = `${slug}-${tenantId.slice(0, 8)}`.slice(0, 100);
    await db.insert(tenants).values({
      id: tenantId,
      name: draft.name,
      slug,
      plan: draft.plan ?? "starter",
      status: "trial",
      settings: settings as unknown as Record<string, unknown>,
    });
  }
  // === END W47 merchant ===

  return { tenantId, slug, settings };
}

// === W47 crosscutting (ONB-SM-3): orphan-tenant sweep =====================
/**
 * Tenants created but never given a member (crash between insert and
 * membership, abandoned copilot sessions) are unreachable clutter. Marks
 * trial tenants older than `olderThanDays` (default 7) with NO
 * tenant_memberships and NO onboarding session as status 'archived' and
 * audit-logs each. Returns the archived tenant ids. Never deletes — the
 * audit trail and any attached data stay inspectable.
 */
export async function sweepOrphanedTrialTenants(olderThanDays = 7): Promise<string[]> {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const cutoff = new Date(Date.now() - olderThanDays * 86_400_000);
  const rows = (await db.execute(sql`
    SELECT t.id FROM tenants t
    WHERE t.status = 'trial' AND t."createdAt" < ${cutoff}
      AND NOT EXISTS (SELECT 1 FROM tenant_memberships m WHERE m."tenantId" = t.id)
      AND NOT EXISTS (SELECT 1 FROM onboarding_sessions s WHERE s.tenant_id = t.id)
    LIMIT 200`)) as unknown as any[];
  const list = (Array.isArray(rows) ? rows : (rows as any).rows ?? []).map((r: any) => String(r.id));
  const { writeAuditLog } = await import("../routers/audit");
  for (const id of list) {
    await db.execute(sql`UPDATE tenants SET status = 'churned', "updatedAt" = now() WHERE id = ${id} AND status = 'trial'`);
    await writeAuditLog({
      actorId: "system:orphan-sweep",
      actorRole: "system",
      action: "onboarding.orphan_tenant_swept",
      entityType: "tenant",
      entityId: id,
      tenantId: id,
      summary: `orphaned trial tenant ${id} (no memberships, no onboarding session) marked churned by sweep`,
    }).catch(() => {});
  }
  return list;
}
// === END W47 crosscutting ===

// ─── State machine helpers ───────────────────────────────────────────────────

export function getOnboardingState(settings: unknown): OnboardingState {
  const s = (settings ?? {}) as TenantSettings;
  const ob: NonNullable<TenantSettings["onboarding"]> = s.onboarding ?? { status: "draft" };
  return {
    status: (ONBOARDING_STATUSES as readonly string[]).includes(ob.status as string)
      ? (ob.status as OnboardingStatus)
      : "draft",
    reasons: Array.isArray(ob.reasons) ? (ob.reasons as string[]) : [],
    completedSteps: Array.isArray(ob.completedSteps)
      ? (ob.completedSteps as OnboardingStep[]).filter((x) =>
          (ONBOARDING_STEPS as readonly string[]).includes(x as string),
        )
      : [],
    validationPassed: ob.validationPassed === true,
    validatedAt: typeof ob.validatedAt === "string" ? ob.validatedAt : null,
  };
}

export async function updateTenantSettings(
  tenantId: string,
  mutate: (settings: TenantSettings) => void,
): Promise<TenantSettings> {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const [tenant] = await db
    .select({ settings: tenants.settings })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  if (!tenant) throw new Error(`Tenant ${tenantId} not found`);
  const settings = JSON.parse(
    JSON.stringify(tenant.settings ?? buildDefaultTenantSettings("")),
  ) as TenantSettings;
  mutate(settings);
  await db
    .update(tenants)
    .set({ settings: settings as unknown as Record<string, unknown>, updatedAt: new Date() })
    .where(eq(tenants.id, tenantId));
  return settings;
}

export async function setOnboardingStatus(
  tenantId: string,
  status: OnboardingStatus,
  patch?: Partial<Omit<OnboardingState, "status">>,
): Promise<OnboardingState> {
  const settings = await updateTenantSettings(tenantId, (s) => {
    const current = getOnboardingState(s);
    s.onboarding = {
      ...(s.onboarding ?? {}),
      status,
      reasons: patch?.reasons ?? (status === "failed" ? current.reasons : []),
      completedSteps: patch?.completedSteps ?? current.completedSteps,
      validationPassed: patch?.validationPassed ?? (status === "live" ? true : current.validationPassed),
      validatedAt: patch?.validatedAt !== undefined ? patch.validatedAt : current.validatedAt,
    };
  });
  return getOnboardingState(settings);
}

// ─── Live validation (WhatsApp Graph + integrations) ────────────────────────

type FetchFn = typeof fetch;

/** LIVE check: Graph API GET /{phoneNumberId} with the tenant access token. */
export async function checkWhatsAppCredentials(
  phoneNumberId: string | null | undefined,
  accessToken: string | null | undefined,
  fetchFn: FetchFn = fetch,
): Promise<ValidationCheckResult> {
  const check = "whatsapp";
  if (!phoneNumberId || !accessToken) {
    return { check, ok: false, detail: "missing phoneNumberId or accessToken" };
  }
  try {
    const res = await fetchFn(`${GRAPH_BASE}/${encodeURIComponent(phoneNumberId)}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (res.status === 200) return { check, ok: true };
    const body = await res.text().catch(() => "");
    return { check, ok: false, detail: `Graph API returned ${res.status}: ${body.slice(0, 200)}` };
  } catch (e: any) {
    return { check, ok: false, detail: `Graph API request failed: ${e?.message ?? e}` };
  }
}

/** Optional WABA reachability check (template management prerequisite). */
export async function checkWabaAccess(
  wabaId: string,
  accessToken: string | null | undefined,
  fetchFn: FetchFn = fetch,
): Promise<ValidationCheckResult> {
  const check = "whatsapp:waba";
  if (!accessToken) return { check, ok: false, detail: "missing accessToken for WABA check" };
  try {
    const res = await fetchFn(`${GRAPH_BASE}/${encodeURIComponent(wabaId)}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (res.status === 200) return { check, ok: true };
    const body = await res.text().catch(() => "");
    return { check, ok: false, detail: `Graph API returned ${res.status}: ${body.slice(0, 200)}` };
  } catch (e: any) {
    return { check, ok: false, detail: `Graph API request failed: ${e?.message ?? e}` };
  }
}

// === W47 merchant === ONB-M-15
/** LIVE check: Telegram Bot API getMe with the tenant bot token. */
export async function checkTelegramBotToken(
  botToken: string,
  fetchFn: FetchFn = fetch,
): Promise<ValidationCheckResult> {
  const check = "telegram";
  if (!botToken) return { check, ok: false, detail: "missing botToken" };
  try {
    const res = await fetchFn(`https://api.telegram.org/bot${encodeURIComponent(botToken)}/getMe`, {
      method: "GET",
    });
    if (res.status === 200) return { check, ok: true };
    const body = await res.text().catch(() => "");
    return { check, ok: false, detail: `Telegram getMe returned ${res.status}: ${body.slice(0, 200)}` };
  } catch (e: any) {
    return { check, ok: false, detail: `Telegram getMe request failed: ${e?.message ?? e}` };
  }
}
// === END W47 merchant ===

/** Test-connection call for one enabled integration provider. */
export async function checkIntegrationConnection(
  provider: IntegrationProvider,
  creds: IntegrationCreds,
  fetchFn: FetchFn = fetch,
): Promise<ValidationCheckResult> {
  const check = `integration:${provider}`;
  const base = creds.url.replace(/\/+$/, "");
  try {
    let res: Response;
    if (provider === "medusa") {
      res = await fetchFn(`${base}/admin/products?limit=1`, {
        method: "GET",
        headers: { Authorization: `Bearer ${creds.apiKey}` },
      });
    } else if (provider === "twenty") {
      res = await fetchFn(`${base}/graphql`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${creds.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query: "{ __schema { queryType { name } } }" }),
      });
    } else {
      // odoo — JSON-RPC common/version (no session needed to reach the server)
      res = await fetchFn(`${base}/jsonrpc`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "call",
          params: { service: "common", method: "version", args: [] },
          id: 1,
        }),
      });
    }
    if (res.status >= 200 && res.status < 300) return { check, ok: true };
    const body = await res.text().catch(() => "");
    return { check, ok: false, detail: `${provider} returned ${res.status}: ${body.slice(0, 200)}` };
  } catch (e: any) {
    return { check, ok: false, detail: `${provider} request failed: ${e?.message ?? e}` };
  }
}

/**
 * Run all live validation checks for a tenant: WhatsApp Graph credentials
 * plus a test-connection per *enabled* integration.
 */
export async function runTenantValidation(
  tenant: { id: string; whatsappPhoneNumberId: string | null; settings: unknown },
  fetchFn: FetchFn = fetch,
): Promise<ValidationReport> {
  const settings = (tenant.settings ?? {}) as TenantSettings;
  const checks: ValidationCheckResult[] = [];

  // settings.whatsapp.accessToken is stored encrypted (v1:) since w10 —
  // decryptSecret passes legacy plaintext through unchanged.
  const waAccessToken = settings.whatsapp?.accessToken
    ? decryptSecret(settings.whatsapp.accessToken)
    : null;

  checks.push(
    await checkWhatsAppCredentials(
      tenant.whatsappPhoneNumberId,
      waAccessToken,
      fetchFn,
    ),
  );

  // Optional: when a WABA id is configured (settings.whatsapp.wabaId or the
  // tenants.whatsappBusinessAccountId column), verify the token can read it —
  // template management (waTemplates) depends on this.
  const wabaId =
    (tenant as { whatsappBusinessAccountId?: string | null }).whatsappBusinessAccountId ??
    (settings as any)?.whatsapp?.wabaId ??
    null;
  if (wabaId) {
    checks.push(await checkWabaAccess(wabaId, waAccessToken, fetchFn));
  }

  // === W47 merchant === ONB-M-15: when a Telegram bot is configured for
  // the tenant, validate its reachability too (getMe) — onboarding was
  // previously WhatsApp-only and a dead Telegram bot token went live
  // silently. (Merchant-facing onboarding remains WhatsApp-first by design;
  // this closes the validation gap for tenants that ALSO run Telegram.)
  const tg = (settings as any)?.telegram ?? {};
  if (tg.enabled === true && typeof tg.botToken === "string" && tg.botToken) {
    checks.push(await checkTelegramBotToken(decryptSecret(tg.botToken), fetchFn));
  }
  // === END W47 merchant ===

  const integrations = settings.integrations ?? {};
  for (const provider of INTEGRATION_PROVIDERS) {
    const creds = integrations[provider];
    if (creds?.enabled) {
      // apiKey is stored encrypted (v1:) since w10 — decrypt for the live probe.
      const decrypted = {
        ...creds,
        ...(creds.apiKey ? { apiKey: decryptSecret(creds.apiKey) } : {}),
      };
      checks.push(await checkIntegrationConnection(provider, decrypted, fetchFn));
    }
  }

  return { passed: checks.every((c) => c.ok), checks };
}

export function validationFailureReasons(report: ValidationReport): string[] {
  return report.checks.filter((c) => !c.ok).map((c) => `${c.check}: ${c.detail ?? "failed"}`);
}
