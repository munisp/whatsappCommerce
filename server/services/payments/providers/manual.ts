/**
 * Manual / bank-transfer adapter for the Universal Payment Provider
 * Framework (w11).
 *
 * Formalizes the existing receipt-upload flow: initiation renders bank
 * account instructions (no gateway redirect); confirmation happens offline
 * via the receipt-screenshot verification pipeline
 * (server/services/receiptVerification.ts), which feeds the SAME
 * paymentConfirm entry point. That flow is untouched by this adapter.
 *
 * creds shape (from payment_gateway_configs.credentials jsonb):
 *   { bankName: string; accountNumber: string; accountName: string;
 *     instructions?: string }
 */
import type {
  PaymentInitiateCtx,
  PaymentInitiateResult,
  PaymentProvider,
  WebhookNormalization,
} from "./types";

export interface ManualCreds {
  bankName?: string;
  accountNumber?: string;
  accountName?: string;
  instructions?: string;
}

function asCreds(creds: unknown): ManualCreds {
  const c = (creds ?? {}) as Record<string, unknown>;
  return {
    bankName: typeof c.bankName === "string" ? c.bankName : undefined,
    accountNumber: typeof c.accountNumber === "string" ? c.accountNumber : undefined,
    accountName: typeof c.accountName === "string" ? c.accountName : undefined,
    instructions: typeof c.instructions === "string" ? c.instructions : undefined,
  };
}

export function renderManualInstructions(c: ManualCreds, amountCents: number, currency: string, reference: string): string {
  if (c.instructions) return c.instructions;
  const amountMajor = (amountCents / 100).toFixed(2);
  const lines = [
    `Pay ${currency} ${amountMajor} by bank transfer:`,
    c.bankName ? `Bank: ${c.bankName}` : null,
    c.accountNumber ? `Account number: ${c.accountNumber}` : null,
    c.accountName ? `Account name: ${c.accountName}` : null,
    `Reference: ${reference}`,
    "After paying, send a photo of your receipt here to confirm your payment.",
  ];
  return lines.filter((l): l is string => Boolean(l)).join("\n");
}

export const manualProvider: PaymentProvider = {
  id: "manual",
  displayName: "Manual Bank Transfer",

  async initiate(ctx: PaymentInitiateCtx, creds: unknown): Promise<PaymentInitiateResult> {
    const c = asCreds(creds);
    return {
      ok: true,
      reference: ctx.reference,
      instructions: renderManualInstructions(c, ctx.amountCents, ctx.currency, ctx.reference),
      provider: "manual",
    };
  },

  verifyWebhook(_headers: Record<string, string>, _rawBody: string, _creds: unknown): WebhookNormalization {
    // Manual transfer has NO inbound webhook — confirmation happens via the
    // receipt-upload verification path. Fail closed so a forged POST to the
    // unified webhook route can never confirm a manual payment.
    return {
      ok: false,
      reference: "",
      amountCents: 0,
      metadata: { reason: "manual provider has no webhook; confirmation is via receipt upload" },
    };
  },

  async fetchStatus(_reference: string, _creds: unknown): Promise<{ status: "pending" | "success" | "failed"; amountCents: number }> {
    // No API to poll — status changes only via receipt verification.
    return { status: "pending", amountCents: 0 };
  },

  async testConnection(creds: unknown): Promise<{ ok: boolean; detail?: string }> {
    const c = asCreds(creds);
    return c.accountNumber
      ? { ok: true }
      : { ok: false, detail: "missing accountNumber" };
  },
};
