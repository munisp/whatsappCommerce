/**
 * === W45 money-intents (PAY-25) ===
 * server/services/payments/initiateWithFallback.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Wave-11 fallback orchestrator — the ONLY way surfaces talk to providers.
 *
 * Walks the tenant's priority-ordered provider chain (registry
 * getProviderForTenant). W45 (PAY-25): fallback to the next provider happens
 * ONLY on a DEFINITIVE failure (adapter answered and refused). An ambiguous
 * failure (timeout/network throw or unclassified ok:false) is VERIFIED via
 * the provider's fetchStatus(reference) first — a live checkout at provider A
 * means A serves (recoveredViaVerify) and NO second checkout is minted; an
 * inconclusive verify ABORTS the chain instead of risking duplicate checkouts.
 *
 * The serving provider id is returned so callers can record it in the intent
 * record (metadata.servedProvider + the existing provider column — NO
 * migration). When every provider fails it throws
 * ProviderChainExhaustedError so callers land on their existing
 * graceful-error paths.
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
  /**
   * W45 (PAY-25): true when the serving provider's initiate AMBIGUOUSLY
   * failed (timeout/network) but fetchStatus proved the checkout exists
   * provider-side — the reference is live at this provider even though no
   * authorization URL was recovered. Never minted a second checkout.
   */
  recoveredViaVerify?: boolean;
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
  for (let i = 0; i < chain.length; i++) {
    const entry = chain[i]!;
    const hasFallback = i < chain.length - 1;
    let result: PaymentInitiateResult | null = null;
    let threw = false;
    try {
      result = await entry.provider.initiate(ctx, entry.creds);
      if (result.ok) {
        return { result, providerId: entry.provider.id, failedAttempts: attempts };
      }
      attempts.push({ provider: entry.provider.id, error: "initiate returned ok:false" });
    } catch (err: any) {
      threw = true;
      attempts.push({ provider: entry.provider.id, error: String(err?.message ?? err).slice(0, 300) });
    }
    const lastError = attempts[attempts.length - 1]!.error;
    // Fallback hop: a provider failed and another may serve — warn (not
    // critical; the payment can still succeed on the next provider).
    captureException(new Error(`provider ${entry.provider.id} initiate failed: ${lastError}`), {
      service: "payments/initiateWithFallback",
      operation: "providerFallback",
      tenantId,
      severity: "warn",
      extra: { reference: ctx.reference, provider: entry.provider.id, attempt: attempts.length },
    });

    // === W45 (PAY-25) verify-before-fallback ===
    // Minting a checkout at the NEXT provider is only safe when provider A's
    // failure is DEFINITIVE (it answered and refused). A thrown error
    // (timeout/network) or an ok:false the adapter did not classify is
    // AMBIGUOUS — the checkout may exist at A. Verify A's transaction state
    // for this reference first:
    //   - fetchStatus "failed"      → definitive: hop.
    //   - fetchStatus pending/success → checkout LIVE at A: do NOT mint a
    //     second checkout; report A as the serving provider (recovered).
    //   - fetchStatus throws        → cannot disprove a live checkout at A:
    //     ABORT the chain (verify-before-compensate) instead of risking two
    //     live checkouts for one intent.
    const failureKind: "definitive" | "ambiguous" =
      threw || !result ? "ambiguous" : result.failureKind ?? "ambiguous";
    if (failureKind === "ambiguous" && hasFallback) {
      let probe: { status: "pending" | "success" | "failed"; amountCents: number } | null = null;
      let probeError: string | null = null;
      try {
        probe = await entry.provider.fetchStatus(ctx.reference, entry.creds);
      } catch (err: any) {
        probeError = String(err?.message ?? err).slice(0, 300);
      }
      if (probe && (probe.status === "pending" || probe.status === "success")) {
        captureException(new Error(
          `provider ${entry.provider.id} initiate was ambiguous but the reference IS live provider-side (status ${probe.status}) — recovered WITHOUT minting a second checkout`,
        ), {
          service: "payments/initiateWithFallback",
          operation: "ambiguousRecovered",
          tenantId,
          severity: "warn",
          extra: { reference: ctx.reference, provider: entry.provider.id, probeStatus: probe.status },
        });
        return {
          result: { ok: true, reference: ctx.reference, provider: entry.provider.id },
          providerId: entry.provider.id,
          failedAttempts: attempts,
          recoveredViaVerify: true,
        };
      }
      if (probeError || !probe) {
        // Inconclusive verify — REFUSE to fall back blind.
        attempts[attempts.length - 1]!.error =
          `${lastError} (verify inconclusive: ${probeError ?? "no probe result"})`;
        captureException(new Error(
          `provider ${entry.provider.id} initiate ambiguous AND fetchStatus inconclusive (${probeError ?? "none"}) — refusing blind fallback to protect against double checkouts`,
        ), {
          service: "payments/initiateWithFallback",
          operation: "fallbackRefused",
          tenantId,
          severity: "critical",
          extra: { reference: ctx.reference, provider: entry.provider.id },
        });
        throw new ProviderChainExhaustedError(attempts);
      }
      // probe.status === "failed" → definitive; fall through to the next provider.
      attempts[attempts.length - 1]!.error = `${lastError} (verified failed at provider)`;
    }
    // === END W45 (PAY-25) ===
  }
  throw new ProviderChainExhaustedError(attempts);
}
