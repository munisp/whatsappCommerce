/**
 * Read-only provider payment-status verification (Wave 26 audit F2/F3/MEDIUM).
 *
 * Grants of value (digital downloads, subscriptions, admin payment confirms)
 * must NEVER rely on a client assertion or an OCR receipt alone — they require
 * either a locally CONFIRMED payment record or a live provider fetchStatus
 * probe. This helper wraps the provider registry's fetchStatus with a timeout
 * and fail-safe "unknown" semantics so callers can decide their own policy
 * (fail-closed for value grants; warn-and-proceed for admin overrides).
 */
import { getProviderForTenant } from "./providers/registry";

export type ProviderPaymentStatus = "pending" | "success" | "failed" | "unknown";

/**
 * Probe the serving provider for a reference's live status. Returns
 * { status: "unknown" } when the provider is not configured for the tenant,
 * does not support fetchStatus, times out, or errors — NEVER throws.
 */
export async function fetchProviderPaymentStatus(
  tenantId: string,
  args: { provider: string; reference: string; timeoutMs?: number },
): Promise<{ status: ProviderPaymentStatus; amountCents?: number }> {
  const timeoutMs = args.timeoutMs ?? 10_000;
  try {
    const chain = await getProviderForTenant(tenantId);
    const entry = (chain ?? []).find(
      (e) => e?.provider?.id === args.provider && typeof e.provider.fetchStatus === "function",
    );
    if (!entry) return { status: "unknown" };
    const res = await Promise.race([
      entry.provider.fetchStatus(args.reference, entry.creds),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("fetch_status_timeout")), timeoutMs)),
    ]);
    if (!res || (res.status !== "success" && res.status !== "failed" && res.status !== "pending")) {
      return { status: "unknown" };
    }
    return { status: res.status, amountCents: res.amountCents };
  } catch (err: any) {
    console.warn(`[payments/verify] fetchStatus ${args.provider}/${args.reference}: ${err?.message}`);
    return { status: "unknown" };
  }
}

/**
 * Has this reference been verifiably PAID for this tenant? Checks, in order:
 *   1. A locally confirmed payment_intents / payment_transactions row
 *      (tenant-scoped — a reference from another tenant never verifies).
 *   2. A live provider fetchStatus probe (when the provider is known).
 * When expectedAmountCents is given, the paid amount must match EXACTLY in
 * integer minor units — no tolerance.
 */
export async function hasVerifiedPayment(
  db: any,
  opts: {
    tenantId: string;
    reference: string;
    provider?: string;
    expectedAmountCents?: number;
  },
): Promise<{ verified: boolean; via: "record" | "provider" | "none"; detail?: string }> {
  const { paymentIntents, paymentTransactions } = await import("../../../drizzle/schema");
  const { eq, and } = await import("drizzle-orm");

  const amountOk = (storedMajor: unknown, storedCurrency?: string | null): boolean => {
    if (opts.expectedAmountCents == null) return true;
    const major = parseFloat(String(storedMajor ?? ""));
    if (!Number.isFinite(major)) return false;
    return Math.round(major * 100) === opts.expectedAmountCents;
  };

  // 1. Local confirmed records (tenant-scoped).
  try {
    const [intent] = await db.select().from(paymentIntents)
      .where(and(eq(paymentIntents.providerPaymentId, opts.reference), eq(paymentIntents.tenantId, opts.tenantId)))
      .limit(1);
    if (intent) {
      if (intent.status === "completed") {
        if (!amountOk(intent.amount, intent.currency)) {
          return { verified: false, via: "none", detail: "amount-mismatch" };
        }
        return { verified: true, via: "record" };
      }
      const provider = opts.provider
        ?? ((intent.metadata as Record<string, unknown> | null)?.servedProvider as string | undefined)
        ?? intent.provider;
      if (provider) {
        const live = await fetchProviderPaymentStatus(opts.tenantId, { provider, reference: opts.reference });
        if (live.status === "success") {
          if (opts.expectedAmountCents != null && live.amountCents != null && live.amountCents !== opts.expectedAmountCents) {
            return { verified: false, via: "none", detail: "provider-amount-mismatch" };
          }
          return { verified: true, via: "provider" };
        }
        return { verified: false, via: "none", detail: `provider-status:${live.status}` };
      }
      return { verified: false, via: "none", detail: `intent-status:${intent.status}` };
    }

    const [tx] = await db.select().from(paymentTransactions)
      .where(and(eq(paymentTransactions.providerRef, opts.reference), eq(paymentTransactions.tenantId, opts.tenantId)))
      .limit(1);
    if (tx) {
      if (tx.status === "completed" && amountOk(tx.amount, tx.currency)) {
        return { verified: true, via: "record" };
      }
      if (tx.status === "completed") return { verified: false, via: "none", detail: "amount-mismatch" };
      const provider = opts.provider ?? tx.provider;
      if (provider) {
        const live = await fetchProviderPaymentStatus(opts.tenantId, { provider, reference: opts.reference });
        if (live.status === "success") {
          if (opts.expectedAmountCents != null && live.amountCents != null && live.amountCents !== opts.expectedAmountCents) {
            return { verified: false, via: "none", detail: "provider-amount-mismatch" };
          }
          return { verified: true, via: "provider" };
        }
        return { verified: false, via: "none", detail: `provider-status:${live.status}` };
      }
      return { verified: false, via: "none", detail: `tx-status:${tx.status}` };
    }
  } catch (err: any) {
    // Money-context read failure: log loudly and FAIL CLOSED.
    console.error(`[payments/verify] hasVerifiedPayment read failed for ref=${opts.reference}:`, err?.message);
    return { verified: false, via: "none", detail: "verification-error" };
  }

  // No local record at all — try a provider probe if the caller named one.
  if (opts.provider) {
    const live = await fetchProviderPaymentStatus(opts.tenantId, { provider: opts.provider, reference: opts.reference });
    if (live.status === "success") {
      if (opts.expectedAmountCents != null && live.amountCents != null && live.amountCents !== opts.expectedAmountCents) {
        return { verified: false, via: "none", detail: "provider-amount-mismatch" };
      }
      return { verified: true, via: "provider" };
    }
    return { verified: false, via: "none", detail: `provider-status:${live.status}` };
  }
  return { verified: false, via: "none", detail: "not-found" };
}
