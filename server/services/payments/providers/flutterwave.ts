import { createHash, timingSafeEqual } from 'node:crypto';
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

export interface FlutterwaveCreds {
  secretKey: string;
  secretHash: string;
}

const BASE = 'https://api.flutterwave.com/v3';
const TIMEOUT_MS = 15_000;

function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

async function fwFetch(path: string, init: RequestInit, secretKey: string): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`flutterwave HTTP ${res.status}: ${body?.message ?? 'error'}`);
  }
  return body;
}

export const flutterwaveProvider: PaymentProvider = {
  id: 'flutterwave',
  displayName: 'Flutterwave',

  async initiate(ctx: PaymentInitiateCtx, creds: unknown): Promise<PaymentInitiateResult> {
    const c = creds as FlutterwaveCreds;
    try {
      const body = await fwFetch(
        '/payments',
        {
          method: 'POST',
          body: JSON.stringify({
            tx_ref: ctx.reference,
            amount: ctx.amountCents / 100,
            currency: ctx.currency,
            ...(ctx.callbackUrl ? { redirect_url: ctx.callbackUrl } : {}),
            customer: {
              phonenumber: ctx.customer.phone,
              ...(ctx.customer.email ? { email: ctx.customer.email } : {}),
            },
            meta: ctx.metadata,
          }),
        },
        c.secretKey,
      );
      const link = body?.data?.link;
      return {
        ok: typeof link === 'string' && link.length > 0,
        reference: ctx.reference,
        authorizationUrl: typeof link === 'string' ? link : undefined,
        provider: 'flutterwave',
      };
    } catch {
      return { ok: false, reference: ctx.reference, instructions: 'initiate failed', provider: 'flutterwave' };
    }
  },

  verifyWebhook(headers: Record<string, string>, rawBody: string, creds: unknown): WebhookNormalization {
    const c = creds as FlutterwaveCreds;
    const fail: WebhookNormalization = { ok: false, reference: '', amountCents: 0, metadata: {} };
    const hash = headers['verif-hash'] ?? headers['Verif-Hash'];
    if (typeof hash !== 'string' || !c.secretHash || !safeEqual(hash, c.secretHash)) return fail;
    let data: any;
    try {
      data = JSON.parse(rawBody)?.data;
    } catch {
      return fail;
    }
    const reference = data?.tx_ref ?? data?.txRef;
    const amount = typeof data?.amount === 'number' ? data.amount : Number(data?.amount);
    if (typeof reference !== 'string' || !reference || !Number.isFinite(amount)) return fail;
    return {
      ok: true,
      reference,
      amountCents: Math.round(amount * 100),
      metadata: (data?.meta && typeof data.meta === 'object' ? data.meta : {}) as Record<string, unknown>,
    };
  },

  async fetchStatus(reference: string, creds: unknown): Promise<{ status: 'pending' | 'success' | 'failed'; amountCents: number }> {
    const c = creds as FlutterwaveCreds;
    const body = await fwFetch(
      `/transactions/verify_by_reference?tx_ref=${encodeURIComponent(reference)}`,
      { method: 'GET' },
      c.secretKey,
    );
    const data = body?.data ?? {};
    const s = String(data.status ?? '').toLowerCase();
    const amount = typeof data.amount === 'number' ? data.amount : Number(data.amount);
    return {
      status: s === 'successful' ? 'success' : s === 'failed' ? 'failed' : 'pending',
      amountCents: Number.isFinite(amount) ? Math.round(amount * 100) : 0,
    };
  },

  async testConnection(creds: unknown): Promise<{ ok: boolean; detail?: string }> {
    const c = creds as FlutterwaveCreds;
    try {
      // Lightweight authenticated probe: verify a deliberately bogus reference.
      await fwFetch('/transactions/verify_by_reference?tx_ref=__probe__', { method: 'GET' }, c.secretKey);
      return { ok: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'error';
      // A 4xx with a Flutterwave payload still proves credentials reached the API.
      if (/HTTP 4\d\d/.test(msg) && !/401|403/.test(msg)) return { ok: true };
      return { ok: false, detail: 'connection failed' };
    }
  },

  /* -------- mandate (recurring/auto-debit) ops — w13 -------- */
  supportsMandates: true,

  /**
   * Flutterwave mandate = a card token obtained from a tokenized first
   * charge. We create a standard payment link carrying meta.mandate=true
   * (and meta.customerRef) so webhook handling can capture the card token
   * from the successful first charge; the customer authorizes at the link.
   */
  async createMandate(ctx: MandateCreateCtx, creds: unknown): Promise<MandateCreateResult> {
    const c = creds as FlutterwaveCreds;
    try {
      const reference = `mandate-${ctx.tenantId}-${ctx.customerRef}`;
      const body = await fwFetch(
        '/payments',
        {
          method: 'POST',
          body: JSON.stringify({
            tx_ref: reference,
            amount: (ctx.amountLimitCents ?? 100) / 100,
            currency: ctx.currency,
            customer: {
              ...(ctx.phone ? { phonenumber: ctx.phone } : {}),
              ...(ctx.email ? { email: ctx.email } : {}),
            },
            meta: {
              ...(ctx.metadata ?? {}),
              mandate: true,
              customerRef: ctx.customerRef,
              tokenize: true,
            },
          }),
        },
        c.secretKey,
      );
      const link = body?.data?.link;
      if (typeof link !== 'string' || !link) {
        return { ok: false, provider: 'flutterwave', error: 'no payment link' };
      }
      return {
        ok: true,
        mandateRef: reference,
        authorizationUrl: link,
        instructions: 'Customer must open the authorization URL once to tokenize their card for future debits.',
        provider: 'flutterwave',
      };
    } catch (e) {
      return { ok: false, provider: 'flutterwave', error: e instanceof Error ? e.message : 'error' };
    }
  },

  /**
   * Charge a stored card token (mandateRef) off-session via
   * /v3/tokenized-charges. ctx.reference passes through verbatim as tx_ref.
   */
  async chargeMandate(ctx: MandateChargeCtx, creds: unknown): Promise<MandateChargeResult> {
    const c = creds as FlutterwaveCreds;
    try {
      const metaEmail = ctx.metadata?.email;
      const body = await fwFetch(
        '/tokenized-charges',
        {
          method: 'POST',
          body: JSON.stringify({
            token: ctx.mandateRef,
            amount: ctx.amountCents / 100,
            currency: ctx.currency,
            tx_ref: ctx.reference,
            email: typeof metaEmail === 'string' && metaEmail ? metaEmail : 'customer@wa.commerce',
            ...(ctx.metadata ? { meta: ctx.metadata } : {}),
          }),
        },
        c.secretKey,
      );
      const s = String(body?.data?.status ?? '').toLowerCase();
      const status: 'success' | 'pending' | 'failed' =
        s === 'successful' ? 'success' : s === 'failed' ? 'failed' : 'pending';
      return {
        ok: status !== 'failed',
        reference: typeof body?.data?.tx_ref === 'string' ? body.data.tx_ref : ctx.reference,
        status,
        provider: 'flutterwave',
      };
    } catch (e) {
      return {
        ok: false,
        reference: ctx.reference,
        status: 'failed',
        provider: 'flutterwave',
        error: e instanceof Error ? e.message : 'error',
      };
    }
  },

  /**
   * Best-effort revoke: Flutterwave has no public token-revoke endpoint, so
   * revocation is local-status-only — callers mark the mandate revoked in
   * their own store and stop issuing tokenized charges against it.
   */
  async revokeMandate(_mandateRef: string, _creds: unknown): Promise<{ ok: boolean }> {
    return { ok: true };
  },
};
