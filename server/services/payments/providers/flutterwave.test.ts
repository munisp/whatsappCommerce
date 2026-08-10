import { afterEach, describe, expect, it, vi } from 'vitest';
import { flutterwaveProvider, type FlutterwaveCreds } from './flutterwave';

const creds: FlutterwaveCreds = { secretKey: 'flwsec_test', secretHash: 'myhash123' };

function mockFetch(impl: (url: string, init: RequestInit) => { status?: number; body: unknown }) {
  const spy = vi.fn(async (url: any, init: any) => {
    const { status = 200, body } = impl(String(url), init as RequestInit);
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

const ctx = {
  tenantId: 't1',
  amountCents: 250000,
  currency: 'NGN',
  reference: 'ref-abc',
  metadata: { orderId: 'o1' },
  customer: { phone: '+2348000000000', email: 'a@b.c' },
  callbackUrl: 'https://shop.example/cb',
};

afterEach(() => vi.unstubAllGlobals());

describe('flutterwave initiate', () => {
  it('posts correct payload and returns checkout link', async () => {
    const spy = mockFetch(() => ({ body: { status: 'success', data: { link: 'https://checkout.flw/pay/x' } } }));
    const res = await flutterwaveProvider.initiate(ctx, creds);
    expect(res.ok).toBe(true);
    expect(res.authorizationUrl).toBe('https://checkout.flw/pay/x');
    expect(res.reference).toBe('ref-abc');
    expect(res.provider).toBe('flutterwave');
    const [url, init] = spy.mock.calls[0];
    expect(String(url)).toBe('https://api.flutterwave.com/v3/payments');
    expect((init as RequestInit).method).toBe('POST');
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body.tx_ref).toBe('ref-abc');
    expect(body.amount).toBe(2500);
    expect(body.currency).toBe('NGN');
    expect(body.redirect_url).toBe('https://shop.example/cb');
    expect(body.customer.phonenumber).toBe('+2348000000000');
    expect(body.customer.email).toBe('a@b.c');
    expect(body.meta).toEqual({ orderId: 'o1' });
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer flwsec_test' });
  });

  it('returns ok:false when API errors', async () => {
    mockFetch(() => ({ status: 400, body: { message: 'bad' } }));
    const res = await flutterwaveProvider.initiate(ctx, creds);
    expect(res.ok).toBe(false);
  });
});

describe('flutterwave webhook', () => {
  const payload = JSON.stringify({ data: { tx_ref: 'ref-abc', amount: 2500, meta: { k: 'v' } } });

  it('accepts valid verif-hash', () => {
    const r = flutterwaveProvider.verifyWebhook({ 'verif-hash': 'myhash123' }, payload, creds);
    expect(r).toEqual({ ok: true, reference: 'ref-abc', amountCents: 250000, metadata: { k: 'v' } });
  });

  it('rejects wrong hash (fail-closed)', () => {
    const r = flutterwaveProvider.verifyWebhook({ 'verif-hash': 'wronghash' }, payload, creds);
    expect(r.ok).toBe(false);
  });

  it('rejects missing header', () => {
    expect(flutterwaveProvider.verifyWebhook({}, payload, creds).ok).toBe(false);
  });

  it('rejects tampered body with valid header but malformed payload', () => {
    expect(flutterwaveProvider.verifyWebhook({ 'verif-hash': 'myhash123' }, '{"data":{"amount":"x"}}', creds).ok).toBe(false);
  });
});

describe('flutterwave fetchStatus', () => {
  it('maps successful', async () => {
    const spy = mockFetch(() => ({ body: { data: { status: 'successful', amount: 2500 } } }));
    const r = await flutterwaveProvider.fetchStatus('ref-abc', creds);
    expect(r).toEqual({ status: 'success', amountCents: 250000 });
    expect(String(spy.mock.calls[0][0])).toContain('/transactions/verify_by_reference?tx_ref=ref-abc');
  });

  it('maps pending and failed', async () => {
    mockFetch(() => ({ body: { data: { status: 'pending', amount: 10 } } }));
    expect((await flutterwaveProvider.fetchStatus('r', creds)).status).toBe('pending');
    mockFetch(() => ({ body: { data: { status: 'failed', amount: 10 } } }));
    expect((await flutterwaveProvider.fetchStatus('r', creds)).status).toBe('failed');
  });
});

describe('flutterwave testConnection', () => {
  it('ok on reachable API', async () => {
    mockFetch(() => ({ status: 404, body: { message: 'not found' } }));
    expect((await flutterwaveProvider.testConnection(creds)).ok).toBe(true);
  });

  it('fails on 401', async () => {
    mockFetch(() => ({ status: 401, body: { message: 'unauthorized' } }));
    const r = await flutterwaveProvider.testConnection(creds);
    expect(r.ok).toBe(false);
    expect(r.detail).toBe('connection failed');
  });
});
