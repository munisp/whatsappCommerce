/**
 * Paystack adapter for the Universal Payment Provider Framework (w11).
 *
 * Refactors the existing Paystack logic (payment.initiate router path,
 * creditRepayLink, paymentGateway router) behind the PaymentProvider
 * interface — same endpoints, same payload shapes, same kobo↔major
 * conversions. No behavior drift: legacy callers keep working until P3
 * rewires them to the registry.
 *
 * creds shape (decrypted by the registry before use):
 *   { secretKey: string; webhookSecret?: string; callbackUrl?: string }
 * webhookSecret falls back to secretKey (Paystack signs webhooks with the
 * secret key by default).
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  PaymentInitiateCtx,
  PaymentInitiateResult,
  PaymentProvider,
  WebhookNormalization,
} from "./types";

export interface PaystackCreds {
  secretKey: string;
  webhookSecret?: string;
  callbackUrl?: string;
}

const PAYSTACK_BASE = "https://api.paystack.co";
const INITIATE_TIMEOUT_MS = 10_000;

function asCreds(creds: unknown): PaystackCreds {
  const c = (creds ?? {}) as Partial<PaystackCreds>;
  return {
    secretKey: typeof c.secretKey === "string" ? c.secretKey : "",
    webhookSecret: typeof c.webhookSecret === "string" ? c.webhookSecret : undefined,
    callbackUrl: typeof c.callbackUrl === "string" ? c.callbackUrl : undefined,
  };
}

function hmacSha512Hex(rawBody: string, secret: string): string {
  return createHmac("sha512", secret).update(rawBody).digest("hex");
}

function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

function fail(reference = ""): WebhookNormalization {
  return { ok: false, reference, amountCents: 0, metadata: {} };
}

export const paystackProvider: PaymentProvider = {
  id: "paystack",
  displayName: "Paystack",

  async initiate(ctx: PaymentInitiateCtx, creds: unknown): Promise<PaymentInitiateResult> {
    const c = asCreds(creds);
    if (!c.secretKey) {
      return { ok: false, reference: ctx.reference, provider: "paystack" };
    }
    const email =
      ctx.customer.email ??
      `${ctx.customer.phone.replace(/\D/g, "") || "customer"}@wa.commerce`;
    try {
      const res = await fetch(`${PAYSTACK_BASE}/transaction/initialize`, {
        method: "POST",
        headers: { Authorization: `Bearer ${c.secretKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          amount: Math.round(ctx.amountCents), // Paystack minor units (kobo) == cents
          currency: ctx.currency,
          reference: ctx.reference,
          metadata: ctx.metadata,
          ...(ctx.callbackUrl ?? c.callbackUrl ? { callback_url: ctx.callbackUrl ?? c.callbackUrl } : {}),
        }),
        signal: AbortSignal.timeout(INITIATE_TIMEOUT_MS),
      });
      if (!res.ok) {
        return { ok: false, reference: ctx.reference, provider: "paystack" };
      }
      const data = (await res.json()) as {
        status: boolean;
        data?: { authorization_url?: string; reference?: string };
      };
      if (!data.status || !data.data?.authorization_url) {
        return { ok: false, reference: ctx.reference, provider: "paystack" };
      }
      return {
        ok: true,
        reference: data.data.reference ?? ctx.reference,
        authorizationUrl: data.data.authorization_url,
        provider: "paystack",
      };
    } catch {
      return { ok: false, reference: ctx.reference, provider: "paystack" };
    }
  },

  verifyWebhook(headers: Record<string, string>, rawBody: string, creds: unknown): WebhookNormalization {
    const c = asCreds(creds);
    // Fail closed: no signing secret → never trust the payload.
    const secret = c.webhookSecret || c.secretKey;
    if (!secret) return fail();
    const signature = headers["x-paystack-signature"] ?? "";
    if (!signature) return fail();
    if (!safeEqualHex(hmacSha512Hex(rawBody, secret), signature)) return fail();

    let payload: any;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return fail();
    }
    // Only charge.success confirms money; all other events are acknowledged
    // upstream but never normalize to a confirmation.
    if (payload?.event !== "charge.success") return fail();
    const reference = payload?.data?.reference;
    const amount = Number(payload?.data?.amount); // kobo == cents
    if (typeof reference !== "string" || !reference || !Number.isFinite(amount)) return fail();
    const metadata =
      payload.data.metadata && typeof payload.data.metadata === "object"
        ? (payload.data.metadata as Record<string, unknown>)
        : {};
    return { ok: true, reference, amountCents: amount, metadata };
  },

  async fetchStatus(reference: string, creds: unknown): Promise<{ status: "pending" | "success" | "failed"; amountCents: number }> {
    const c = asCreds(creds);
    if (!c.secretKey) return { status: "failed", amountCents: 0 };
    const res = await fetch(`${PAYSTACK_BASE}/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: { Authorization: `Bearer ${c.secretKey}` },
      signal: AbortSignal.timeout(INITIATE_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Paystack verify error: ${res.status}`);
    const data = (await res.json()) as { data?: { status?: string; amount?: number } };
    const raw = data.data?.status ?? "";
    const status = raw === "success" ? "success" : raw === "failed" || raw === "abandoned" ? "failed" : "pending";
    return { status, amountCents: Number.isFinite(data.data?.amount) ? Number(data.data!.amount) : 0 };
  },

  async testConnection(creds: unknown): Promise<{ ok: boolean; detail?: string }> {
    const c = asCreds(creds);
    if (!c.secretKey) return { ok: false, detail: "missing secretKey" };
    try {
      const res = await fetch(`${PAYSTACK_BASE}/bank?perPage=1`, {
        headers: { Authorization: `Bearer ${c.secretKey}` },
        signal: AbortSignal.timeout(INITIATE_TIMEOUT_MS),
      });
      return res.ok ? { ok: true } : { ok: false, detail: `HTTP ${res.status}` };
    } catch (err: any) {
      return { ok: false, detail: String(err?.message ?? err) };
    }
  },
};
