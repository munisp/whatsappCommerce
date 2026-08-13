import { createHmac, timingSafeEqual } from 'node:crypto';
import type {
  PaymentInitiateCtx,
  PaymentInitiateResult,
  PaymentProvider,
  WebhookNormalization,
} from './types';

export interface MonnifyCreds {
  apiKey: string;
  secretKey: string;
  contractCode?: string;
  baseUrl?: string;
}

const DEFAULT_BASE = 'https://api.monnify.com';
const TIMEOUT_MS = 15_000;
// Refresh the bearer token a minute before its stated expiry.
const EXPIRY_SKEW_MS = 60_000;

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

interface TokenEntry {
  token: string;
  expiresAt: number;
}
const tokenCache = new Map<string, TokenEntry>();

async function monnifyFetch(
  path: string,
  init: RequestInit,
  headers: Record<string, string>,
  baseUrl: string,
): Promise<any> {
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { 'Content-Type': 'application/json', ...headers, ...(init.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`monnify HTTP ${res.status}`);
  }
  return body;
}

async function getToken(c: MonnifyCreds, baseUrl: string): Promise<string> {
  const cacheKey = createHmac('sha256', 'monnify-cache').update(`${c.apiKey}:${c.secretKey}`).digest('hex');
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + EXPIRY_SKEW_MS) return cached.token;
  const basic = Buffer.from(`${c.apiKey}:${c.secretKey}`).toString('base64');
  const body = await monnifyFetch(
    '/api/v1/auth/login',
    { method: 'POST', body: '{}' },
    { Authorization: `Basic ${basic}` },
    baseUrl,
  );
  const token = body?.responseBody?.accessToken;
  if (typeof token !== 'string' || !token) throw new Error('monnify auth failed');
  const expiresIn = typeof body?.responseBody?.expiresIn === 'number' ? body.responseBody.expiresIn : 3600;
  tokenCache.set(cacheKey, { token, expiresAt: Date.now() + expiresIn * 1000 });
  return token;
}

export const monnifyProvider: PaymentProvider = {
  id: 'monnify',
  displayName: 'Monnify',
  // No recurring/auto-debit mandate support (w13).
  supportsMandates: false,

  async initiate(ctx: PaymentInitiateCtx, creds: unknown): Promise<PaymentInitiateResult> {
    const c = creds as MonnifyCreds;
    const baseUrl = c.baseUrl ?? DEFAULT_BASE;
    try {
      const token = await getToken(c, baseUrl);
      const body = await monnifyFetch(
        '/api/v1/merchant/transactions/init-transaction',
        {
          method: 'POST',
          body: JSON.stringify({
            amount: ctx.amountCents / 100,
            customerName: ctx.customer.phone,
            customerEmail: ctx.customer.email ?? `${ctx.customer.phone.replace(/\D/g, '')}@whatsapp.local`,
            paymentReference: ctx.reference,
            paymentDescription: 'Payment',
            currencyCode: ctx.currency,
            ...(c.contractCode ? { contractCode: c.contractCode } : {}),
            ...(ctx.callbackUrl ? { redirectUrl: ctx.callbackUrl } : {}),
            metaData: ctx.metadata,
          }),
        },
        { Authorization: `Bearer ${token}` },
        baseUrl,
      );
      const url = body?.responseBody?.checkoutUrl;
      return {
        ok: typeof url === 'string' && url.length > 0,
        reference: ctx.reference,
        authorizationUrl: typeof url === 'string' ? url : undefined,
        provider: 'monnify',
      };
    } catch {
      return { ok: false, reference: ctx.reference, instructions: 'initiate failed', provider: 'monnify' };
    }
  },

  verifyWebhook(headers: Record<string, string>, rawBody: string, creds: unknown): WebhookNormalization {
    const c = creds as MonnifyCreds;
    const fail: WebhookNormalization = { ok: false, reference: '', amountCents: 0, metadata: {} };
    const sig = headers['monnify-signature'] ?? headers['Monnify-Signature'];
    if (typeof sig !== 'string' || !c.secretKey) return fail;
    const expected = createHmac('sha512', c.secretKey).update(rawBody).digest('hex');
    if (!safeEqual(sig, expected)) return fail;
    let data: any;
    try {
      data = JSON.parse(rawBody)?.eventData;
    } catch {
      return fail;
    }
    const reference = data?.paymentReference ?? data?.transactionReference;
    const amount = typeof data?.amountPaid === 'number' ? data.amountPaid : Number(data?.amountPaid);
    if (typeof reference !== 'string' || !reference || !Number.isFinite(amount)) return fail;
    return {
      ok: true,
      reference,
      amountCents: Math.round(amount * 100),
      metadata: (data?.metaData && typeof data.metaData === 'object' ? data.metaData : {}) as Record<string, unknown>,
    };
  },

  async fetchStatus(reference: string, creds: unknown): Promise<{ status: 'pending' | 'success' | 'failed'; amountCents: number }> {
    const c = creds as MonnifyCreds;
    const baseUrl = c.baseUrl ?? DEFAULT_BASE;
    const token = await getToken(c, baseUrl);
    const body = await monnifyFetch(
      `/api/v2/transactions/${encodeURIComponent(reference)}`,
      { method: 'GET' },
      { Authorization: `Bearer ${token}` },
      baseUrl,
    );
    const data = body?.responseBody ?? {};
    const s = String(data.paymentStatus ?? '').toUpperCase();
    const amount = typeof data.amountPaid === 'number' ? data.amountPaid : Number(data.amountPaid ?? data.amount);
    return {
      status: s === 'PAID' || s === 'SUCCESS' ? 'success' : s === 'FAILED' || s === 'EXPIRED' || s === 'CANCELLED' ? 'failed' : 'pending',
      amountCents: Number.isFinite(amount) ? Math.round(amount * 100) : 0,
    };
  },

  async testConnection(creds: unknown): Promise<{ ok: boolean; detail?: string }> {
    const c = creds as MonnifyCreds;
    try {
      await getToken(c, c.baseUrl ?? DEFAULT_BASE);
      return { ok: true };
    } catch {
      return { ok: false, detail: 'connection failed' };
    }
  },
};

/** Test-only hook: clear cached bearer tokens. */
export function __clearMonnifyTokenCache(): void {
  tokenCache.clear();
}
