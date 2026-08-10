import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type {
  PaymentInitiateCtx,
  PaymentInitiateResult,
  PaymentProvider,
  WebhookNormalization,
} from './types';

const TIMEOUT_MS = 15_000;

export const customProviderConfigSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  baseUrl: z.string().url(),
  authStyle: z.enum(['bearer', 'basic', 'header']),
  authHeader: z.string().optional(),
  initiate: z.object({
    path: z.string().min(1),
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH']),
    bodyTemplate: z.string(),
    responseMapping: z.object({
      authorizationUrl: z.string().min(1),
      reference: z.string().optional(),
    }),
  }),
  status: z.object({
    path: z.string().min(1),
    mapping: z.object({
      status: z.string().min(1),
      amountCents: z.string().min(1),
    }),
  }),
  webhook: z.object({
    signatureHeader: z.string().min(1),
    algo: z.enum(['hmac-sha256', 'hmac-sha512']),
    secret: z.string().min(1),
    signatureEncoding: z.enum(['hex', 'base64']),
    referencePath: z.string().min(1),
    amountPath: z.string().min(1),
    metadataPath: z.string().optional(),
  }),
});

export type CustomProviderConfig = z.infer<typeof customProviderConfigSchema>;

/**
 * Safe dot-path extractor. Paths look like `$.data.link` or `data.link`.
 * Only plain identifier segments are followed — no eval, no prototype keys.
 */
export function extractPath(payload: unknown, path: string): unknown {
  const trimmed = path.startsWith('$.') ? path.slice(2) : path.startsWith('$') ? path.slice(1) : path;
  if (!trimmed) return undefined;
  let cur: unknown = payload;
  for (const seg of trimmed.split('.')) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(seg)) return undefined;
    if (seg === '__proto__' || seg === 'constructor' || seg === 'prototype') return undefined;
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (m, key: string) => (key in vars ? vars[key] : m));
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function templateVars(ctx: PaymentInitiateCtx): Record<string, string> {
  return {
    amountCents: String(ctx.amountCents),
    reference: ctx.reference,
    currency: ctx.currency,
    callbackUrl: ctx.callbackUrl ?? '',
    customerPhone: ctx.customer.phone,
    customerEmail: ctx.customer.email ?? '',
    metadataJson: JSON.stringify(ctx.metadata),
    tenantId: ctx.tenantId,
  };
}

export function createCustomProvider(rawConfig: unknown): PaymentProvider {
  const config = customProviderConfigSchema.parse(rawConfig);

  function authHeaders(creds: unknown): Record<string, string> {
    const c = creds as { apiKey?: string; secret?: string; token?: string };
    switch (config.authStyle) {
      case 'bearer':
        return { Authorization: `Bearer ${c.token ?? c.apiKey ?? ''}` };
      case 'basic':
        return { Authorization: `Basic ${Buffer.from(`${c.apiKey ?? ''}:${c.secret ?? ''}`).toString('base64')}` };
      case 'header':
        return { [config.authHeader ?? 'X-Api-Key']: String(c.apiKey ?? c.token ?? '') };
    }
  }

  async function call(path: string, init: RequestInit, creds: unknown): Promise<unknown> {
    const res = await fetch(`${config.baseUrl}${path}`, {
      ...init,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'Content-Type': 'application/json', ...authHeaders(creds), ...(init.headers ?? {}) },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${config.id} HTTP ${res.status}`);
    return body;
  }

  return {
    id: config.id,
    displayName: config.displayName,

    async initiate(ctx: PaymentInitiateCtx, creds: unknown): Promise<PaymentInitiateResult> {
      try {
        const body = await call(
          config.initiate.path,
          {
            method: config.initiate.method,
            body: renderTemplate(config.initiate.bodyTemplate, templateVars(ctx)),
          },
          creds,
        );
        const url = extractPath(body, config.initiate.responseMapping.authorizationUrl);
        const ref = config.initiate.responseMapping.reference
          ? extractPath(body, config.initiate.responseMapping.reference)
          : undefined;
        return {
          ok: typeof url === 'string' && url.length > 0,
          reference: typeof ref === 'string' && ref ? ref : ctx.reference,
          authorizationUrl: typeof url === 'string' ? url : undefined,
          provider: config.id,
        };
      } catch {
        return { ok: false, reference: ctx.reference, instructions: 'initiate failed', provider: config.id };
      }
    },

    verifyWebhook(headers: Record<string, string>, rawBody: string): WebhookNormalization {
      const fail: WebhookNormalization = { ok: false, reference: '', amountCents: 0, metadata: {} };
      const sig =
        headers[config.webhook.signatureHeader.toLowerCase()] ?? headers[config.webhook.signatureHeader];
      if (typeof sig !== 'string') return fail;
      const algo = config.webhook.algo === 'hmac-sha512' ? 'sha512' : 'sha256';
      const expected = createHmac(algo, config.webhook.secret)
        .update(rawBody)
        .digest(config.webhook.signatureEncoding);
      if (!safeEqual(sig, expected)) return fail;
      let payload: unknown;
      try {
        payload = JSON.parse(rawBody);
      } catch {
        return fail;
      }
      const reference = extractPath(payload, config.webhook.referencePath);
      const amountRaw = extractPath(payload, config.webhook.amountPath);
      const amount = typeof amountRaw === 'number' ? amountRaw : Number(amountRaw);
      if (typeof reference !== 'string' || !reference || !Number.isFinite(amount)) return fail;
      const metadata = config.webhook.metadataPath ? extractPath(payload, config.webhook.metadataPath) : undefined;
      return {
        ok: true,
        reference,
        amountCents: Math.round(amount),
        metadata: metadata && typeof metadata === 'object' ? (metadata as Record<string, unknown>) : {},
      };
    },

    async fetchStatus(reference: string, creds: unknown): Promise<{ status: 'pending' | 'success' | 'failed'; amountCents: number }> {
      const path = renderTemplate(config.status.path, { reference });
      const body = await call(path, { method: 'GET' }, creds);
      const rawStatus = String(extractPath(body, config.status.mapping.status) ?? '').toLowerCase();
      const status: 'pending' | 'success' | 'failed' =
        rawStatus === 'success' || rawStatus === 'successful' || rawStatus === 'paid' || rawStatus === 'complete'
          ? 'success'
          : rawStatus === 'failed' || rawStatus === 'expired' || rawStatus === 'cancelled' || rawStatus === 'canceled'
            ? 'failed'
            : 'pending';
      const amountRaw = extractPath(body, config.status.mapping.amountCents);
      const amount = typeof amountRaw === 'number' ? amountRaw : Number(amountRaw);
      return { status, amountCents: Number.isFinite(amount) ? Math.round(amount) : 0 };
    },

    async testConnection(creds: unknown): Promise<{ ok: boolean; detail?: string }> {
      try {
        await call(renderTemplate(config.status.path, { reference: '__probe__' }), { method: 'GET' }, creds);
        return { ok: true };
      } catch {
        return { ok: false, detail: 'connection failed' };
      }
    },
  };
}
