/**
 * W16 template pre-approval submissions (roadmap F9).
 *
 * Bridges the curated library (./library) and the existing Meta Graph helpers
 * (../waTemplates): an operator picks (templateKey, language) and we submit
 * it to the tenant's WABA, then track the review decision.
 *
 * State is persisted in tenants.settings.waTemplateLibrary =
 *   { submissions: WaTemplateSubmission[] } — no migrations.
 *
 * Status lifecycle: draft → submitted → approved | rejected
 * (rejection reason captured from Meta's rejected_reason field).
 *
 * Idempotent per (tenant, key, language): re-submitting an already
 * submitted/approved pair returns the existing submission without a Meta
 * call; a draft or rejected pair is (re)submitted.
 */

import { eq, sql } from "drizzle-orm";
import type { getDb } from "../../db";
import { tenants } from "../../../drizzle/schema";
import { createMetaTemplate, fetchMetaTemplates, resolveWabaCredentials } from "../waTemplates";
import {
  getLibraryEntry,
  WA_TEMPLATE_LOCALES,
  type WaTemplateLocale,
} from "./library";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type FetchFn = typeof fetch;

export const WA_SUBMISSION_STATUSES = ["draft", "submitted", "approved", "rejected"] as const;
export type WaSubmissionStatus = (typeof WA_SUBMISSION_STATUSES)[number];

export interface WaTemplateSubmission {
  templateKey: string;
  language: string;
  /** Meta template name submitted to the WABA. */
  name: string;
  category: "UTILITY" | "MARKETING";
  metaTemplateId: string;
  status: WaSubmissionStatus;
  rejectionReason: string | null;
  submittedAt: string;
  updatedAt: string;
}

export interface WaTemplateLibraryState {
  submissions: WaTemplateSubmission[];
}

export function parseSubmissionState(settings: unknown): WaTemplateLibraryState {
  const raw = (settings as any)?.waTemplateLibrary;
  const submissions: WaTemplateSubmission[] = Array.isArray(raw?.submissions)
    ? raw.submissions
        .filter((s: any) => s && typeof s.templateKey === "string" && typeof s.language === "string")
        .map((s: any) => ({
          templateKey: String(s.templateKey),
          language: String(s.language),
          name: String(s.name ?? ""),
          category: s.category === "MARKETING" ? "MARKETING" : "UTILITY",
          metaTemplateId: String(s.metaTemplateId ?? ""),
          status: (WA_SUBMISSION_STATUSES as readonly string[]).includes(s.status)
            ? (s.status as WaSubmissionStatus)
            : "draft",
          rejectionReason: typeof s.rejectionReason === "string" ? s.rejectionReason : null,
          submittedAt: typeof s.submittedAt === "string" ? s.submittedAt : "",
          updatedAt: typeof s.updatedAt === "string" ? s.updatedAt : "",
        }))
    : [];
  return { submissions };
}

function findSubmission(
  state: WaTemplateLibraryState,
  key: string,
  language: string,
): WaTemplateSubmission | undefined {
  return state.submissions.find((s) => s.templateKey === key && s.language === language);
}

async function persistState(db: Db, tenantId: string, state: WaTemplateLibraryState): Promise<void> {
  await db
    .update(tenants)
    .set({
      settings: sql`COALESCE(${tenants.settings}, '{}'::jsonb) || ${JSON.stringify({ waTemplateLibrary: state })}::jsonb`,
      updatedAt: new Date(),
    } as any)
    .where(eq(tenants.id, tenantId));
}

export type SubmitTemplateResult =
  | { ok: true; submission: WaTemplateSubmission; idempotent: boolean }
  | { ok: false; error: "unknown_template" | "unsupported_language" | "meta_api_error"; message: string };

/**
 * Submit a library template to the tenant's WABA for pre-approval.
 * Idempotent: an existing submitted/approved submission for
 * (tenantId, templateKey, language) short-circuits with idempotent=true.
 */
export async function submitTemplate(
  db: Db,
  tenantId: string,
  templateKey: string,
  language: string,
  fetchFn: FetchFn = fetch,
): Promise<SubmitTemplateResult> {
  const entry = getLibraryEntry(templateKey);
  if (!entry) {
    return { ok: false, error: "unknown_template", message: `No library template with key "${templateKey}"` };
  }
  if (!(WA_TEMPLATE_LOCALES as readonly string[]).includes(language)) {
    return { ok: false, error: "unsupported_language", message: `Language "${language}" is not in the library` };
  }

  const [tenant] = await db
    .select({ settings: tenants.settings })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1)
    .catch(() => []);
  if (!tenant) {
    return { ok: false, error: "meta_api_error", message: "Tenant not found" };
  }
  const state = parseSubmissionState(tenant.settings);
  const existing = findSubmission(state, templateKey, language);
  if (existing && (existing.status === "submitted" || existing.status === "approved")) {
    return { ok: true, submission: existing, idempotent: true };
  }

  let created: { id: string; status: string };
  try {
    created = await createMetaTemplate(
      db,
      tenantId,
      {
        name: entry.name,
        category: entry.category,
        language,
        body: entry.bodies[language as WaTemplateLocale],
      },
      fetchFn,
    );
  } catch (err: any) {
    return { ok: false, error: "meta_api_error", message: String(err?.message ?? err).slice(0, 300) };
  }

  const now = new Date().toISOString();
  const submission: WaTemplateSubmission = {
    templateKey,
    language,
    name: entry.name,
    category: entry.category,
    metaTemplateId: created.id,
    status: "submitted",
    rejectionReason: null,
    submittedAt: now,
    updatedAt: now,
  };
  state.submissions = state.submissions.filter(
    (s) => !(s.templateKey === templateKey && s.language === language),
  );
  state.submissions.push(submission);
  await persistState(db, tenantId, state);
  return { ok: true, submission, idempotent: false };
}

export interface SyncTemplateStatusResult {
  updated: number;
  submissions: WaTemplateSubmission[];
}

/**
 * Poll Meta for review decisions and advance tracked submissions:
 * PENDING stays submitted, APPROVED → approved, REJECTED → rejected (reason
 * captured). Unknown remote templates are ignored; missing remote rows keep
 * their local status.
 */
export async function syncTemplateStatuses(
  db: Db,
  tenantId: string,
  fetchFn: FetchFn = fetch,
): Promise<SyncTemplateStatusResult> {
  const [tenant] = await db
    .select({ settings: tenants.settings })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1)
    .catch(() => []);
  if (!tenant) throw new Error("Tenant not found");
  const state = parseSubmissionState(tenant.settings);

  const creds = await resolveWabaCredentials(db, tenantId);
  if (!creds) {
    throw new Error("WhatsApp Business Account (wabaId) or access token not configured for tenant");
  }
  const remote = await fetchMetaTemplates(creds, fetchFn);

  let updated = 0;
  const now = new Date().toISOString();
  for (const sub of state.submissions) {
    const match = remote.find((r) => r.name === sub.name && r.language === sub.language);
    if (!match) continue;
    const remoteStatus = String(match.status).toUpperCase();
    let next: WaSubmissionStatus | null = null;
    if (remoteStatus === "APPROVED") next = "approved";
    else if (remoteStatus === "REJECTED") next = "rejected";
    else if (remoteStatus === "PENDING" || remoteStatus === "IN_APPEAL") next = "submitted";
    if (!next || next === sub.status) continue;
    sub.status = next;
    sub.metaTemplateId = sub.metaTemplateId || match.id;
    sub.rejectionReason = next === "rejected" ? match.rejectedReason ?? "Rejected by Meta" : null;
    sub.updatedAt = now;
    updated += 1;
  }
  if (updated > 0) await persistState(db, tenantId, state);
  return { updated, submissions: state.submissions };
}
