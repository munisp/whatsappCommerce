/**
 * Temporal activities — the only place workflow steps touch the outside world.
 *
 * Activities run in the worker process (NOT the workflow sandbox), so they may use fetch,
 * process.env, etc. They reach the platform through tRPC `internalProcedure` endpoints
 * (server/routers/temporalInternal.ts), authenticated with the shared INTERNAL_API_KEY sent
 * as X-Internal-Token. Session-authenticated procedures (kyc.submit, tenant.update, …) are
 * deliberately NOT called: an internal token does not satisfy them.
 *
 * Honest-failure doctrine (carried over from W42): a step with no real backing endpoint yet
 * throws a NON-retryable `ActivityNotImplemented` instead of returning a fabricated result,
 * so KYC / payment / messaging paths can never appear to succeed on made-up data.
 *
 * Backed today: InventorySync (listInventorySyncTenants, syncTenantInventory) and journey
 * orchestration (getJourneyPlan, runJourneyActivity, finishJourney).
 * Deliberately NOT backed: onboarding, order-fulfilment and broadcast — the platform already
 * does those durably and idempotently (see docs/TEMPORAL.md), so a second implementation
 * would only risk duplicate side effects.
 */
import { ApplicationFailure } from "@temporalio/activity";
import {
  FAILURE_NOT_IMPLEMENTED,
  FAILURE_PLATFORM_REJECTED,
  FAILURE_PLATFORM_UNAVAILABLE,
} from "./failureTypes";
import type { KycDecision } from "./types";

export { FAILURE_NOT_IMPLEMENTED, FAILURE_PLATFORM_REJECTED, FAILURE_PLATFORM_UNAVAILABLE };

// ── Platform client ───────────────────────────────────────────────────────────

export type ApiCall = <T = unknown>(procedure: string, input?: unknown, opts?: { timeoutMs?: number }) => Promise<T>;

export interface ApiCallConfig {
  baseUrl: string;
  internalToken: string;
  timeoutMs?: number;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

/** tRPC over HTTP with superjson: POST {json: input} → {result:{data:{json: output}}}. */
export function createApiCall(cfg: ApiCallConfig): ApiCall {
  const doFetch = cfg.fetchImpl ?? fetch;
  const base = cfg.baseUrl.replace(/\/+$/, "");
  return async function apiCall<T = unknown>(procedure: string, input: unknown = {}, opts: { timeoutMs?: number } = {}): Promise<T> {
    let res: Response;
    try {
      res = await doFetch(`${base}/api/trpc/${procedure}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Token": cfg.internalToken },
        body: JSON.stringify({ json: input }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? cfg.timeoutMs ?? 30_000),
      });
    } catch (err) {
      // Network error / timeout: transient — let Temporal retry.
      throw ApplicationFailure.retryable(
        `platform unreachable calling ${procedure}: ${(err as Error).message}`,
        FAILURE_PLATFORM_UNAVAILABLE,
      );
    }

    const text = await res.text();
    let body: any = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON body — handled below via status */
    }

    if (!res.ok) {
      const message: string = body?.error?.json?.message ?? body?.error?.message ?? text.slice(0, 200) ?? "";
      const label = `${procedure} → HTTP ${res.status}${message ? `: ${message}` : ""}`;
      // 5xx and 429 are transient; every other 4xx (401 bad token, 400 bad input, 404 …) will not
      // succeed on retry, so fail fast and visibly instead of burning the retry budget.
      if (res.status >= 500 || res.status === 429) {
        throw ApplicationFailure.retryable(label, FAILURE_PLATFORM_UNAVAILABLE);
      }
      throw ApplicationFailure.nonRetryable(label, FAILURE_PLATFORM_REJECTED);
    }
    return (body?.result?.data?.json ?? body?.result?.data) as T;
  };
}

// ── Activity implementations ─────────────────────────────────────────────────

function notImplemented(name: string, needs: string): never {
  throw ApplicationFailure.nonRetryable(
    `[temporal] activity_not_implemented: "${name}" has no backing internal endpoint yet (${needs}). ` +
      `Refusing to fabricate a result.`,
    FAILURE_NOT_IMPLEMENTED,
  );
}

export function createActivities(deps: { apiCall: ApiCall }) {
  const { apiCall } = deps;

  return {
    // ── Inventory sync (backed) ──────────────────────────────────────────────
    async listInventorySyncTenants(): Promise<string[]> {
      const out = await apiCall<{ tenantIds: string[] }>("temporalInternal.listInventorySyncTenants", {});
      return out.tenantIds;
    },

    async syncTenantInventory(tenantId: string): Promise<{ tenantId: string; recordsSynced: number }> {
      return apiCall("temporalInternal.syncTenantInventory", { tenantId });
    },

    // ── Journey orchestration (backed) ───────────────────────────────────────
    async getJourneyPlan(journeyId: string): Promise<string[]> {
      const out = await apiCall<{ activities: string[] }>("temporalInternal.journeyPlan", { journeyId });
      return out.activities;
    },

    /** Runs one registered activity server-side; a replay of a checkpointed one is a no-op. */
    async runJourneyActivity(runId: string, activityName: string): Promise<{ cached: boolean }> {
      // Registered activities call real services (orders, credit, audit) — allow them time.
      return apiCall("temporalInternal.runJourneyActivity", { runId, activityName }, { timeoutMs: 4 * 60_000 });
    },

    async finishJourney(runId: string, status: "completed" | "failed" | "cancelled", error?: string): Promise<void> {
      await apiCall("temporalInternal.finishJourney", { runId, status, error });
    },

    // ── Tenant onboarding (not yet backed) ───────────────────────────────────
    async submitKycForReview(_applicationId: string): Promise<void> {
      return notImplemented("submitKycForReview", "needs an internalProcedure wrapping the kyc.submit logic");
    },
    async getKycDecision(_applicationId: string): Promise<KycDecision> {
      return notImplemented("getKycDecision", "needs an internalProcedure reading kyc_applications.status");
    },
    async setupBillingPlan(_tenantId: string, _billingModel: string): Promise<void> {
      return notImplemented("setupBillingPlan", "needs an internalProcedure wrapping onboarding.saveStep(billing_model)");
    },
    async validateWhatsAppCredentials(_tenantId: string): Promise<boolean> {
      return notImplemented("validateWhatsAppCredentials", "needs an internalProcedure checking the tenant's WhatsApp config");
    },
    async activateTenant(_tenantId: string): Promise<void> {
      return notImplemented("activateTenant", "must go through goLiveTenant() so the go-live gates cannot be bypassed");
    },
    async sendWelcomeMessage(_tenantId: string, _email: string): Promise<void> {
      return notImplemented("sendWelcomeMessage", "needs an internalProcedure over the existing notification service");
    },

    // ── Order fulfilment (not yet backed) ────────────────────────────────────
    async confirmPayment(_orderId: string): Promise<boolean> {
      return notImplemented("confirmPayment", "needs an internalProcedure reading the order's payment status");
    },
    async syncOrderToOdoo(_orderId: string): Promise<void> {
      return notImplemented("syncOrderToOdoo", "needs a per-order internalProcedure (odoo.syncAll syncs everything)");
    },
    async sendOrderConfirmationWhatsApp(_orderId: string, _phone: string): Promise<void> {
      return notImplemented("sendOrderConfirmationWhatsApp", "needs an internalProcedure that de-duplicates against existing order notifications");
    },

    // ── Broadcast campaigns (not yet backed) ─────────────────────────────────
    async buildAudience(_campaignId: string): Promise<string[]> {
      return notImplemented("buildAudience", "needs an internalProcedure over broadcast recipients");
    },
    async sendBroadcastBatch(_campaignId: string, _recipients: string[], _templateId: string): Promise<number> {
      return notImplemented("sendBroadcastBatch", "needs an internalProcedure that respects consent + rate limits");
    },
  };
}

export type Activities = ReturnType<typeof createActivities>;
