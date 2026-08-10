/**
 * Payment provider registry (w11) — adapter registration + per-tenant
 * resolution with fallback.
 *
 * Adapters register once at module load (paystack + manual are built in).
 * getProviderForTenant returns the tenant's FULL enabled fallback chain,
 * ordered by priority DESC (higher priority first) then createdAt ASC —
 * callers try each entry in order until one succeeds.
 *
 * Credential security (w10): secretKey/webhookSecret are AES-256-GCM
 * encrypted at rest in payment_gateway_configs. Reads here decrypt via
 * decryptSecret (which passes legacy plaintext rows through unchanged, so
 * pre-encryption rows keep resolving). Writes go through
 * upsertTenantProviderConfig, which encrypts on write. Plaintext secrets
 * NEVER persist in the credentials jsonb column — only non-secret extras
 * (manual bank details, publicKey, etc.) live there.
 */
import { asc, desc, eq, and } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { getDb } from "../../../db";
import { paymentGatewayConfigs } from "../../../../drizzle/schema";
import { decryptSecret, encryptSecret } from "../../crypto/secrets";
import type { PaymentProvider } from "./types";
import { paystackProvider } from "./paystack";
import { manualProvider } from "./manual";
import { createCustomProvider } from "./customHttp";

const adapters = new Map<string, PaymentProvider>();

export function registerProvider(p: PaymentProvider): void {
  adapters.set(p.id, p);
}

export function listProviderAdapters(): { id: string; displayName: string }[] {
  return Array.from(adapters.values()).map((p) => ({ id: p.id, displayName: p.displayName }));
}

export function getProviderAdapter(id: string): PaymentProvider | undefined {
  return adapters.get(id);
}

export interface TenantProviderEntry {
  provider: PaymentProvider;
  creds: unknown;
  config: { priority: number };
}

/**
 * Resolve the tenant's enabled provider configs into an ordered fallback
 * chain. Rows whose provider has no registered adapter are skipped. Rows
 * flagged isActive=false (legacy) or enabled=false (w11) are skipped.
 */
export async function getProviderForTenant(tenantId: string): Promise<TenantProviderEntry[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db
    .select()
    .from(paymentGatewayConfigs)
    .where(and(eq(paymentGatewayConfigs.tenantId, tenantId), eq(paymentGatewayConfigs.isActive, true)))
    .orderBy(desc(paymentGatewayConfigs.priority), asc(paymentGatewayConfigs.createdAt));

  const chain: TenantProviderEntry[] = [];
  for (const row of rows) {
    if (row.enabled === false) continue;
    const extras =
      row.credentials && typeof row.credentials === "object"
        ? (row.credentials as Record<string, unknown>)
        : {};
    let provider = adapters.get(row.provider);
    if (!provider) {
      // Zero-code custom gateway (w11): a row whose provider id has no
      // built-in adapter can still resolve when its credentials jsonb carries
      // a declarative customHttp config (`credentials.customHttp`) whose id
      // matches the row provider. The built adapter is registered so the
      // unified webhook route (getProviderAdapter) resolves the same id.
      // Invalid configs fail closed — the row is skipped.
      const cfg = (extras as Record<string, unknown>).customHttp;
      if (cfg && typeof cfg === "object" && (cfg as Record<string, unknown>).id === row.provider) {
        try {
          provider = createCustomProvider(cfg);
          registerProvider(provider);
        } catch {
          provider = undefined;
        }
      }
    }
    if (!provider) continue;
    // decryptSecret passes legacy plaintext through unchanged.
    const secretKey = row.secretKey ? decryptSecret(row.secretKey) : undefined;
    const webhookSecret = row.webhookSecret ? decryptSecret(row.webhookSecret) : undefined;
    const creds: Record<string, unknown> = {
      ...extras,
      ...(secretKey ? { secretKey } : {}),
      ...(webhookSecret ? { webhookSecret } : {}),
      ...(row.publicKey ? { publicKey: row.publicKey } : {}),
      ...(row.callbackUrl ? { callbackUrl: row.callbackUrl } : {}),
    };
    chain.push({ provider, creds, config: { priority: row.priority ?? 0 } });
  }
  return chain;
}

/**
 * Upsert a tenant provider config, encrypting secret fields at rest (w10
 * encrypt-on-write). `creds.secretKey` / `creds.webhookSecret` go into the
 * encrypted text columns; all other creds fields are non-secret extras
 * stored in the credentials jsonb column. Backward compatible: rows keep
 * provider='paystack' etc. so legacy readers keep resolving them.
 */
export async function upsertTenantProviderConfig(opts: {
  tenantId: string;
  provider: string;
  creds: Record<string, unknown>;
  priority?: number;
  enabled?: boolean;
}): Promise<{ ok: boolean; id?: string }> {
  const db = await getDb();
  if (!db) return { ok: false };
  const { secretKey, webhookSecret, publicKey, callbackUrl, ...extras } = opts.creds;
  const encSecret = typeof secretKey === "string" && secretKey ? encryptSecret(secretKey) : null;
  const encWebhook = typeof webhookSecret === "string" && webhookSecret ? encryptSecret(webhookSecret) : null;
  const id = randomUUID();
  const values = {
    id,
    tenantId: opts.tenantId,
    provider: opts.provider,
    publicKey: typeof publicKey === "string" ? publicKey : null,
    secretKey: encSecret,
    webhookSecret: encWebhook,
    callbackUrl: typeof callbackUrl === "string" ? callbackUrl : null,
    isActive: true,
    enabled: opts.enabled ?? true,
    priority: opts.priority ?? 0,
    credentials: Object.keys(extras).length ? extras : null,
    metadata: null,
  };
  // No unique constraint exists on (tenantId, provider), so an ON CONFLICT
  // target would raise 42P10 — do the upsert manually: update the existing
  // row when one is present, insert otherwise.
  const [existing] = await db
    .select({ id: paymentGatewayConfigs.id })
    .from(paymentGatewayConfigs)
    .where(and(eq(paymentGatewayConfigs.tenantId, opts.tenantId), eq(paymentGatewayConfigs.provider, opts.provider)))
    .limit(1);
  if (existing) {
    await db
      .update(paymentGatewayConfigs)
      .set({
        publicKey: values.publicKey,
        secretKey: values.secretKey,
        webhookSecret: values.webhookSecret,
        callbackUrl: values.callbackUrl,
        isActive: true,
        enabled: values.enabled,
        priority: values.priority,
        credentials: values.credentials,
        updatedAt: new Date(),
      })
      .where(eq(paymentGatewayConfigs.id, existing.id));
    return { ok: true, id: existing.id };
  }
  await db.insert(paymentGatewayConfigs).values(values);
  return { ok: true, id };
}

// Built-in adapters — registered at module load so every import site gets
// the full registry.
registerProvider(paystackProvider);
registerProvider(manualProvider);
