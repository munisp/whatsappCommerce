/**
 * server/services/payments/providers/custom.ts (w11 P3)
 * ─────────────────────────────────────────────────────────────────────────────
 * "custom" provider adapter — the tenant-defined bespoke gateway. Initiation
 * renders the tenant's settlement instructions (credentials jsonb extras:
 * { instructions, customConfig }); confirmation flows through the SAME
 * receipt-verification path as manual payments. Webhook intake fails closed
 * (a custom gateway has no verified inbound channel here).
 *
 * Self-registers at module load, exactly like P1's built-ins.
 */
import type {
  PaymentInitiateCtx,
  PaymentInitiateResult,
  PaymentProvider,
  WebhookNormalization,
} from "./types";
import { registerProvider } from "./registry";

export interface CustomCreds {
  instructions?: string;
  customConfig?: Record<string, unknown>;
}

function asCreds(creds: unknown): CustomCreds {
  const c = (creds ?? {}) as Record<string, unknown>;
  return {
    instructions: typeof c.instructions === "string" ? c.instructions : undefined,
    customConfig:
      c.customConfig && typeof c.customConfig === "object"
        ? (c.customConfig as Record<string, unknown>)
        : undefined,
  };
}

export const customProvider: PaymentProvider = {
  id: "custom",
  displayName: "Custom Gateway",

  async initiate(ctx: PaymentInitiateCtx, creds: unknown): Promise<PaymentInitiateResult> {
    const c = asCreds(creds);
    const instructions =
      c.instructions?.trim() ||
      (typeof c.customConfig?.instructions === "string" ? c.customConfig.instructions.trim() : "") ||
      `Please pay ${(ctx.amountCents / 100).toFixed(2)} ${ctx.currency} quoting reference ${ctx.reference}. ` +
        `Send your receipt here to confirm.`;
    return { ok: true, reference: ctx.reference, instructions, provider: "custom" };
  },

  verifyWebhook(_headers: Record<string, string>, _rawBody: string, _creds: unknown): WebhookNormalization {
    // Fail closed: custom gateways confirm via receipt upload, never webhook.
    return {
      ok: false,
      reference: "",
      amountCents: 0,
      metadata: { reason: "custom provider has no webhook; confirmation is via receipt upload" },
    };
  },

  async fetchStatus(_reference, _creds) {
    return { status: "pending" as const, amountCents: 0 };
  },

  async testConnection(creds: unknown) {
    const c = asCreds(creds);
    return c.instructions?.trim() || c.customConfig
      ? { ok: true }
      : { ok: false, detail: "missing instructions/customConfig" };
  },
};

registerProvider(customProvider);
