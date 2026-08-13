import { createHmac, timingSafeEqual } from 'node:crypto';
import type {
  MandateChargeCtx,
  MandateChargeResult,
  MandateCreateCtx,
  MandateCreateResult,
  PaymentInitiateCtx,
  PaymentInitiateResult,
  PaymentProvider,
  WebhookNormalization,
} from './types';

export interface StripeCreds {
  secretKey: string;
  webhookSecret: string; // whsec_...
}

const BASE = 'https://api.stripe.com';
const TIMEOUT_MS = 15_000;
const TOLERANCE_SEC = 300;

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

async function stripeFetch(path: string, init: RequestInit, secretKey: string): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: {
      Authorization: `Bearer ${secretKey}`,
      ...(init.headers ?? {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`stripe HTTP ${res.status}`);
  }
  return body;
}

export const stripeProvider: PaymentProvider = {
  id: 'stripe',
  displayName: 'Stripe',

  async initiate(ctx: PaymentInitiateCtx, creds: unknown): Promise<PaymentInitiateResult> {
    const c = creds as StripeCreds;
    try {
      const params = new URLSearchParams();
      params.set('mode', 'payment');
      params.set('client_reference_id', ctx.reference);
      params.set('line_items[0][price_data][currency]', ctx.currency.toLowerCase());
      params.set('line_items[0][price_data][unit_amount]', String(ctx.amountCents));
      params.set('line_items[0][price_data][product_data][name]', 'Payment');
      params.set('line_items[0][quantity]', '1');
      if (ctx.customer.email) params.set('customer_email', ctx.customer.email);
      if (ctx.callbackUrl) {
        params.set('success_url', ctx.callbackUrl);
        params.set('cancel_url', ctx.callbackUrl);
      }
      params.set('metadata[reference]', ctx.reference);
      for (const [k, v] of Object.entries(ctx.metadata)) {
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
          params.set(`metadata[${k}]`, String(v));
        }
      }
      const body = await stripeFetch(
        '/v1/checkout/sessions',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: params.toString(),
        },
        c.secretKey,
      );
      const url = body?.url;
      return {
        ok: typeof url === 'string' && url.length > 0,
        reference: ctx.reference,
        authorizationUrl: typeof url === 'string' ? url : undefined,
        provider: 'stripe',
      };
    } catch {
      return { ok: false, reference: ctx.reference, instructions: 'initiate failed', provider: 'stripe' };
    }
  },

  verifyWebhook(headers: Record<string, string>, rawBody: string, creds: unknown): WebhookNormalization {
    const c = creds as StripeCreds;
    const fail: WebhookNormalization = { ok: false, reference: '', amountCents: 0, metadata: {} };
    const sigHeader = headers['stripe-signature'] ?? headers['Stripe-Signature'];
    if (typeof sigHeader !== 'string' || !c.webhookSecret) return fail;
    const parts = new Map<string, string[]>();
    for (const kv of sigHeader.split(',')) {
      const idx = kv.indexOf('=');
      if (idx < 0) continue;
      const k = kv.slice(0, idx);
      const v = kv.slice(idx + 1);
      parts.set(k, [...(parts.get(k) ?? []), v]);
    }
    const ts = parts.get('t')?.[0];
    const sigs = parts.get('v1') ?? [];
    if (!ts || sigs.length === 0) return fail;
    const timestamp = Number(ts);
    if (!Number.isFinite(timestamp)) return fail;
    if (Math.abs(Math.floor(Date.now() / 1000) - timestamp) > TOLERANCE_SEC) return fail;
    const expected = createHmac('sha256', c.webhookSecret).update(`${ts}.${rawBody}`).digest('hex');
    if (!sigs.some((s) => safeEqual(s, expected))) return fail;
    let event: any;
    try {
      event = JSON.parse(rawBody);
    } catch {
      return fail;
    }
    const obj = event?.data?.object ?? {};
    const reference = obj.client_reference_id ?? obj.metadata?.reference;
    const amount = typeof obj.amount_total === 'number' ? obj.amount_total : Number(obj.amount_total);
    if (typeof reference !== 'string' || !reference || !Number.isFinite(amount)) return fail;
    return {
      ok: true,
      reference,
      amountCents: Math.round(amount),
      metadata: (obj.metadata && typeof obj.metadata === 'object' ? obj.metadata : {}) as Record<string, unknown>,
    };
  },

  async fetchStatus(reference: string, creds: unknown): Promise<{ status: 'pending' | 'success' | 'failed'; amountCents: number }> {
    const c = creds as StripeCreds;
    const body = await stripeFetch(
      `/v1/checkout/sessions?client_reference_id=${encodeURIComponent(reference)}&limit=1`,
      { method: 'GET' },
      c.secretKey,
    );
    const session = body?.data?.[0] ?? {};
    const paymentStatus = String(session.payment_status ?? '').toLowerCase();
    const sessionStatus = String(session.status ?? '').toLowerCase();
    const status: 'pending' | 'success' | 'failed' =
      paymentStatus === 'paid' || sessionStatus === 'complete'
        ? 'success'
        : sessionStatus === 'expired' || sessionStatus === 'canceled'
          ? 'failed'
          : 'pending';
    const amount = typeof session.amount_total === 'number' ? session.amount_total : Number(session.amount_total);
    return { status, amountCents: Number.isFinite(amount) ? Math.round(amount) : 0 };
  },

  async testConnection(creds: unknown): Promise<{ ok: boolean; detail?: string }> {
    const c = creds as StripeCreds;
    try {
      await stripeFetch('/v1/balance', { method: 'GET' }, c.secretKey);
      return { ok: true };
    } catch {
      return { ok: false, detail: 'connection failed' };
    }
  },

  /* -------- mandate (recurring/auto-debit) ops — w13 -------- */
  supportsMandates: true,

  /**
   * Stripe mandate = a saved off-session payment method. We create a
   * Checkout Session in mode=setup (SetupIntent-consistent): the customer
   * opens the session URL once to authorize and save their card; the
   * resulting customer/payment_method pair (surfaced via webhook) becomes
   * the mandateRef ("cus_...:pm_...").
   */
  async createMandate(ctx: MandateCreateCtx, creds: unknown): Promise<MandateCreateResult> {
    const c = creds as StripeCreds;
    try {
      const params = new URLSearchParams();
      params.set('mode', 'setup');
      params.set('client_reference_id', ctx.customerRef);
      params.set('currency', ctx.currency.toLowerCase());
      if (ctx.email) params.set('customer_email', ctx.email);
      params.set('success_url', 'https://wa.commerce/mandate/success');
      params.set('cancel_url', 'https://wa.commerce/mandate/cancel');
      params.set('metadata[mandate]', 'true');
      params.set('metadata[customerRef]', ctx.customerRef);
      params.set('metadata[tenantId]', ctx.tenantId);
      for (const [k, v] of Object.entries(ctx.metadata ?? {})) {
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
          params.set(`metadata[${k}]`, String(v));
        }
      }
      const body = await stripeFetch(
        '/v1/checkout/sessions',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: params.toString(),
        },
        c.secretKey,
      );
      const url = body?.url;
      if (typeof url !== 'string' || !url) {
        return { ok: false, provider: 'stripe', error: 'no checkout session url' };
      }
      return {
        ok: true,
        mandateRef: typeof body?.id === 'string' ? body.id : undefined,
        authorizationUrl: url,
        instructions: 'Customer must open the authorization URL once to save their card for future debits.',
        provider: 'stripe',
      };
    } catch (e) {
      return { ok: false, provider: 'stripe', error: e instanceof Error ? e.message : 'error' };
    }
  },

  /**
   * Charge a saved payment method off-session. mandateRef encodes
   * "customerId:paymentMethodId". ctx.reference passes through verbatim as
   * metadata.reference. HTTP 402 (card declined) maps to status 'failed',
   * never throws.
   */
  async chargeMandate(ctx: MandateChargeCtx, creds: unknown): Promise<MandateChargeResult> {
    const c = creds as StripeCreds;
    const [customer, paymentMethod] = ctx.mandateRef.split(':');
    if (!customer || !paymentMethod) {
      return {
        ok: false,
        reference: ctx.reference,
        status: 'failed',
        provider: 'stripe',
        error: 'mandateRef must be "customerId:paymentMethodId"',
      };
    }
    try {
      const params = new URLSearchParams();
      params.set('amount', String(Math.round(ctx.amountCents)));
      params.set('currency', ctx.currency.toLowerCase());
      params.set('customer', customer);
      params.set('payment_method', paymentMethod);
      params.set('off_session', 'true');
      params.set('confirm', 'true');
      params.set('metadata[reference]', ctx.reference);
      for (const [k, v] of Object.entries(ctx.metadata ?? {})) {
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
          params.set(`metadata[${k}]`, String(v));
        }
      }
      const res = await fetch(`${BASE}/v1/payment_intents`, {
        method: 'POST',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: {
          Authorization: `Bearer ${c.secretKey}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params.toString(),
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 402) {
        // Card declined / requires action off-session — a clean failure.
        return {
          ok: false,
          reference: ctx.reference,
          status: 'failed',
          provider: 'stripe',
          error: body?.error?.message ?? 'card declined',
        };
      }
      if (!res.ok) {
        return {
          ok: false,
          reference: ctx.reference,
          status: 'failed',
          provider: 'stripe',
          error: body?.error?.message ?? `HTTP ${res.status}`,
        };
      }
      const s = String(body?.status ?? '').toLowerCase();
      const status: 'success' | 'pending' | 'failed' =
        s === 'succeeded' ? 'success' : s === 'canceled' ? 'failed' : 'pending';
      return {
        ok: status !== 'failed',
        reference: ctx.reference,
        status,
        provider: 'stripe',
      };
    } catch (e) {
      return {
        ok: false,
        reference: ctx.reference,
        status: 'failed',
        provider: 'stripe',
        error: e instanceof Error ? e.message : 'error',
      };
    }
  },

  /**
   * Best-effort revoke: detach the payment method so it can no longer be
   * charged. Failures are swallowed — callers mark the mandate revoked
   * locally regardless.
   */
  async revokeMandate(mandateRef: string, creds: unknown): Promise<{ ok: boolean }> {
    const c = creds as StripeCreds;
    const [, paymentMethod] = mandateRef.split(':');
    if (!paymentMethod) return { ok: false };
    try {
      await stripeFetch(
        `/v1/payment_methods/${encodeURIComponent(paymentMethod)}/detach`,
        { method: 'POST' },
        c.secretKey,
      );
      return { ok: true };
    } catch {
      return { ok: false };
    }
  },
};
