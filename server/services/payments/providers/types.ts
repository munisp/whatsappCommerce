/**
 * server/services/payments/providers/types.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Wave-11 Universal Provider Framework — shared provider contracts.
 *
 * A PaymentProvider adapts ONE payment gateway (paystack, flutterwave, stripe,
 * monnify, manual, custom). Everything above the registry (order checkout,
 * credit repayment links, PO pay-now) speaks ONLY these shapes — provider
 * specifics never leak into the money path (paymentConfirm keeps resolving
 * intent rows by reference regardless of which provider served).
 */

/** Normalized initiation context every surface builds. */
export interface PaymentInitiateCtx {
  tenantId: string;
  /** Amount in MINOR units (cents/kobo). */
  amountCents: number;
  currency: string;
  /** Our unique payment reference (paymentIntents.providerPaymentId). */
  reference: string;
  /** Opaque provider-bound metadata (payment_intent_id, kind, …). */
  metadata: Record<string, unknown>;
  customer: { phone: string; email?: string };
  callbackUrl?: string;
}

/** Normalized initiation result. Exactly one of authorizationUrl/instructions. */
export interface PaymentInitiateResult {
  ok: boolean;
  reference: string;
  /** Hosted-checkout redirect URL (card/link providers). */
  authorizationUrl?: string;
  /** Human-readable settlement instructions (manual/custom providers). */
  instructions?: string;
  /** Id of the provider that served (echo of PaymentProvider.id). */
  provider: string;
  /** Raw provider payload for audit (stored in intent metadata). */
  raw?: Record<string, unknown>;
  error?: string;
}

export interface PaymentProvider {
  id: string;
  displayName: string;
  initiate(ctx: PaymentInitiateCtx, creds: unknown): Promise<PaymentInitiateResult>;
}

/** Decrypted tenant gateway credentials row shape (paymentGatewayConfigs). */
export interface TenantProviderCreds {
  publicKey?: string | null;
  secretKey?: string | null;
  webhookSecret?: string | null;
  callbackUrl?: string | null;
  metadata?: Record<string, unknown> | null;
}
