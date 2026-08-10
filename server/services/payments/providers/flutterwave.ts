import { createHash, timingSafeEqual } from 'node:crypto';
import type {
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
};
