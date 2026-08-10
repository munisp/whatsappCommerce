import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __clearMonnifyTokenCache, monnifyProvider, type MonnifyCreds } from './monnify';

const creds: MonnifyCreds = { apiKey: 'MK_TEST', secretKey: 'sekret', contractCode: 'CC1' };

function mockFetch(impl: (url: string, init: RequestInit) => { status?: number; body: unknown }) {
  const spy = vi.fn(async (url: any, init: any) => {
    const { status = 200, body } = impl(String(url), init as RequestInit);
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

const loginBody = { responseBody: { accessToken: 'tok-1', expiresIn: 3600 } };
const ctx = {
  tenantId: 't1',
  amountCents: 150000,
  currency: 'NGN',
  reference: 'mref-1',
  metadata: { cart: 'c1' },
  customer: { phone: '+2348011112222', email: 'm@n.o' },
  callbackUrl: 'https://shop.example/mcb',
};

beforeEach(() => __clearMonnifyTokenCache());
afterEach(() => vi.unstubAllGlobals());

describe('monnify auth + initiate', () => {
  it('logs in with basic auth then posts init-transaction', async () => {
    const spy = mockFetch((url) =>
      url.includes('/auth/login')
        ? { body: loginBody }
        : { body: { responseBody: { checkoutUrl: 'https://checkout.monnify.com/x' } } },
    );
    const res = await monnifyProvider.initiate(ctx, creds);
    expect(res.ok).toBe(true);
    expect(res.authorizationUrl).toBe('https://checkout.monnify.com/x');
    expect(spy).toHaveBeenCalledTimes(2);
    const [loginUrl, loginInit] = spy.mock.calls[0] as [string, RequestInit];
    expect(loginUrl).toBe('https://api.monnify.com/api/v1/auth/login');
    expect((loginInit.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from('MK_TEST:sekret').toString('base64')}`,
    );
    const [initUrl, initInit] = spy.mock.calls[1] as [string, RequestInit];
    expect(initUrl).toContain('/api/v1/merchant/transactions/init-transaction');
    expect((initInit.headers as Record<string, string>).Authorization).toBe('Bearer tok-1');
    const body = JSON.parse(String(initInit.body));
    expect(body.amount).toBe(1500);
    expect(body.paymentReference).toBe('mref-1');
    expect(body.currencyCode).toBe('NGN');
    expect(body.contractCode).toBe('CC1');
    expect(body.metaData).toEqual({ cart: 'c1' });
  });

  it('caches token across calls (single login)', async () => {
    const spy = mockFetch((url) =>
      url.includes('/auth/login') ? { body: loginBody } : { body: { responseBody: { checkoutUrl: 'u' } } },
    );
    await monnifyProvider.initiate(ctx, creds);
    await monnifyProvider.initiate(ctx, creds);
    const logins = spy.mock.calls.filter(([u]) => String(u).includes('/auth/login'));
    expect(logins).toHaveLength(1);
  });

  it('returns ok:false when init fails', async () => {
    mockFetch((url) => (url.includes('/auth/login') ? { body: loginBody } : { status: 500, body: {} }));
    expect((await monnifyProvider.initiate(ctx, creds)).ok).toBe(false);
  });
});

describe('monnify webhook', () => {
  const rawBody = JSON.stringify({ eventData: { paymentReference: 'mref-1', amountPaid: 1500, metaData: { a: 1 } } });
  const goodSig = () => createHmac('sha512', creds.secretKey).update(rawBody).digest('hex');

  it('accepts valid HMAC-SHA512 signature', () => {
    const r = monnifyProvider.verifyWebhook({ 'monnify-signature': goodSig() }, rawBody, creds);
    expect(r).toEqual({ ok: true, reference: 'mref-1', amountCents: 150000, metadata: { a: 1 } });
  });

  it('rejects bad signature (fail-closed)', () => {
    expect(monnifyProvider.verifyWebhook({ 'monnify-signature': 'abc123' }, rawBody, creds).ok).toBe(false);
  });

  it('rejects tampered body', () => {
    const sig = goodSig();
    expect(monnifyProvider.verifyWebhook({ 'monnify-signature': sig }, rawBody.replace('1500', '15'), creds).ok).toBe(false);
  });

  it('rejects missing header', () => {
    expect(monnifyProvider.verifyWebhook({}, rawBody, creds).ok).toBe(false);
  });
});

describe('monnify fetchStatus', () => {
  it('maps PAID to success with correct path', async () => {
    const spy = mockFetch((url) =>
      url.includes('/auth/login') ? { body: loginBody } : { body: { responseBody: { paymentStatus: 'PAID', amountPaid: 1500 } } },
    );
    expect(await monnifyProvider.fetchStatus('mref-1', creds)).toEqual({ status: 'success', amountCents: 150000 });
    expect(String(spy.mock.calls[1][0])).toContain('/api/v2/transactions/mref-1');
  });

  it('maps pending and failed', async () => {
    mockFetch((url) => (url.includes('/auth/login') ? { body: loginBody } : { body: { responseBody: { paymentStatus: 'PENDING', amountPaid: 1 } } }));
    expect((await monnifyProvider.fetchStatus('r', creds)).status).toBe('pending');
    mockFetch(() => ({ body: { responseBody: { paymentStatus: 'EXPIRED', amountPaid: 1 } } }));
    expect((await monnifyProvider.fetchStatus('r', creds)).status).toBe('failed');
  });
});

describe('monnify testConnection', () => {
  it('ok when login succeeds', async () => {
    mockFetch(() => ({ body: loginBody }));
    expect((await monnifyProvider.testConnection(creds)).ok).toBe(true);
  });

  it('fails when login rejected', async () => {
    mockFetch(() => ({ status: 401, body: {} }));
    expect((await monnifyProvider.testConnection(creds)).ok).toBe(false);
  });
});
