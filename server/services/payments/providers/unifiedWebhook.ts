/**
 * Unified provider webhook handler (w11) — POST /api/webhooks/payments/:provider
 *
 * Additive route alongside the legacy /api/webhooks/paystack etc. (those stay
 * byte-identical until P3 migrates callers). Flow:
 *
 *   1. Resolve the adapter from the :provider path param.
 *   2. Resolve tenant creds from the intent/transaction metadata (tenant_id
 *      in webhook metadata, else reference lookup in paymentIntents /
 *      paymentTransactions). Legacy env PAYSTACK_* creds are a fallback so
 *      the route works before any tenant config rows exist.
 *   3. adapter.verifyWebhook(headers, rawBody, creds) — FAIL CLOSED: any
 *      non-ok normalization → 401 + captureException(warn), NEVER confirm.
 *   4. On ok, feed the normalized { reference, amountCents, metadata } into
 *      the EXISTING claim-first paymentConfirm entry point
 *      (confirmProviderPayment) exactly as the legacy webhooks do.
 */
import type { Request, Response } from "express";
import { eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { paymentIntents, paymentTransactions } from "../../../../drizzle/schema";
import { confirmProviderPayment } from "../../paymentConfirm";
import { captureException } from "../../observability";
import { getProviderAdapter, getProviderForTenant } from "./registry";

function toRawBodyString(body: unknown): string {
  if (Buffer.isBuffer(body)) return body.toString("utf8");
  if (typeof body === "string") return body;
  return JSON.stringify(body ?? {});
}

function normalizeHeaders(headers: Request["headers"]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (typeof v === "string") out[k] = v;
    else if (Array.isArray(v) && typeof v[0] === "string") out[k] = v[0];
  }
  return out;
}

function extractTenantId(payload: any): string | null {
  // Metadata containers per adapter body shape: paystack/custom data.metadata,
  // flutterwave data.meta, stripe data.object.metadata, monnify
  // eventData.metaData, customHttp payload.meta.
  const candidates = [
    payload?.data?.metadata,
    payload?.data?.meta,
    payload?.data?.object?.metadata,
    payload?.eventData?.metaData,
    payload?.payload?.meta,
    payload?.metadata,
  ];
  for (const meta of candidates) {
    if (meta && typeof meta === "object") {
      const t = (meta as Record<string, unknown>).tenant_id ?? (meta as Record<string, unknown>).tenantId;
      if (typeof t === "string" && t) return t;
    }
  }
  return null;
}

function extractReference(payload: any): string | null {
  // Reference fields per adapter body shape (see the adapters' verifyWebhook):
  // paystack data.reference, flutterwave data.tx_ref, stripe
  // data.object.client_reference_id / data.object.metadata.reference,
  // monnify eventData.paymentReference/transactionReference, customHttp
  // payload.ref.
  const candidates = [
    payload?.data?.reference,
    payload?.data?.tx_ref,
    payload?.data?.txRef,
    payload?.data?.object?.client_reference_id,
    payload?.data?.object?.metadata?.reference,
    payload?.eventData?.paymentReference,
    payload?.eventData?.transactionReference,
    payload?.payload?.ref,
    payload?.reference,
  ];
  for (const ref of candidates) {
    if (typeof ref === "string" && ref) return ref;
  }
  return null;
}

/** Look the reference up in the payment tables to recover the tenantId. */
async function resolveTenantIdByReference(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  reference: string,
): Promise<string | null> {
  const [intent] = await db
    .select({ tenantId: paymentIntents.tenantId })
    .from(paymentIntents)
    .where(eq(paymentIntents.providerPaymentId, reference))
    .limit(1);
  if (intent) return intent.tenantId;
  const [tx] = await db
    .select({ tenantId: paymentTransactions.tenantId })
    .from(paymentTransactions)
    .where(eq(paymentTransactions.providerRef, reference))
    .limit(1);
  return tx?.tenantId ?? null;
}

export async function handleUnifiedPaymentWebhook(req: Request, res: Response): Promise<void> {
  const providerId = String(req.params.provider ?? "");
  try {
    const adapter = getProviderAdapter(providerId);
    if (!adapter) {
      return void res.status(404).json({ error: "unknown-provider", provider: providerId });
    }
    const db = await getDb();
    if (!db) return void res.status(503).json({ error: "db-unavailable" });

    const rawBody = toRawBodyString(req.body);
    let payload: any = null;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      payload = null;
    }

    // ── Resolve tenant creds from intent/metadata ─────────────────────────
    let tenantId = payload ? extractTenantId(payload) : null;
    const reference = payload ? extractReference(payload) : null;
    if (!tenantId && reference) {
      tenantId = await resolveTenantIdByReference(db, reference);
    }

    let creds: unknown = null;
    if (tenantId) {
      const chain = await getProviderForTenant(tenantId);
      creds = chain.find((e) => e.provider.id === providerId)?.creds ?? null;
    }
    if (!creds && providerId === "paystack") {
      // Legacy fallback: platform-level env creds (pre-tenant-config rows).
      const secretKey = process.env.PAYSTACK_SECRET_KEY ?? "";
      const webhookSecret = process.env.PAYSTACK_WEBHOOK_SECRET ?? "";
      if (secretKey || webhookSecret) creds = { secretKey, webhookSecret };
    }
    if (!creds) {
      captureException(new Error(`payment webhook creds unresolved for provider=${providerId}`), {
        service: "unifiedPaymentWebhook",
        operation: "resolveCreds",
        tenantId: tenantId ?? undefined,
        severity: "warn",
        extra: { provider: providerId, reference },
      });
      return void res.status(401).json({ error: "provider-not-configured" });
    }

    // ── Verify + normalize (fail closed) ──────────────────────────────────
    const norm = adapter.verifyWebhook(normalizeHeaders(req.headers), rawBody, creds);
    if (!norm.ok) {
      captureException(new Error(`payment webhook rejected for provider=${providerId}`), {
        service: "unifiedPaymentWebhook",
        operation: "verifyWebhook",
        tenantId: tenantId ?? undefined,
        severity: "warn",
        extra: { provider: providerId, reference },
      });
      return void res.status(401).json({ error: "invalid-signature" });
    }

    // ── Feed the EXISTING claim-first confirm path ────────────────────────
    // Currency extraction mirrors the adapters' body shapes: paystack/
    // flutterwave put it at data.currency, stripe at data.object.currency,
    // monnify at eventData.currency, customHttp configs commonly nest under
    // payload.currency. A missing currency fails the confirm path's
    // amount/currency verification (fail closed) just like before.
    const currency =
      ((payload?.data?.currency ??
        payload?.data?.object?.currency ??
        payload?.eventData?.currency ??
        payload?.payload?.currency) as string | undefined) ?? null;
    const result = await confirmProviderPayment(db, {
      provider: providerId,
      reference: norm.reference,
      amountMajor: norm.amountCents / 100,
      currency,
      rawPayload: payload?.data ?? payload,
    });
    if (!result.ok) {
      console.warn(
        `[unified-payment-webhook] ${providerId} ref=${norm.reference} → ${result.action}${result.detail ? `: ${result.detail}` : ""}`,
      );
    }

    // === W31 AR webhook hook ===
    // After the pinned confirmProviderPayment verified + completed the
    // payment, record any AR-invoice payment keyed by this reference
    // (ar_invoices.payment_link_ref). Exactly-once (unique psp_reference),
    // never throws into the webhook ack.
    if (result.ok) {
      try {
        const { runArInvoiceWebhookHook } = await import("../../arInvoices");
        await runArInvoiceWebhookHook(db, { provider: providerId, reference: norm.reference });
      } catch (err: any) {
        console.warn(`[unified-payment-webhook] AR hook ${norm.reference}: ${err?.message}`);
      }
    }
    // === END W31 AR webhook hook ===

    // W23 (additive): a fresh webhook confirmation also lands on the
    // compliance audit trail — previously only the admin payment.confirm
    // procedure wrote one, leaving webhook-confirmed payments unaudited.
    // Best-effort; NEVER fails the webhook ack.
    if (result.ok && result.action === "confirmed" && tenantId) {
      try {
        const { writeAuditLog } = await import("../../../routers/audit");
        const [confirmedIntent] = await db
          .select({ id: paymentIntents.id, amount: paymentIntents.amount, currency: paymentIntents.currency, provider: paymentIntents.provider })
          .from(paymentIntents)
          .where(eq(paymentIntents.providerPaymentId, norm.reference))
          .limit(1);
        await writeAuditLog({
          actorId: null,
          actorRole: "system",
          action: "payment.confirm",
          entityType: "payment_intent",
          entityId: confirmedIntent?.id ?? norm.reference,
          tenantId,
          summary: `Payment ${norm.reference} confirmed via ${providerId} webhook`,
          after: confirmedIntent
            ? { status: "completed", amount: confirmedIntent.amount, currency: confirmedIntent.currency, provider: confirmedIntent.provider }
            : { status: "completed", provider: providerId },
        });
      } catch (auditErr: any) {
        console.warn("[unified-payment-webhook] audit write failed:", auditErr?.message);
      }
    }
    return void res.status(200).json({ received: true, ...result });
  } catch (err: any) {
    console.error("[unified-payment-webhook]", err);
    return void res.status(500).json({ error: err?.message });
  }
}
