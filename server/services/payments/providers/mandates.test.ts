/**
 * w13 mandate (recurring/auto-debit) tests — every adapter's mandate ops
 * with mocked fetch (success/pending/failed/402 paths), supportsMandates
 * flags, getMandateCapableProviders filtering, reference passthrough, and
 * error mapping that NEVER throws.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { paystackProvider, type PaystackCreds } from './paystack';
import { flutterwaveProvider, type FlutterwaveCreds } from './flutterwave';
import { stripeProvider, type StripeCreds } from './stripe';
import { monnifyProvider } from './monnify';
import { manualProvider } from './manual';
import { createCustomProvider } from './customHttp';
import { registerAdapterPack } from './registerAll';

// ── Registry db mock (rows swapped per test) ────────────────────────────────
let configRows: any[] = [];
vi.mock('../../../db', () => ({
  getDb: async () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: async () =>
            [...configRows].sort(
              (a, b) =>
                (b.priority ?? 0) - (a.priority ?? 0) ||
                new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
            ),
          limit: async () => configRows.slice(0, 1),
        }),
      }),
    }),
  }),
}));

import { getMandateCapableProviders } from './registry';

const psCreds: PaystackCreds = { secretKey: 'sk_test_123' };
const fwCreds: FlutterwaveCreds = { secretKey: 'flwsec_test', secretHash: 'hash' };
const stCreds: StripeCreds = { secretKey: 'sk_live_x', webhookSecret: 'whsec_x' };

function mockFetch(impl: (url: string, init: RequestInit) => { status?: number; body: unknown }) {
  const spy = vi.fn(async (url: any, init: any) => {
    const { status = 200, body } = impl(String(url), init as RequestInit);
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

afterEach(() => {
  vi.unstubAllGlobals();
  configRows = [];
});

/* --------------------------------- paystack -------------------------------- */
describe('paystack mandates', () => {
  const createCtx = {
    tenantId: 't1',
    customerRef: 'cust-1',
    amountLimitCents: 500000,
    currency: 'NGN',
    email: 'c@x.y',
    metadata: { loanId: 'L1' },
  };

  it('declares supportsMandates and implements all mandate ops', () => {
    expect(paystackProvider.supportsMandates).toBe(true);
    expect(typeof paystackProvider.createMandate).toBe('function');
    expect(typeof paystackProvider.chargeMandate).toBe('function');
    expect(typeof paystackProvider.revokeMandate).toBe('function');
  });

  it('createMandate initializes a transaction with metadata.mandate=true', async () => {
    const spy = mockFetch(() => ({
      body: { status: true, data: { authorization_url: 'https://paystack.co/pay/x', reference: 'ref-m1' } },
    }));
    const res = await paystackProvider.createMandate!(createCtx, psCreds);
    expect(res.ok).toBe(true);
    expect(res.provider).toBe('paystack');
    expect(res.authorizationUrl).toBe('https://paystack.co/pay/x');
    expect(res.mandateRef).toBe('ref-m1');
    const [url, init] = spy.mock.calls[0];
    expect(String(url)).toBe('https://api.paystack.co/transaction/initialize');
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body.metadata.mandate).toBe(true);
    expect(body.metadata.customerRef).toBe('cust-1');
    expect(body.metadata.loanId).toBe('L1');
    expect(body.amount).toBe(500000);
    expect(body.email).toBe('c@x.y');
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer sk_test_123' });
  });

  it('createMandate fails closed on missing secretKey without throwing', async () => {
    const res = await paystackProvider.createMandate!(createCtx, {});
    expect(res.ok).toBe(false);
    expect(res.provider).toBe('paystack');
    expect(res.error).toBeTruthy();
  });

  it('createMandate maps HTTP error to ok:false', async () => {
    mockFetch(() => ({ status: 400, body: { status: false, message: 'bad' } }));
    const res = await paystackProvider.createMandate!(createCtx, psCreds);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('400');
  });

  it('createMandate fails when no authorization_url is returned', async () => {
    mockFetch(() => ({ body: { status: true, data: {} } }));
    const res = await paystackProvider.createMandate!(createCtx, psCreds);
    expect(res.ok).toBe(false);
  });

  it('createMandate maps network failure to ok:false, never throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('ECONNRESET'))));
    const res = await paystackProvider.createMandate!(createCtx, psCreds);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('ECONNRESET');
  });

  it('chargeMandate posts charge_authorization with reference passthrough (success)', async () => {
    const spy = mockFetch(() => ({
      body: { status: true, data: { status: 'success', reference: 'chg-1' } },
    }));
    const res = await paystackProvider.chargeMandate!(
      { mandateRef: 'AUTH_abc', amountCents: 12300, currency: 'NGN', reference: 'repay-42' },
      psCreds,
    );
    expect(res.ok).toBe(true);
    expect(res.status).toBe('success');
    expect(res.reference).toBe('chg-1');
    const [url, init] = spy.mock.calls[0];
    expect(String(url)).toBe('https://api.paystack.co/transaction/charge_authorization');
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body.authorization_code).toBe('AUTH_abc');
    expect(body.amount).toBe(12300);
    expect(body.reference).toBe('repay-42');
  });

  it('chargeMandate maps provider pending status', async () => {
    mockFetch(() => ({ body: { status: true, data: { status: 'pending', reference: 'chg-2' } } }));
    const res = await paystackProvider.chargeMandate!(
      { mandateRef: 'AUTH_abc', amountCents: 100, currency: 'NGN', reference: 'r1' },
      psCreds,
    );
    expect(res.ok).toBe(true);
    expect(res.status).toBe('pending');
    expect(res.reference).toBe('chg-2');
  });

  it('chargeMandate maps provider failed status to ok:false', async () => {
    mockFetch(() => ({ body: { status: true, data: { status: 'failed' } } }));
    const res = await paystackProvider.chargeMandate!(
      { mandateRef: 'AUTH_abc', amountCents: 100, currency: 'NGN', reference: 'r2' },
      psCreds,
    );
    expect(res.ok).toBe(false);
    expect(res.status).toBe('failed');
    expect(res.reference).toBe('r2');
  });

  it('chargeMandate maps API error message to failed result', async () => {
    mockFetch(() => ({ status: 400, body: { status: false, message: 'Invalid authorization' } }));
    const res = await paystackProvider.chargeMandate!(
      { mandateRef: 'AUTH_bad', amountCents: 100, currency: 'NGN', reference: 'r3' },
      psCreds,
    );
    expect(res.ok).toBe(false);
    expect(res.status).toBe('failed');
    expect(res.error).toBe('Invalid authorization');
  });

  it('chargeMandate maps network failure to failed result, never throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('timeout'))));
    const res = await paystackProvider.chargeMandate!(
      { mandateRef: 'AUTH_abc', amountCents: 100, currency: 'NGN', reference: 'r4' },
      psCreds,
    );
    expect(res.ok).toBe(false);
    expect(res.status).toBe('failed');
    expect(res.error).toContain('timeout');
  });

  it('chargeMandate fails closed on missing secretKey', async () => {
    const res = await paystackProvider.chargeMandate!(
      { mandateRef: 'AUTH_abc', amountCents: 100, currency: 'NGN', reference: 'r5' },
      {},
    );
    expect(res.ok).toBe(false);
    expect(res.status).toBe('failed');
  });

  it('revokeMandate is local-status-only and does not call the API', async () => {
    const spy = mockFetch(() => ({ body: {} }));
    const res = await paystackProvider.revokeMandate!('AUTH_abc', psCreds);
    expect(res.ok).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });
});

/* -------------------------------- flutterwave ------------------------------ */
describe('flutterwave mandates', () => {
  const createCtx = {
    tenantId: 't1',
    customerRef: 'cust-9',
    amountLimitCents: 250000,
    currency: 'NGN',
    email: 'f@x.y',
    phone: '+2348000000000',
  };

  it('declares supportsMandates and implements all mandate ops', () => {
    expect(flutterwaveProvider.supportsMandates).toBe(true);
    expect(typeof flutterwaveProvider.createMandate).toBe('function');
    expect(typeof flutterwaveProvider.chargeMandate).toBe('function');
    expect(typeof flutterwaveProvider.revokeMandate).toBe('function');
  });

  it('createMandate creates a tokenizing payment link', async () => {
    const spy = mockFetch(() => ({ body: { status: 'success', data: { link: 'https://flw.link/m' } } }));
    const res = await flutterwaveProvider.createMandate!(createCtx, fwCreds);
    expect(res.ok).toBe(true);
    expect(res.authorizationUrl).toBe('https://flw.link/m');
    expect(res.provider).toBe('flutterwave');
    const [url, init] = spy.mock.calls[0];
    expect(String(url)).toBe('https://api.flutterwave.com/v3/payments');
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body.meta.mandate).toBe(true);
    expect(body.meta.tokenize).toBe(true);
    expect(body.meta.customerRef).toBe('cust-9');
    expect(body.amount).toBe(2500);
  });

  it('createMandate maps API error to ok:false, never throws', async () => {
    mockFetch(() => ({ status: 400, body: { message: 'bad request' } }));
    const res = await flutterwaveProvider.createMandate!(createCtx, fwCreds);
    expect(res.ok).toBe(false);
    expect(res.error).toBeTruthy();
  });

  it('chargeMandate posts /v3/tokenized-charges with tx_ref passthrough (success)', async () => {
    const spy = mockFetch(() => ({
      body: { status: 'success', data: { status: 'successful', tx_ref: 'repay-7' } },
    }));
    const res = await flutterwaveProvider.chargeMandate!(
      { mandateRef: 'flw-tok-1', amountCents: 9900, currency: 'NGN', reference: 'repay-7' },
      fwCreds,
    );
    expect(res.ok).toBe(true);
    expect(res.status).toBe('success');
    expect(res.reference).toBe('repay-7');
    const [url, init] = spy.mock.calls[0];
    expect(String(url)).toBe('https://api.flutterwave.com/v3/tokenized-charges');
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body.token).toBe('flw-tok-1');
    expect(body.amount).toBe(99);
    expect(body.tx_ref).toBe('repay-7');
  });

  it('chargeMandate maps pending status', async () => {
    mockFetch(() => ({ body: { status: 'success', data: { status: 'pending', tx_ref: 'r8' } } }));
    const res = await flutterwaveProvider.chargeMandate!(
      { mandateRef: 'flw-tok-1', amountCents: 100, currency: 'NGN', reference: 'r8' },
      fwCreds,
    );
    expect(res.ok).toBe(true);
    expect(res.status).toBe('pending');
  });

  it('chargeMandate maps failed status to ok:false', async () => {
    mockFetch(() => ({ body: { status: 'success', data: { status: 'failed' } } }));
    const res = await flutterwaveProvider.chargeMandate!(
      { mandateRef: 'flw-tok-1', amountCents: 100, currency: 'NGN', reference: 'r9' },
      fwCreds,
    );
    expect(res.ok).toBe(false);
    expect(res.status).toBe('failed');
    expect(res.reference).toBe('r9');
  });

  it('chargeMandate maps HTTP/network errors to failed result, never throws', async () => {
    mockFetch(() => ({ status: 500, body: { message: 'server error' } }));
    const res = await flutterwaveProvider.chargeMandate!(
      { mandateRef: 'flw-tok-1', amountCents: 100, currency: 'NGN', reference: 'r10' },
      fwCreds,
    );
    expect(res.ok).toBe(false);
    expect(res.status).toBe('failed');
    expect(res.error).toBeTruthy();
  });

  it('revokeMandate is best-effort local-status-only', async () => {
    const spy = mockFetch(() => ({ body: {} }));
    const res = await flutterwaveProvider.revokeMandate!('flw-tok-1', fwCreds);
    expect(res.ok).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });
});

/* ---------------------------------- stripe --------------------------------- */
describe('stripe mandates', () => {
  const createCtx = {
    tenantId: 't1',
    customerRef: 'cust-2',
    currency: 'USD',
    email: 's@x.y',
  };

  it('declares supportsMandates and implements all mandate ops', () => {
    expect(stripeProvider.supportsMandates).toBe(true);
    expect(typeof stripeProvider.createMandate).toBe('function');
    expect(typeof stripeProvider.chargeMandate).toBe('function');
    expect(typeof stripeProvider.revokeMandate).toBe('function');
  });

  it('createMandate creates a Checkout Session in mode=setup', async () => {
    const spy = mockFetch(() => ({ body: { id: 'cs_setup_1', url: 'https://checkout.stripe.com/s' } }));
    const res = await stripeProvider.createMandate!(createCtx, stCreds);
    expect(res.ok).toBe(true);
    expect(res.authorizationUrl).toBe('https://checkout.stripe.com/s');
    expect(res.mandateRef).toBe('cs_setup_1');
    const [url, init] = spy.mock.calls[0];
    expect(String(url)).toBe('https://api.stripe.com/v1/checkout/sessions');
    const params = new URLSearchParams(String((init as RequestInit).body));
    expect(params.get('mode')).toBe('setup');
    expect(params.get('metadata[mandate]')).toBe('true');
    expect(params.get('metadata[customerRef]')).toBe('cust-2');
  });

  it('createMandate maps API failure to ok:false, never throws', async () => {
    mockFetch(() => ({ status: 400, body: { error: { message: 'bad' } } }));
    const res = await stripeProvider.createMandate!(createCtx, stCreds);
    expect(res.ok).toBe(false);
    expect(res.error).toBeTruthy();
  });

  it('chargeMandate posts off_session confirmed PaymentIntent (success)', async () => {
    const spy = mockFetch(() => ({ body: { id: 'pi_1', status: 'succeeded' } }));
    const res = await stripeProvider.chargeMandate!(
      { mandateRef: 'cus_1:pm_1', amountCents: 4200, currency: 'USD', reference: 'repay-9' },
      stCreds,
    );
    expect(res.ok).toBe(true);
    expect(res.status).toBe('success');
    expect(res.reference).toBe('repay-9');
    const [url, init] = spy.mock.calls[0];
    expect(String(url)).toBe('https://api.stripe.com/v1/payment_intents');
    const params = new URLSearchParams(String((init as RequestInit).body));
    expect(params.get('amount')).toBe('4200');
    expect(params.get('currency')).toBe('usd');
    expect(params.get('customer')).toBe('cus_1');
    expect(params.get('payment_method')).toBe('pm_1');
    expect(params.get('off_session')).toBe('true');
    expect(params.get('confirm')).toBe('true');
    expect(params.get('metadata[reference]')).toBe('repay-9');
  });

  it('chargeMandate maps HTTP 402 (card declined) to status failed', async () => {
    mockFetch(() => ({ status: 402, body: { error: { message: 'Your card was declined.' } } }));
    const res = await stripeProvider.chargeMandate!(
      { mandateRef: 'cus_1:pm_1', amountCents: 100, currency: 'USD', reference: 'r11' },
      stCreds,
    );
    expect(res.ok).toBe(false);
    expect(res.status).toBe('failed');
    expect(res.error).toBe('Your card was declined.');
  });

  it('chargeMandate maps processing status to pending', async () => {
    mockFetch(() => ({ body: { id: 'pi_2', status: 'processing' } }));
    const res = await stripeProvider.chargeMandate!(
      { mandateRef: 'cus_1:pm_1', amountCents: 100, currency: 'USD', reference: 'r12' },
      stCreds,
    );
    expect(res.ok).toBe(true);
    expect(res.status).toBe('pending');
  });

  it('chargeMandate rejects malformed mandateRef without calling the API', async () => {
    const spy = mockFetch(() => ({ body: {} }));
    const res = await stripeProvider.chargeMandate!(
      { mandateRef: 'bogus', amountCents: 100, currency: 'USD', reference: 'r13' },
      stCreds,
    );
    expect(res.ok).toBe(false);
    expect(res.status).toBe('failed');
    expect(res.error).toBeTruthy();
    expect(spy).not.toHaveBeenCalled();
  });

  it('chargeMandate maps network failure to failed result, never throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('ENETDOWN'))));
    const res = await stripeProvider.chargeMandate!(
      { mandateRef: 'cus_1:pm_1', amountCents: 100, currency: 'USD', reference: 'r14' },
      stCreds,
    );
    expect(res.ok).toBe(false);
    expect(res.status).toBe('failed');
    expect(res.error).toContain('ENETDOWN');
  });

  it('revokeMandate detaches the payment method; failure maps to ok:false', async () => {
    const spy = mockFetch(() => ({ body: { id: 'pm_1' } }));
    const res = await stripeProvider.revokeMandate!('cus_1:pm_1', stCreds);
    expect(res.ok).toBe(true);
    expect(String(spy.mock.calls[0][0])).toBe('https://api.stripe.com/v1/payment_methods/pm_1/detach');
    mockFetch(() => ({ status: 404, body: { error: { message: 'gone' } } }));
    const res2 = await stripeProvider.revokeMandate!('cus_1:pm_gone', stCreds);
    expect(res2.ok).toBe(false);
    expect((await stripeProvider.revokeMandate!('bogus', stCreds)).ok).toBe(false);
  });
});

/* --------------------- non-mandate adapters + registry --------------------- */
describe('non-mandate adapters declare supportsMandates=false', () => {
  it('monnify and manual opt out', () => {
    expect(monnifyProvider.supportsMandates).toBe(false);
    expect(manualProvider.supportsMandates).toBe(false);
    expect(monnifyProvider.createMandate).toBeUndefined();
    expect(manualProvider.createMandate).toBeUndefined();
  });

  it('customHttp declarative gateway opts out', () => {
    const p = createCustomProvider({
      id: 'custom-x',
      displayName: 'Custom X',
      baseUrl: 'https://gw.example',
      authStyle: 'bearer',
      initiate: {
        path: '/pay',
        method: 'POST',
        bodyTemplate: '{}',
        responseMapping: { authorizationUrl: '$.link' },
      },
      status: { path: '/s', mapping: { status: '$.s', amountCents: '$.a' } },
      webhook: {
        signatureHeader: 'x-sig',
        algo: 'hmac-sha256',
        secret: 's',
        signatureEncoding: 'hex',
        referencePath: '$.r',
        amountPath: '$.a',
      },
    });
    expect(p.supportsMandates).toBe(false);
    expect(p.createMandate).toBeUndefined();
  });
});

describe('getMandateCapableProviders', () => {
  function row(provider: string, priority: number) {
    return {
      id: `cfg-${provider}`,
      tenantId: 't1',
      provider,
      isActive: true,
      enabled: true,
      priority,
      createdAt: new Date('2024-01-01'),
      secretKey: null,
      webhookSecret: null,
      publicKey: null,
      callbackUrl: null,
      credentials: { secretKey: 'sk_x', secretHash: 'h', webhookSecret: 'w' },
      metadata: null,
    };
  }

  it('filters the tenant chain to mandate-capable adapters only', async () => {
    registerAdapterPack();
    configRows = [row('paystack', 10), row('manual', 20), row('stripe', 5)];
    const entries = await getMandateCapableProviders('t1');
    const ids = entries.map((e) => e.provider.id);
    expect(ids).toContain('paystack');
    expect(ids).toContain('stripe');
    expect(ids).not.toContain('manual');
    // Ordering follows the same priority DESC rule as getProviderForTenant.
    expect(ids.indexOf('paystack')).toBeLessThan(ids.indexOf('stripe'));
  });

  it('excludes adapters that flag support but lack implementations', async () => {
    configRows = [row('paystack', 1)];
    const entries = await getMandateCapableProviders('t1');
    expect(entries).toHaveLength(1);
    expect(typeof entries[0].provider.chargeMandate).toBe('function');
  });

  it('returns [] for a tenant with no mandate-capable config', async () => {
    configRows = [row('manual', 1)];
    expect(await getMandateCapableProviders('t1')).toEqual([]);
    configRows = [];
    expect(await getMandateCapableProviders('nobody')).toEqual([]);
  });
});
