import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stripeProvider, type StripeCreds } from './stripe';

const creds: StripeCreds = { secretKey: 'sk_test_x', webhookSecret: 'whsec_test' };

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
  amountCents: 5000,
  currency: 'USD',
  reference: 'ref-str-1',
  metadata: { orderId: 'o9' },
  customer: { phone: '+15550001111', email: 'c@d.e' },
  callbackUrl: 'https://shop.example/done',
};

function sign(rawBody: string, ts = Math.floor(Date.now() / 1000)): string {
  const v1 = createHmac('sha256', creds.webhookSecret).update(`${ts}.${rawBody}`).digest('hex');
  return `t=${ts},v1=${v1}`;
}

afterEach(() => vi.unstubAllGlobals());

describe('stripe initiate', () => {
  it('posts form-encoded checkout session with reference + metadata', async () => {
    const spy = mockFetch(() => ({ body: { url: 'https://checkout.stripe.com/pay/cs_1' } }));
    const res = await stripeProvider.initiate(ctx, creds);
    expect(res.ok).toBe(true);
    expect(res.authorizationUrl).toBe('https://checkout.stripe.com/pay/cs_1');
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.stripe.com/v1/checkout/sessions');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/x-www-form-urlencoded');
    const p = new URLSearchParams(String(init.body));
    expect(p.get('mode')).toBe('payment');
    expect(p.get('client_reference_id')).toBe('ref-str-1');
    expect(p.get('line_items[0][price_data][unit_amount]')).toBe('5000');
    expect(p.get('line_items[0][price_data][currency]')).toBe('usd');
    expect(p.get('metadata[reference]')).toBe('ref-str-1');
    expect(p.get('metadata[orderId]')).toBe('o9');
    expect(p.get('customer_email')).toBe('c@d.e');
    expect(p.get('success_url')).toBe('https://shop.example/done');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk_test_x');
  });

  it('returns ok:false on API error', async () => {
    mockFetch(() => ({ status: 402, body: { error: {} } }));
    expect((await stripeProvider.initiate(ctx, creds)).ok).toBe(false);
  });
});

describe('stripe webhook', () => {
  const rawBody = JSON.stringify({
    type: 'checkout.session.completed',
    data: { object: { client_reference_id: 'ref-str-1', amount_total: 5000, metadata: { reference: 'ref-str-1', orderId: 'o9' } } },
  });

  it('accepts valid signature', () => {
    const r = stripeProvider.verifyWebhook({ 'stripe-signature': sign(rawBody) }, rawBody, creds);
    expect(r).toEqual({ ok: true, reference: 'ref-str-1', amountCents: 5000, metadata: { reference: 'ref-str-1', orderId: 'o9' } });
  });

  it('rejects bad signature (fail-closed)', () => {
    expect(stripeProvider.verifyWebhook({ 'stripe-signature': 't=1,v1=deadbeef' }, rawBody, creds).ok).toBe(false);
  });

  it('rejects tampered body', () => {
    const sig = sign(rawBody);
    const tampered = rawBody.replace('5000', '50');
    expect(stripeProvider.verifyWebhook({ 'stripe-signature': sig }, tampered, creds).ok).toBe(false);
  });

  it('rejects stale timestamp beyond tolerance', () => {
    const stale = Math.floor(Date.now() / 1000) - 600;
    expect(stripeProvider.verifyWebhook({ 'stripe-signature': sign(rawBody, stale) }, rawBody, creds).ok).toBe(false);
  });

  it('rejects missing header', () => {
    expect(stripeProvider.verifyWebhook({}, rawBody, creds).ok).toBe(false);
  });
});

describe('stripe fetchStatus', () => {
  it('maps paid to success', async () => {
    const spy = mockFetch(() => ({ body: { data: [{ payment_status: 'paid', amount_total: 5000 }] } }));
    expect(await stripeProvider.fetchStatus('ref-str-1', creds)).toEqual({ status: 'success', amountCents: 5000 });
    expect(String(spy.mock.calls[0][0])).toContain('client_reference_id=ref-str-1');
  });

  it('maps unpaid/expired/pending', async () => {
    mockFetch(() => ({ body: { data: [{ payment_status: 'unpaid', status: 'expired', amount_total: 100 }] } }));
    expect((await stripeProvider.fetchStatus('r', creds)).status).toBe('failed');
    mockFetch(() => ({ body: { data: [{ payment_status: 'unpaid', status: 'open', amount_total: 100 }] } }));
    expect((await stripeProvider.fetchStatus('r', creds)).status).toBe('pending');
  });
});

describe('stripe testConnection', () => {
  it('ok on balance fetch', async () => {
    mockFetch(() => ({ body: { available: [] } }));
    expect((await stripeProvider.testConnection(creds)).ok).toBe(true);
  });

  it('fails on 401', async () => {
    mockFetch(() => ({ status: 401, body: {} }));
    expect((await stripeProvider.testConnection(creds)).ok).toBe(false);
  });
});
