import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCustomProvider, customProviderConfigSchema, extractPath } from './customHttp';

function mockFetch(impl: (url: string, init: RequestInit) => { status?: number; body: unknown }) {
  const spy = vi.fn(async (url: any, init: any) => {
    const { status = 200, body } = impl(String(url), init as RequestInit);
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

afterEach(() => vi.unstubAllGlobals());

const ctx = {
  tenantId: 't1',
  amountCents: 75000,
  currency: 'NGN',
  reference: 'cref-1',
  metadata: { shop: 's1', items: [1, 2] },
  customer: { phone: '+234805', email: 'x@y.z' },
  callbackUrl: 'https://cb.example/x',
};

// Fictional "AfriPay" gateway — realistic declarative config.
const afripay = {
  id: 'afripay',
  displayName: 'AfriPay',
  baseUrl: 'https://api.afripay.example',
  authStyle: 'bearer' as const,
  initiate: {
    path: '/v1/charges',
    method: 'POST' as const,
    bodyTemplate:
      '{"amount_minor":{{amountCents}},"currency":"{{currency}}","ref":"{{reference}}","redirect":"{{callbackUrl}}","phone":"{{customerPhone}}","email":"{{customerEmail}}","meta":{{metadataJson}}}',
    responseMapping: { authorizationUrl: '$.data.hosted_url', reference: '$.data.ref' },
  },
  status: {
    path: '/v1/charges/{{reference}}',
    mapping: { status: '$.charge.state', amountCents: '$.charge.amount_minor' },
  },
  webhook: {
    signatureHeader: 'x-afripay-sig',
    algo: 'hmac-sha256' as const,
    secret: 'afri-whsec',
    signatureEncoding: 'hex' as const,
    referencePath: '$.payload.ref',
    amountPath: '$.payload.amount_minor',
    metadataPath: '$.payload.meta',
  },
};

describe('factory config validation', () => {
  it('accepts the valid AfriPay config', () => {
    expect(customProviderConfigSchema.parse(afripay).id).toBe('afripay');
  });

  it('rejects missing fields / bad enums', () => {
    expect(() => createCustomProvider({})).toThrow();
    expect(() => createCustomProvider({ ...afripay, authStyle: 'cookie' })).toThrow();
    expect(() => createCustomProvider({ ...afripay, baseUrl: 'not-a-url' })).toThrow();
    expect(() => createCustomProvider({ ...afripay, webhook: { ...afripay.webhook, algo: 'md5' } })).toThrow();
  });
});

describe('dot-path extractor', () => {
  const payload = { data: { link: 'https://x', deep: { n: 5 } }, list: [1] };
  it('extracts nested values with $ prefix or without', () => {
    expect(extractPath(payload, '$.data.link')).toBe('https://x');
    expect(extractPath(payload, 'data.deep.n')).toBe(5);
  });
  it('returns undefined for missing paths, safely', () => {
    expect(extractPath(payload, '$.data.missing.deeper')).toBeUndefined();
    expect(extractPath(null, '$.a.b')).toBeUndefined();
    expect(extractPath(payload, '$')).toBeUndefined();
  });
  it('blocks prototype-polluting segments and invalid identifiers', () => {
    expect(extractPath(payload, '$.__proto__.polluted')).toBeUndefined();
    expect(extractPath(payload, '$.constructor')).toBeUndefined();
    expect(extractPath(payload, '$.data[0]')).toBeUndefined();
  });
});

describe('initiate template substitution', () => {
  it('renders all placeholders incl. metadataJson and maps response', async () => {
    const spy = mockFetch(() => ({ body: { data: { hosted_url: 'https://pay.afripay.example/1', ref: 'cref-1' } } }));
    const p = createCustomProvider(afripay);
    const res = await p.initiate(ctx, { token: 'btok' });
    expect(res.ok).toBe(true);
    expect(res.authorizationUrl).toBe('https://pay.afripay.example/1');
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.afripay.example/v1/charges');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer btok');
    const sent = JSON.parse(String(init.body));
    expect(sent.amount_minor).toBe(75000);
    expect(sent.ref).toBe('cref-1');
    expect(sent.redirect).toBe('https://cb.example/x');
    expect(sent.phone).toBe('+234805');
    expect(sent.email).toBe('x@y.z');
    expect(sent.meta).toEqual({ shop: 's1', items: [1, 2] });
  });

  it('returns ok:false when authorizationUrl path missing in response', async () => {
    mockFetch(() => ({ body: { data: {} } }));
    expect((await createCustomProvider(afripay).initiate(ctx, {})).ok).toBe(false);
  });
});

describe('webhook HMAC verification', () => {
  const rawBody = JSON.stringify({ payload: { ref: 'cref-1', amount_minor: 75000, meta: { a: 'b' } } });
  const p = createCustomProvider(afripay);

  it('accepts valid hmac-sha256 hex', () => {
    const sig = createHmac('sha256', 'afri-whsec').update(rawBody).digest('hex');
    expect(p.verifyWebhook({ 'x-afripay-sig': sig }, rawBody, {})).toEqual({
      ok: true, reference: 'cref-1', amountCents: 75000, metadata: { a: 'b' },
    });
  });

  it('supports hmac-sha512 + base64', () => {
    const cfg = { ...afripay, id: 'afri512', webhook: { ...afripay.webhook, algo: 'hmac-sha512' as const, signatureEncoding: 'base64' as const } };
    const p512 = createCustomProvider(cfg);
    const sig = createHmac('sha512', 'afri-whsec').update(rawBody).digest('base64');
    const r = p512.verifyWebhook({ 'x-afripay-sig': sig }, rawBody, {});
    expect(r.ok).toBe(true);
    expect(r.amountCents).toBe(75000);
  });

  it('rejects bad/missing signatures (fail-closed)', () => {
    expect(p.verifyWebhook({ 'x-afripay-sig': 'nope' }, rawBody, {}).ok).toBe(false);
    expect(p.verifyWebhook({}, rawBody, {}).ok).toBe(false);
  });

  it('rejects tampered body', () => {
    const sig = createHmac('sha256', 'afri-whsec').update(rawBody).digest('hex');
    expect(p.verifyWebhook({ 'x-afripay-sig': sig }, rawBody.replace('75000', '75'), {}).ok).toBe(false);
  });

  it('uses constant-time comparison in source', () => {
    const src = readFileSync(join(__dirname, 'customHttp.ts'), 'utf8');
    expect(src).toContain('timingSafeEqual');
  });
});

describe('status mapping + end-to-end round-trip', () => {
  it('maps success/pending/failed and templates the reference into the path', async () => {
    const spy = mockFetch((url) => {
      if (url.includes('ok-ref')) return { body: { charge: { state: 'success', amount_minor: 75000 } } };
      if (url.includes('wait-ref')) return { body: { charge: { state: 'processing', amount_minor: 100 } } };
      return { body: { charge: { state: 'failed', amount_minor: 5 } } };
    });
    const p = createCustomProvider(afripay);
    expect(await p.fetchStatus('ok-ref', {})).toEqual({ status: 'success', amountCents: 75000 });
    expect((await p.fetchStatus('wait-ref', {})).status).toBe('pending');
    expect((await p.fetchStatus('bad-ref', {})).status).toBe('failed');
    expect(String(spy.mock.calls[0][0])).toBe('https://api.afripay.example/v1/charges/ok-ref');
  });

  it('AfriPay full round-trip: initiate -> webhook -> status', async () => {
    mockFetch((url) =>
      url.includes('/v1/charges/cref-9')
        ? { body: { charge: { state: 'paid', amount_minor: 75000 } } }
        : { body: { data: { hosted_url: 'https://pay.afripay.example/9', ref: 'cref-9' } } },
    );
    const p = createCustomProvider(afripay);
    const init = await p.initiate({ ...ctx, reference: 'cref-9' }, { token: 'btok' });
    expect(init.ok).toBe(true);
    const wh = JSON.stringify({ payload: { ref: 'cref-9', amount_minor: 75000 } });
    const sig = createHmac('sha256', 'afri-whsec').update(wh).digest('hex');
    expect(p.verifyWebhook({ 'x-afripay-sig': sig }, wh, {}).ok).toBe(true);
    expect(await p.fetchStatus('cref-9', { token: 'btok' })).toEqual({ status: 'success', amountCents: 75000 });
  });

  it('supports basic and header auth styles', async () => {
    const spy = mockFetch(() => ({ body: { charge: { state: 'success', amount_minor: 1 } } }));
    const basic = createCustomProvider({ ...afripay, id: 'a1', authStyle: 'basic' });
    await basic.fetchStatus('r', { apiKey: 'u', secret: 'p' });
    expect((spy.mock.calls[0][1] as RequestInit).headers).toMatchObject({
      Authorization: `Basic ${Buffer.from('u:p').toString('base64')}`,
    });
    const hdr = createCustomProvider({ ...afripay, id: 'a2', authStyle: 'header', authHeader: 'X-Key' });
    await hdr.fetchStatus('r', { apiKey: 'k9' });
    expect((spy.mock.calls[1][1] as RequestInit).headers).toMatchObject({ 'X-Key': 'k9' });
  });
});

describe('testConnection', () => {
  it('ok when status endpoint reachable, fail otherwise', async () => {
    mockFetch(() => ({ body: {} }));
    expect((await createCustomProvider(afripay).testConnection({})).ok).toBe(true);
    mockFetch(() => ({ status: 500, body: {} }));
    expect((await createCustomProvider(afripay).testConnection({})).ok).toBe(false);
  });
});
