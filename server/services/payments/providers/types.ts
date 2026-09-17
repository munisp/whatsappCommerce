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
  /**
   * W45 (PAY-25): how a FAILED initiation (ok:false) should be treated by the
   * fallback orchestrator.
   *  - "definitive": the provider ANSWERED and refused (HTTP error response,
   *    missing credentials, no checkout link) — safe to fall back.
   *  - "ambiguous": the attempt ended inconclusively (network timeout, DNS,
   *    socket reset) — the provider MAY have created the checkout; the
   *    orchestrator MUST verify (fetchStatus) before falling back.
   * Adapters that omit this on an ok:false result are treated as "ambiguous"
   * (fail-safe: never mint a second checkout on an unclassified failure).
   */
  failureKind?: "definitive" | "ambiguous";
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

  /* -------- OPTIONAL refund capability (w30) -------- */
  /**
   * Refund a previously confirmed charge back to the buyer. `ctx.reference`
   * is the ORIGINAL payment reference (provider transaction reference), not a
   * new id. Returns status "processed" only when the provider has accepted
   * the refund for execution; "pending" when the provider queued it; never
   * report "processed" when money movement was not actually initiated.
   * Adapters without a real refund API MUST omit this method — callers then
   * use honest "refund_recorded" vocabulary instead of claiming a payout.
   */
  refund?(ctx: RefundCtx, creds: unknown): Promise<RefundResult>;
  /**
   * W38 (PAY-2): verify-before-retry. Query the provider for refunds already
   * recorded against an ORIGINAL payment reference. Used after a
   * timeout/ambiguous refund attempt — never re-issue a refund blindly.
   * Returns "exists" when the provider already has a refund for the payment
   * (safe to stop retrying), "not_found" when none exists (safe to retry),
   * "unknown" when the check itself failed (fail CLOSED — do not retry).
   */
  verifyRefund?(reference: string, creds: unknown): Promise<VerifyRefundResult>;

  /* -------- OPTIONAL mandate capability (w13) -------- */
  /** True when the adapter supports recurring/auto-debit mandates. */
  supportsMandates?: boolean;
  /**
   * Create a reusable customer authorization. Typically returns an
   * authorizationUrl the customer visits once to authorize future debits;
   * mandateRef is set when the provider issues the reusable handle
   * synchronously (otherwise it arrives later via webhook/verification).
   */
  createMandate?(ctx: MandateCreateCtx, creds: unknown): Promise<MandateCreateResult>;
  /**
   * Charge an existing mandate off-session. `ctx.reference` is passed
   * through verbatim as the provider-side transaction reference.
   */
  chargeMandate?(ctx: MandateChargeCtx, creds: unknown): Promise<MandateChargeResult>;
  /** Revoke a mandate. Best-effort where the provider lacks a true revoke. */
  revokeMandate?(mandateRef: string, creds: unknown): Promise<{ ok: boolean }>;
}

/* ------------------------------------------------------------------ */
/* REFUND operations — w30.                                            */
/* ------------------------------------------------------------------ */

export interface RefundCtx {
  tenantId: string;
  /** Original provider payment reference being refunded. */
  reference: string;
  amountCents: number;
  currency: string;
  reason?: string;
  metadata?: Record<string, unknown>;
}

export interface RefundResult {
  ok: boolean;
  /** "processed" = provider accepted/executed; "pending" = queued; "failed". */
  status: "processed" | "pending" | "failed";
  refundReference?: string;
  provider: string;
  error?: string;
  /**
   * W38 (PAY-2): true when the attempt ended ambiguously (e.g. network
   * timeout) — the provider MAY have accepted the refund. Callers MUST
   * verify-before-retry (see verifyRefund) and never blindly re-issue.
   */
  ambiguous?: boolean;
}

/** W38 (PAY-2): outcome of a provider-side refund status check. */
export interface VerifyRefundResult {
  state: "exists" | "not_found" | "unknown";
  provider: string;
  /** Provider refund reference when one already exists. */
  refundReference?: string;
  /** Provider-side refund status when known (e.g. "pending", "processed"). */
  status?: string;
  error?: string;
}

/* ------------------------------------------------------------------ */
/* MANDATE (recurring / auto-debit) operations — w13.                  */
/* Foundation for repayment-at-source in trade credit: a mandate is a  */
/* reusable customer authorization (Paystack authorization_code,       */
/* Flutterwave token, Stripe customer/payment_method) that the         */
/* provider can later charge off-session.                              */
/* ------------------------------------------------------------------ */

export interface MandateCreateCtx {
  tenantId: string;
  customerRef: string;
  amountLimitCents?: number;
  currency: string;
  email?: string;
  phone?: string;
  metadata?: Record<string, unknown>;
}

export interface MandateCreateResult {
  ok: boolean;
  mandateRef?: string;
  authorizationUrl?: string;
  instructions?: string;
  provider: string;
  error?: string;
}

export interface MandateChargeCtx {
  mandateRef: string;
  amountCents: number;
  currency: string;
  reference: string;
  metadata?: Record<string, unknown>;
}

export interface MandateChargeResult {
  ok: boolean;
  reference: string;
  status: 'success' | 'pending' | 'failed';
  provider: string;
  error?: string;
}
