/**
 * server/services/insurance/adapters.ts — W27 micro-insurance partner
 * adapter interface (FROZEN CONTRACT) + deterministic mock adapter.
 *
 * FROZEN CONTRACT (Wave 27 spec §Interface contracts):
 *   interface InsuranceAdapter {
 *     quote(productId, context): Promise<PremiumQuote>;
 *     bind(quoteId): Promise<Policy>;
 *     claim(policyId, reason): Promise<Claim>;
 *   }
 * Do not change these signatures — other coders code against them.
 *
 * The adapter is intentionally stateless about persistence: quote()/bind()/
 * claim() compute partner-side artifacts; server/services/insurance.ts owns
 * the DB rows. The mock adapter is fully deterministic (HMAC-derived ids,
 * premium from product config — no randomness), so journeys and unit tests
 * are reproducible.
 */
import crypto from "crypto";
import { ENV } from "../../_core/env";
import type { InsuranceProduct } from "../../../drizzle/schema";

// ── FROZEN CONTRACT TYPES ────────────────────────────────────────────────────
export interface QuoteContext {
  tenantId: string;
  orderId?: string;
  holderPhone?: string;
  /** Order total the premium is computed against (integer cents). */
  orderAmountCents?: number;
  currency?: string;
  [key: string]: unknown;
}

export interface PremiumQuote {
  quoteRef: string; // partner-side quote reference (deterministic in mock)
  productId: string;
  premiumCents: number;
  coverageCents: number;
  currency: string;
  expiresAt: Date | null;
}

export interface PartnerPolicy {
  policyNumber: string;
  quoteRef: string;
  productId: string;
  premiumCents: number;
  coverageCents: number;
  currency: string;
  status: "active";
}

export interface PartnerClaim {
  claimRef: string;
  policyNumber: string;
  reason: string;
  status: "filed" | "approved" | "rejected";
  payoutCents: number | null;
}

export interface InsuranceAdapter {
  quote(productId: string, context: QuoteContext): Promise<PremiumQuote>;
  bind(quoteId: string): Promise<PartnerPolicy>;
  claim(policyId: string, reason: string): Promise<PartnerClaim>;
}
// ── END FROZEN CONTRACT ──────────────────────────────────────────────────────

/** Deterministic premium: max(flat, orderCents × bps / 10_000), integer cents. */
export function computePremiumCents(product: Pick<InsuranceProduct, "premiumBps" | "flatPremiumCents">, orderAmountCents: number): number {
  const proportional = Math.floor((orderAmountCents * product.premiumBps) / 10_000);
  return Math.max(product.flatPremiumCents, proportional);
}

function hmacShort(...parts: string[]): string {
  return crypto.createHmac("sha256", ENV.jwtSecret).update(parts.join(":")).digest("base64url").slice(0, 16);
}

/**
 * MockInsuranceAdapter — deterministic stand-in for a real underwriter.
 * Quote refs, policy numbers and claim refs are HMACs of their inputs, so a
 * given (productId, context) always produces the same artifacts. Claims on
 * active policies are auto-approved at full coverage (parametric-style);
 * anything else is rejected. Registered quotes/policies are injected by the
 * insurance service (the adapter keeps no DB handle).
 */
export class MockInsuranceAdapter implements InsuranceAdapter {
  constructor(
    private readonly products: Map<string, InsuranceProduct>,
    private readonly quotes: Map<string, PremiumQuote & QuoteContext>,
    private readonly policies: Map<string, PartnerPolicy>,
  ) {}

  async quote(productId: string, context: QuoteContext): Promise<PremiumQuote> {
    const product = this.products.get(productId);
    if (!product || !product.active) throw new Error(`unknown or inactive insurance product: ${productId}`);
    const orderCents = Math.max(0, Math.floor(context.orderAmountCents ?? 0));
    const premiumCents = computePremiumCents(product, orderCents);
    return {
      quoteRef: `Q-${hmacShort(productId, context.tenantId, context.orderId ?? "none", String(orderCents))}`,
      productId,
      premiumCents,
      coverageCents: product.coverageCents,
      currency: context.currency ?? "NGN",
      expiresAt: null,
    };
  }

  async bind(quoteId: string): Promise<PartnerPolicy> {
    const q = this.quotes.get(quoteId);
    if (!q) throw new Error(`unknown quote: ${quoteId}`);
    return {
      policyNumber: `POL-${hmacShort("policy", q.quoteRef)}`,
      quoteRef: q.quoteRef,
      productId: q.productId,
      premiumCents: q.premiumCents,
      coverageCents: q.coverageCents,
      currency: q.currency,
      status: "active",
    };
  }

  async claim(policyId: string, reason: string): Promise<PartnerClaim> {
    const p = this.policies.get(policyId);
    if (!p) throw new Error(`unknown policy: ${policyId}`);
    return {
      claimRef: `CLM-${hmacShort("claim", p.policyNumber, reason)}`,
      policyNumber: p.policyNumber,
      reason,
      status: "approved",
      payoutCents: p.coverageCents,
    };
  }
}

// ── Registry (payment-provider-registry pattern) ────────────────────────────
export const INSURANCE_ADAPTER_MOCK = "mock";

export function getInsuranceAdapterName(): string {
  return (process.env.INSURANCE_ADAPTER ?? INSURANCE_ADAPTER_MOCK).trim() || INSURANCE_ADAPTER_MOCK;
}
