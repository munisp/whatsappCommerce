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
import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { tenants } from "../../drizzle/schema";
import {
  buildDefaultTenantSettings,
  INTEGRATION_PROVIDERS,
  type IntegrationCreds,
  type IntegrationProvider,
  type TenantSettings,
} from "../../shared/tenantConfig";

export const ONBOARDING_STATUSES = ["draft", "configuring", "validating", "live", "failed"] as const;
export type OnboardingStatus = (typeof ONBOARDING_STATUSES)[number];

export const ONBOARDING_STEPS = ["whatsapp", "useCases", "integrations", "branding"] as const;
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
): Promise<{ tenantId: string; slug: string; settings: TenantSettings }> {
  const db = await getDb();
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

  await db.insert(tenants).values({
    id: tenantId,
    name: draft.name,
    slug,
    plan: draft.plan ?? "starter",
    status: "trial",
    settings: settings as unknown as Record<string, unknown>,
  });

  return { tenantId, slug, settings };
}

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

  checks.push(
    await checkWhatsAppCredentials(
      tenant.whatsappPhoneNumberId,
      settings.whatsapp?.accessToken ?? null,
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
    checks.push(await checkWabaAccess(wabaId, settings.whatsapp?.accessToken ?? null, fetchFn));
  }

  const integrations = settings.integrations ?? {};
  for (const provider of INTEGRATION_PROVIDERS) {
    const creds = integrations[provider];
    if (creds?.enabled) {
      checks.push(await checkIntegrationConnection(provider, creds, fetchFn));
    }
  }

  return { passed: checks.every((c) => c.ok), checks };
}

export function validationFailureReasons(report: ValidationReport): string[] {
  return report.checks.filter((c) => !c.ok).map((c) => `${c.check}: ${c.detail ?? "failed"}`);
}
