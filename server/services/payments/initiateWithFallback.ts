/**
 * server/services/payments/initiateWithFallback.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Wave-11 fallback orchestrator — the ONLY way surfaces talk to providers.
 *
 * Walks the tenant's priority-ordered provider chain (registry
 * getProviderForTenant). On initiate failure (throw OR ok:false) it reports a
 * WARN to wave-10 observability and tries the next provider. The serving
 * provider id is returned so callers can record it in the intent record
 * (metadata.servedProvider + the existing provider column — NO migration).
 * When every provider fails it throws ProviderChainExhaustedError so callers
 * land on their existing graceful-error paths.
 */

import { getProviderForTenant, getProviderAdapter, type TenantProviderEntry } from "./providers/registry";
import type { PaymentInitiateCtx, PaymentInitiateResult } from "./providers/types";
import { captureException } from "../observability";
import { ENV } from "../../_core/env";
// Side-effect: registers the "custom" provider adapter with the registry.
import "./providers/custom";

/**
 * Platform-default chain for tenants with NO configured provider rows
 * (pre-registry behavior): env-backed Paystack, then Flutterwave when its env
 * key is present. Additive over P1's registry (which returns [] for
 * unconfigured tenants) so existing tenants keep working unchanged.
 */
function envDefaultChain(): TenantProviderEntry[] {
  const chain: TenantProviderEntry[] = [];
  const paystack = getProviderAdapter("paystack");
  if (paystack && ENV.paystackSecretKey) {
    chain.push({ provider: paystack, creds: { secretKey: ENV.paystackSecretKey }, config: { priority: 0 } });
  }
  const flutterwave = getProviderAdapter("flutterwave");
  if (flutterwave && ENV.flwSecretKey) {
    chain.push({ provider: flutterwave, creds: { secretKey: ENV.flwSecretKey }, config: { priority: -1 } });
  }
  return chain;
}

export class ProviderChainExhaustedError extends Error {
  readonly attempts: { provider: string; error: string }[];
  constructor(attempts: { provider: string; error: string }[]) {
    super(
      attempts.length === 0
        ? "No payment provider is configured for this tenant"
        : `All payment providers failed: ${attempts.map((a) => `${a.provider} (${a.error})`).join("; ")}`,
    );
    this.name = "ProviderChainExhaustedError";
    this.attempts = attempts;
  }
}

export interface FallbackInitiateOptions {
  /** Caller-preferred provider id (e.g. payment.initiate's provider input):
   * tried first when present in the tenant chain; the rest remain fallbacks. */
  preferredProvider?: string | null;
}

export interface FallbackInitiateOutcome {
  result: PaymentInitiateResult;
  /** Id of the provider that actually served the payment. */
  providerId: string;
  /** Providers that failed before the serving one (empty when primary served). */
  failedAttempts: { provider: string; error: string }[];
}

export async function initiateWithFallback(
  tenantId: string,
  ctx: PaymentInitiateCtx,
  opts: FallbackInitiateOptions = {},
): Promise<FallbackInitiateOutcome> {
  let chain: TenantProviderEntry[];
  try {
    chain = await getProviderForTenant(tenantId);
  } catch (err: any) {
    // Registry read failure (DB outage / legacy fake) must not hard-fail the
    // payment: degrade to the env-default chain and report.
    captureException(err, {
      service: "payments/initiateWithFallback",
      operation: "registryRead",
      tenantId,
      severity: "warn",
      extra: { reference: ctx.reference },
    });
    chain = [];
  }
  if (chain.length === 0) chain = envDefaultChain();
  if (opts.preferredProvider) {
    const idx = chain.findIndex((e) => e.provider.id === opts.preferredProvider);
    if (idx > 0) {
      const [preferred] = chain.splice(idx, 1);
      chain = [preferred, ...chain];
    }
  }

  const attempts: { provider: string; error: string }[] = [];
  for (const entry of chain) {
    try {
      const result = await entry.provider.initiate(ctx, entry.creds);
      if (result.ok) {
        return { result, providerId: entry.provider.id, failedAttempts: attempts };
      }
      attempts.push({ provider: entry.provider.id, error: "initiate returned ok:false" });
    } catch (err: any) {
      attempts.push({ provider: entry.provider.id, error: String(err?.message ?? err).slice(0, 300) });
    }
    // Fallback hop: a provider failed and another may serve — warn (not
    // critical; the payment can still succeed on the next provider).
    captureException(new Error(`provider ${entry.provider.id} initiate failed: ${attempts[attempts.length - 1].error}`), {
      service: "payments/initiateWithFallback",
      operation: "providerFallback",
      tenantId,
      severity: "warn",
      extra: { reference: ctx.reference, provider: entry.provider.id, attempt: attempts.length },
    });
  }
  throw new ProviderChainExhaustedError(attempts);
}
