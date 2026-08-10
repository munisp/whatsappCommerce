/**
 * Universal Payment Provider Framework (w11) — core contract.
 *
 * P2/P3 code against EXACTLY these signatures. Adapters live next to this
 * file (paystack.ts, manual.ts) and are wired per-tenant via registry.ts.
 *
 * Credential handling: `creds` is opaque to callers — each adapter defines
 * its own creds shape. Secrets inside creds are ALWAYS handled in plaintext
 * only in memory; at rest they are AES-256-GCM encrypted inside
 * payment_gateway_configs (see server/services/crypto/secrets.ts) and are
 * decrypted by the registry's config read path before being handed here.
 */

export interface PaymentInitiateCtx {
  tenantId: string;
  amountCents: number;
  currency: string;
  reference: string;
  metadata: Record<string, unknown>;
  customer: { phone: string; email?: string };
  callbackUrl?: string;
}

export interface PaymentInitiateResult {
  ok: boolean;
  reference: string;
  authorizationUrl?: string;
  instructions?: string;
  provider: string;
}

export interface WebhookNormalization {
  ok: boolean;
  reference: string;
  amountCents: number;
  metadata: Record<string, unknown>;
}

export interface PaymentProvider {
  id: string;
  displayName: string;
  initiate(ctx: PaymentInitiateCtx, creds: unknown): Promise<PaymentInitiateResult>;
  /**
   * Verify + normalize an inbound webhook. MUST fail closed: any missing or
   * mismatched signature, malformed body, or unrecognized event yields
   * { ok: false } and the caller must NEVER confirm the payment.
   * Synchronous where possible (HMAC verification is sync).
   */
  verifyWebhook(headers: Record<string, string>, rawBody: string, creds: unknown): WebhookNormalization;
  fetchStatus(reference: string, creds: unknown): Promise<{ status: 'pending' | 'success' | 'failed'; amountCents: number }>;
  testConnection(creds: unknown): Promise<{ ok: boolean; detail?: string }>;
}
