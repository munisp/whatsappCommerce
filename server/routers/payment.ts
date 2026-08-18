/**
 * Payment Router — Hardened Flow-of-Funds
 *
 * ATOMICITY GUARANTEES:
 * 1. Redis idempotency key — prevents double-processing of webhooks
 * 2. Temporal saga — orchestrates multi-step payment flow with compensation
 * 3. TigerBeetle ledger — atomic double-entry accounting
 * 4. PostgreSQL — source of truth for payment_intents with status machine
 * 5. Fluvio — event sourcing for audit trail
 * 6. Dapr pub/sub — cross-service event notification
 */
import { z } from "zod";
import { router, protectedProcedure, adminProcedure, assertTenantAccess } from "../_core/trpc";
import * as db from "../db";
import { getDb } from "../db";
import { ENV } from "../_core/env";
import { TRPCError } from "@trpc/server";
import { createHash, randomUUID } from "crypto";
import { paymentIntents } from "../../drizzle/schema";
import { eq, and, sql } from "drizzle-orm";
import { publishPaymentEvent as publishPaymentDaprEvent, daprPublish } from "../dapr";
import { getRedis } from "../redis";
import { assessFraudRisk } from "../services/fraud";
import { createFraudCase } from "./fraudCase";
import { writeAuditLog } from "./audit";
import { initiateWithFallback } from "../services/payments/initiateWithFallback";
import { toIntentProviderEnum } from "../services/payments/providers/providerEnum";

// ── TigerBeetle ledger helper ─────────────────────────────────────────────────

async function ledgerRequest(path: string, method = "GET", body?: unknown) {
  const url = `${ENV.ledgerBridgeUrl ?? "http://ledger-bridge:8095"}${path}`;
  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Ledger bridge ${method} ${path} → ${res.status}: ${text}`);
  }
  return res.json();
}

// ── Ledger account ids + minor units (rust/ledger-bridge contract) ───────────
// The hardened ledger bridge only accepts explicit account ids (decimal u128,
// 32-char hex, or canonical UUID) and INTEGER MINOR UNITS. Derive deterministic
// UUID account ids from platform identifiers so the same customer/tenant always
// maps to the same ledger account (sha256 → UUID v4-shaped string; no dep).

function ledgerAccountId(kind: "customer" | "escrow" | "merchant", identifier: string): string {
  const hex = createHash("sha256").update(`wacommerce:ledger:${kind}:${identifier}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** Major units (e.g. naira) → integer minor units (e.g. kobo), round half up. */
function toMinorUnits(amountMajor: number): number {
  return Math.round(amountMajor * 100);
}

// Accounts are provisioned via POST /accounts/provision
// ({tenant_id?, account_type, currency?} → {tb_account_id, ...}) before their
// first transfer. Track provisioned accounts in-process to avoid re-provisioning
// on every payment; the bridge's ON CONFLICT upsert makes replays safe anyway.
const provisionedLedgerAccounts = new Set<string>();

async function ensureLedgerAccountProvisioned(opts: {
  tenantId?: string;
  accountType: "merchant" | "escrow" | "platform_fee" | "float" | "suspense";
  currency?: string;
}) {
  const cacheKey = `${opts.accountType}:${opts.tenantId ?? ""}:${opts.currency ?? "NGN"}`;
  if (provisionedLedgerAccounts.has(cacheKey)) return;
  try {
    await ledgerRequest("/accounts/provision", "POST", {
      tenant_id: opts.tenantId,
      account_type: opts.accountType,
      currency: opts.currency ?? "NGN",
    });
    provisionedLedgerAccounts.add(cacheKey);
  } catch (err: any) {
    // Best effort: the subsequent /transfer is the authoritative gate and will
    // surface any real ledger outage with a precise error.
    console.warn(`[payment] ledger account provisioning failed for ${cacheKey}:`, err?.message);
  }
}

// ── Redis idempotency helper ──────────────────────────────────────────────────

async function acquireIdempotencyLock(key: string, ttlSeconds = 300): Promise<boolean> {
  // Fail CLOSED in production: without Redis there is no duplicate-initiation
  // protection, and a fail-open lock means double charges. Degrade (with a loud
  // warning) only outside production.
  const failClosed = () => {
    if (process.env.NODE_ENV === "production") {
      console.error("[payment] Redis unavailable — refusing payment initiation (idempotency fail-closed)");
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Payment service temporarily unavailable (idempotency store down). Please retry shortly.",
      });
    }
    console.warn("[payment] Redis UNAVAILABLE — proceeding WITHOUT idempotency protection (non-production mode)");
    return true;
  };

  let redis: Awaited<ReturnType<typeof getRedis>>;
  try {
    redis = await getRedis();
  } catch {
    return failClosed();
  }
  if (!redis) return failClosed();
  try {
    const result = await redis.set(`idempotency:${key}`, "1", "EX", ttlSeconds, "NX");
    return result === "OK";
  } catch (err: any) {
    console.warn("[payment] Redis error while acquiring idempotency lock:", err?.message);
    return failClosed();
  }
}

async function releaseIdempotencyLock(key: string) {
  try {
    const redis = await getRedis();
    if (redis) await redis.del(`idempotency:${key}`);
  } catch { /* ignore */ }
}

// ── Temporal saga trigger ─────────────────────────────────────────────────────

async function triggerPaymentSaga(workflowId: string, input: {
  paymentIntentId: string;
  tenantId: string;
  amount: number;
  currency: string;
  provider: string;
  reference: string;
}) {
  try {
    const { Client, Connection } = await import("@temporalio/client");
    const connection = await Connection.connect({ address: process.env.TEMPORAL_ADDRESS ?? "temporal:7233" });
    const client = new Client({ connection, namespace: process.env.TEMPORAL_NAMESPACE ?? "default" });
    await client.workflow.start("paymentSagaWorkflow", {
      taskQueue: "commerce-engine",
      workflowId,
      args: [input],
    });
    await connection.close();
    return { started: true };
  } catch (err: any) {
    console.warn("[payment] Temporal saga start failed, proceeding synchronously:", err.message);
    return { started: false, error: err.message };
  }
}

// ── Fluvio event publisher ────────────────────────────────────────────────────

async function publishPaymentEvent(topic: string, payload: Record<string, unknown>) {
  try {
    const res = await fetch(`${ENV.fluvioConsumerUrl}/produce`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic, payload }),
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ── Router ────────────────────────────────────────────────────────────────────

export const paymentRouter = router({
  /** List payment intents for a tenant */
  list: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      status: z.string().optional(),
      limit: z.number().default(50),
      offset: z.number().default(0),
    }))
    .query(async ({ input, ctx }) => {
      // Tenant isolation: merchants may only list their own tenant's intents.
      assertTenantAccess(ctx.user, input.tenantId);
      return db.getPaymentIntents(input.tenantId, input.status, input.limit, input.offset);
    }),

  /** Initiate a payment with full atomicity guarantees */
  initiate: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      orderId: z.string(),
      amount: z.number().positive(),
      currency: z.string().length(3).default("NGN"),
      provider: z.enum(["paystack", "flutterwave", "mojaloop", "stripe"]),
      customerPhone: z.string(),
      customerId: z.string().optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      // Tenant isolation: a payment can only be initiated for the caller's own
      // tenant — previously any authenticated user could initiate payments
      // against ANY tenantId.
      assertTenantAccess(ctx.user, input.tenantId);
      const paymentIntentId = randomUUID();
      const idempotencyKey = `payment:${input.tenantId}:${input.orderId}`;

      // Step 1: Redis idempotency check
      const acquired = await acquireIdempotencyLock(idempotencyKey, 600);
      if (!acquired) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "Payment already in progress for this order. Please wait.",
        });
      }

      const database = await getDb();
      if (!database) {
        await releaseIdempotencyLock(idempotencyKey);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      }

      let ledgerPendingId: string | null = null;
      try {
        // Step 1.5: Reuse-or-clear any existing intent for this idempotency key.
        // The unique constraint on idempotencyKey would otherwise permanently
        // block retrying an order whose first attempt failed.
        const [existing] = await database.select().from(paymentIntents)
          .where(eq(paymentIntents.idempotencyKey, idempotencyKey)).limit(1);
        if (existing) {
          if (existing.status === "completed" || existing.status === "initiated") {
            // Idempotent replay: return the existing in-flight/completed intent.
            const meta = (existing.metadata as Record<string, unknown> | null) ?? {};
            await releaseIdempotencyLock(idempotencyKey);
            return {
              paymentIntentId: existing.id,
              reference: existing.providerPaymentId,
              paymentUrl: (meta.paymentUrl as string | undefined) ?? null,
              status: existing.status,
              sagaWorkflowId: null,
              tbDebitOk: !!existing.ledgerPendingId,
              idempotentReplay: true,
            };
          }
          // pending/failed/cancelled/refunded — the previous attempt never
          // reached (or failed at) the provider. Delete it so the retry can
          // insert a fresh row under the same idempotency key.
          await database.delete(paymentIntents)
            .where(and(eq(paymentIntents.id, existing.id), eq(paymentIntents.idempotencyKey, idempotencyKey)));
        }

        // Step 1.9: Fraud screening — score with the shared heuristic (the
        // same fallback used by /api/ml/predict, so both paths agree).
        // High-risk payments are NOT silently processed: the intent is
        // flagged and a fraud case is queued for AML filing.
        const fraudRisk = assessFraudRisk({
          amount: input.amount,
          numItems: typeof input.metadata?.numItems === "number" ? (input.metadata.numItems as number) : 0,
          phone: input.customerPhone,
          customerId: input.customerId ?? null,
        });
        const fraudMeta = fraudRisk.riskLevel === "high"
          ? { fraudScore: fraudRisk.fraudProbability, riskLevel: fraudRisk.riskLevel, fraudFlagged: true }
          : { fraudScore: fraudRisk.fraudProbability, riskLevel: fraudRisk.riskLevel };

        // Step 2: Create payment intent in DB (pending)
        const reference = `PAY-${Date.now()}-${paymentIntentId.slice(0, 8).toUpperCase()}`;
        await database.insert(paymentIntents).values({
          id: paymentIntentId,
          tenantId: input.tenantId,
          orderId: input.orderId,
          amount: String(input.amount),
          currency: input.currency,
          provider: input.provider,
          providerPaymentId: reference,
          idempotencyKey,
          status: "pending",
          // customerId is NOT NULL in the schema; fall back to the phone number
          // for guest/WhatsApp checkouts that have no customer record yet.
          customerId: input.customerId ?? input.customerPhone,
          // customerPhone has no dedicated column — persisted in jsonb metadata.
          metadata: { ...(input.metadata ?? {}), ...fraudMeta, customerPhone: input.customerPhone },
          createdAt: new Date(),
          updatedAt: new Date(),
        });

        // High-risk → queue an AML fraud case (filed asynchronously by
        // fraudCase.processQueue) and leave an audit trail entry.
        if (fraudRisk.riskLevel === "high") {
          const fraudCaseId = await createFraudCase({
            tenantId: input.tenantId,
            paymentIntentId,
            orderId: input.orderId,
            customerId: input.customerId ?? input.customerPhone,
            fraudScore: fraudRisk.fraudProbability.toFixed(4),
            riskLevel: fraudRisk.riskLevel,
            status: "pending",
            payload: { amount: input.amount, currency: input.currency, provider: input.provider },
          });
          await writeAuditLog({
            actorId: null,
            actorRole: "system",
            action: "payment.fraudFlag",
            entityType: "payment_intent",
            entityId: paymentIntentId,
            tenantId: input.tenantId,
            summary: `High-risk payment flagged (score=${fraudRisk.fraudProbability.toFixed(2)}) — fraud case ${fraudCaseId ?? "n/a"} queued`,
            after: { fraudCaseId, riskLevel: fraudRisk.riskLevel, fraudScore: fraudRisk.fraudProbability },
          });
        }

        // Step 3: Ledger 2-phase commit — RESERVE the funds BEFORE the provider
        // charge. A ledger failure is a PAYMENT failure (no silent success with
        // zero ledger entries): the intent is marked failed with a ledger_failed
        // reason and the error is surfaced to the caller.
        try {
          // The hardened ledger bridge rejects opaque string account ids —
          // derive deterministic UUID account ids and provision the accounts
          // (POST /accounts/provision) before their first transfer.
          const customerLedgerId = input.customerId ?? input.customerPhone;
          const debitAccountId = ledgerAccountId("customer", customerLedgerId);
          const creditAccountId = ledgerAccountId("escrow", input.tenantId);
          await ensureLedgerAccountProvisioned({ tenantId: customerLedgerId, accountType: "float", currency: input.currency });
          await ensureLedgerAccountProvisioned({ tenantId: input.tenantId, accountType: "escrow", currency: input.currency });
          const reserveRes = (await ledgerRequest("/transfer", "POST", {
            debit_account_id: debitAccountId,
            credit_account_id: creditAccountId,
            // Integer minor units (kobo), round half up — the /transfer contract.
            amount: toMinorUnits(input.amount),
            ledger: 1,
            code: 1,
            idempotency_key: idempotencyKey,
          })) as Record<string, unknown>;
          // Bridge responds 201 {pending_id, status: "reserved", ...}; keep the
          // fallback chain for older bridge builds.
          ledgerPendingId =
            (reserveRes.pending_id as string | undefined) ??
            (reserveRes.transfer_id as string | undefined) ??
            (reserveRes.id as string | undefined) ??
            null;
        } catch (ledgerErr: any) {
          const reason = `ledger_failed: ${ledgerErr?.message ?? "reserve failed"}`;
          console.error("[payment] Ledger reserve failed — failing payment initiation:", reason);
          await database.update(paymentIntents)
            .set({ status: "failed", failureReason: reason, updatedAt: new Date() })
            .where(eq(paymentIntents.id, paymentIntentId))
            .catch(() => {});
          throw new Error(reason);
        }
        if (ledgerPendingId) {
          await database.update(paymentIntents)
            .set({ ledgerPendingId, updatedAt: new Date() })
            .where(eq(paymentIntents.id, paymentIntentId));
        }
        const tbDebitOk = true;

        // Step 4: Start Temporal saga
        const sagaWorkflowId = `payment-saga-${paymentIntentId}`;
        const sagaResult = await triggerPaymentSaga(sagaWorkflowId, {
          paymentIntentId,
          tenantId: input.tenantId,
          amount: input.amount,
          currency: input.currency,
          provider: input.provider,
          reference,
        });

        // Step 5: Get payment URL from the provider REGISTRY (wave-11): the
        // tenant's priority-ordered fallback chain is walked; the caller's
        // provider input is a preference, not a hard binding. The serving
        // provider is recorded on the intent (existing `provider` column +
        // metadata.servedProvider — NO migration). Manual/custom providers
        // return settlement instructions instead of a redirect URL.
        let paymentUrl: string | null = null;
        let instructions: string | null = null;
        let providerResponse: Record<string, unknown> = {};
        let servedProvider: string = input.provider;

        if (input.provider === "mojaloop") {
          // Mojaloop is not a registry adapter — keep its legacy inline path.
          paymentUrl = `${ENV.appUrl}/pay/${reference}`;
          providerResponse = { mojaloop: true, transferId: paymentIntentId };
        } else {
          const fallback = await initiateWithFallback(input.tenantId, {
            tenantId: input.tenantId,
            amountCents: Math.round(input.amount * 100),
            currency: input.currency,
            reference,
            metadata: { payment_intent_id: paymentIntentId, tenant_id: input.tenantId, order_id: input.orderId },
            customer: { phone: input.customerPhone, email: `${input.customerPhone.replace(/\D/g, "") || "customer"}@wa-app.newfire.app` },
            // No such route as /api/webhooks/paystack/callback exists — the
            // webhook confirms the payment server-side; this is only the
            // post-checkout browser redirect, so send the buyer back into
            // their WhatsApp chat, same as the nlp.ts checkout flow.
            callbackUrl: `https://wa.me/${input.customerPhone.replace(/\D/g, "")}`,
          }, { preferredProvider: input.provider });
          paymentUrl = fallback.result.authorizationUrl ?? null;
          instructions = fallback.result.instructions ?? null;
          providerResponse = {};
          servedProvider = fallback.providerId;
          if (fallback.failedAttempts.length > 0) {
            providerResponse = { ...providerResponse, fallbackAttempts: fallback.failedAttempts };
          }
        }

        // Step 6: Update DB with payment URL (stored in jsonb metadata —
        // payment_intents has no paymentUrl / providerResponse columns).
        // `provider` is a pgEnum (mojaloop/stripe/paystack/flutterwave/
        // manual) — the serving provider is ALWAYS recorded in
        // metadata.servedProvider; the column is updated only when the served
        // id is an enum member (custom/monnify → 'manual' bucket + metadata).
        await database.update(paymentIntents)
          .set({
            status: "initiated",
            provider: toIntentProviderEnum(servedProvider),
            metadata: {
              ...(input.metadata ?? {}),
              ...fraudMeta,
              customerPhone: input.customerPhone,
              paymentUrl,
              ...(instructions ? { instructions } : {}),
              servedProvider,
              providerResponse,
            },
            updatedAt: new Date(),
          })
          .where(eq(paymentIntents.id, paymentIntentId));

        // Step 7: Publish events
        await publishPaymentEvent("payment.initiated", {
          paymentIntentId, tenantId: input.tenantId, orderId: input.orderId,
          amount: input.amount, currency: input.currency, provider: input.provider,
          reference, tbDebitOk, sagaStarted: sagaResult.started, timestamp: new Date().toISOString(),
        });
        await publishPaymentDaprEvent("payment.initiated", {
          paymentIntentId, tenantId: input.tenantId, amount: input.amount, currency: input.currency,
        });

        return { paymentIntentId, reference, paymentUrl, instructions, provider: servedProvider, status: "initiated",
          sagaWorkflowId: sagaResult.started ? sagaWorkflowId : null, tbDebitOk };

      } catch (err: any) {
        // Compensation: void the ledger reservation (2-phase rollback) if one
        // was taken, then mark the payment as failed. The failed row is KEPT
        // for audit; a retry deletes/reuses it (see Step 1.5).
        if (ledgerPendingId) {
          try {
            await ledgerRequest("/ledger/void", "POST", { pending_id: ledgerPendingId });
          } catch (voidErr: any) {
            console.error(`[payment] Ledger void failed for pending_id=${ledgerPendingId} — needs reconciliation:`, voidErr?.message);
          }
        }
        try {
          await database.update(paymentIntents)
            .set({ status: "failed", failureReason: err.message, updatedAt: new Date() })
            .where(eq(paymentIntents.id, paymentIntentId));
        } catch { /* best effort */ }
        await releaseIdempotencyLock(idempotencyKey);
        await publishPaymentEvent("payment.failed", {
          paymentIntentId, tenantId: input.tenantId, error: err.message, timestamp: new Date().toISOString(),
        });
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Payment initiation failed: ${err.message}` });
      }
    }),

  /** Confirm a completed payment (called by webhook handlers) */
  confirm: adminProcedure
    .input(z.object({
      reference: z.string(),
      providerStatus: z.enum(["success", "failed", "abandoned"]),
      providerData: z.record(z.string(), z.unknown()).optional(),
    }))
    .mutation(async ({ input }) => {
      const database = await getDb();
      if (!database) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });

      const [intent] = await database.select().from(paymentIntents)
        .where(eq(paymentIntents.providerPaymentId, input.reference)).limit(1);
      if (!intent) throw new TRPCError({ code: "NOT_FOUND", message: `Payment intent not found: ${input.reference}` });

      if (intent.status === "completed" || intent.status === "failed") {
        return { ok: true, skipped: true, status: intent.status };
      }

      const newStatus = input.providerStatus === "success" ? "completed" : "failed";

      // ── ATOMIC CLAIM-FIRST (webhook-storm TOCTOU fix) ─────────────────────
      // The guarded status transition CLAIMS the intent BEFORE any ledger
      // side-effect. Previously the ledger commit ran first and the guarded
      // UPDATE second, so a storm of duplicate webhooks could ALL pass the
      // pre-check, ALL commit the ledger, and only then lose the race — a
      // double-commit. Now exactly one concurrent caller wins the claim; the
      // rest see rowCount=0 and skip as already-completed.
      const claim = await database.update(paymentIntents)
        .set({
          status: newStatus,
          metadata: {
            ...((intent.metadata as Record<string, unknown> | null) ?? {}),
            providerResponse: input.providerData ?? {},
          },
          failureReason: newStatus === "failed" ? `Provider reported: ${input.providerStatus}` : null,
          completedAt: newStatus === "completed" ? new Date() : null,
          updatedAt: new Date(),
        })
        .where(and(
          eq(paymentIntents.id, intent.id),
          sql`${paymentIntents.status} IN ('pending', 'initiated')`,
        ))
        .returning({ id: paymentIntents.id });
      if (claim.length === 0) {
        // Lost the claim race — a concurrent confirm already transitioned it.
        const [current] = await database.select({ status: paymentIntents.status })
          .from(paymentIntents).where(eq(paymentIntents.id, intent.id)).limit(1);
        return { ok: true, skipped: true, status: current?.status ?? "completed" };
      }

      // Roll back the claim if a subsequent step fails irrecoverably — the
      // intent returns to 'pending' so a later webhook/retry can re-attempt.
      const rollbackClaim = async (reason: string) => {
        await database.update(paymentIntents)
          .set({ status: "pending", failureReason: reason, completedAt: null, updatedAt: new Date() })
          .where(and(
            eq(paymentIntents.id, intent.id),
            sql`${paymentIntents.status} IN ('completed', 'failed')`,
          ))
          .catch((rollbackErr: unknown) => {
            console.error(`[payment.confirm] CLAIM ROLLBACK FAILED for intent ${intent.id} — needs reconciliation:`, rollbackErr);
          });
      };

      // Ledger 2-phase settlement (only the claim holder reaches this):
      //  - success → COMMIT the reserved transfer (POST /ledger/commit)
      //  - failure → VOID the reservation (POST /ledger/void)
      // A commit failure means the payment is NOT confirmed: the claim is
      // rolled back and the error is surfaced, never silently swallowed.
      if (newStatus === "completed") {
        if (intent.ledgerPendingId) {
          try {
            await ledgerRequest("/ledger/commit", "POST", { pending_id: intent.ledgerPendingId });
          } catch (commitErr: any) {
            const reason = `ledger_commit_failed: ${commitErr?.message ?? "unknown"}`;
            console.error(`[payment.confirm] Ledger commit failed for pending_id=${intent.ledgerPendingId}:`, commitErr?.message);
            await rollbackClaim(reason);
            throw new TRPCError({
              code: "INTERNAL_SERVER_ERROR",
              message: `Ledger commit failed — payment NOT confirmed: ${commitErr?.message ?? "unknown"}`,
            });
          }
        } else {
          // Legacy intent without a reservation — settle via direct transfer.
          try {
            await ensureLedgerAccountProvisioned({ tenantId: intent.tenantId, accountType: "escrow", currency: intent.currency ?? "NGN" });
            await ensureLedgerAccountProvisioned({ tenantId: intent.tenantId, accountType: "merchant", currency: intent.currency ?? "NGN" });
            await ledgerRequest("/transfer", "POST", {
              debit_account_id: ledgerAccountId("escrow", intent.tenantId),
              credit_account_id: ledgerAccountId("merchant", intent.tenantId),
              amount: toMinorUnits(parseFloat(intent.amount)),
              ledger: 1, code: 2,
              idempotency_key: `settle:${intent.id}`,
            });
          } catch (settleErr: any) {
            const reason = `ledger_failed: ${settleErr?.message ?? "settlement transfer failed"}`;
            console.error("[payment.confirm] Ledger settlement failed — payment NOT confirmed:", settleErr?.message);
            await rollbackClaim(reason);
            throw new TRPCError({
              code: "INTERNAL_SERVER_ERROR",
              message: `Ledger settlement failed — payment NOT confirmed: ${settleErr?.message ?? "unknown"}`,
            });
          }
        }
      } else {
        if (intent.ledgerPendingId) {
          try {
            await ledgerRequest("/ledger/void", "POST", { pending_id: intent.ledgerPendingId });
          } catch (voidErr: any) {
            // Void failure does NOT roll back the claim — the provider reported
            // failure, so 'failed' is the correct final state; the orphaned
            // reservation is repaired by the recon worker.
            console.error(`[payment.confirm] Ledger void failed for pending_id=${intent.ledgerPendingId} — needs reconciliation:`, voidErr?.message);
          }
        } else {
          // Legacy intent without a reservation — best-effort reversal.
          const intentMeta = (intent.metadata as Record<string, unknown> | null) ?? {};
          const customerPhone = (intentMeta.customerPhone as string | undefined) ?? intent.customerId;
          try {
            await ensureLedgerAccountProvisioned({ tenantId: intent.tenantId, accountType: "escrow", currency: intent.currency ?? "NGN" });
            await ensureLedgerAccountProvisioned({ tenantId: customerPhone, accountType: "float", currency: intent.currency ?? "NGN" });
            await ledgerRequest("/transfer", "POST", {
              debit_account_id: ledgerAccountId("escrow", intent.tenantId),
              credit_account_id: ledgerAccountId("customer", customerPhone),
              amount: toMinorUnits(parseFloat(intent.amount)),
              ledger: 1, code: 3,
              idempotency_key: `reversal:${intent.id}`,
            });
          } catch { /* best effort reversal */ }
        }
      }

      // Compliance audit trail — recorded AFTER the claim-first transition
      // and successful ledger settlement, so only truly-confirmed payments
      // are audited as confirmed. (The legacy post-settlement guarded
      // transition was subsumed by the atomic claim-first block above.)
      await writeAuditLog({
        actorId: null,
        actorRole: "system",
        action: "payment.confirm",
        entityType: "payment_intent",
        entityId: intent.id,
        tenantId: intent.tenantId,
        summary: `Payment ${input.reference} confirmed as ${newStatus} (provider: ${input.providerStatus})`,
        before: { status: intent.status },
        after: { status: newStatus, amount: intent.amount, currency: intent.currency },
      });

      const eventTopic = newStatus === "completed" ? "payment.completed" : "payment.failed";
      await publishPaymentEvent(eventTopic, {
        paymentIntentId: intent.id, tenantId: intent.tenantId, orderId: intent.orderId,
        amount: intent.amount, currency: intent.currency, reference: intent.providerPaymentId,
        timestamp: new Date().toISOString(),
      });
      await publishPaymentDaprEvent(eventTopic, {
        paymentIntentId: intent.id, tenantId: intent.tenantId, amount: intent.amount, status: newStatus,
      });

      return { ok: true, skipped: false, status: newStatus, paymentIntentId: intent.id };
    }),

  /** Query TigerBeetle ledger balance for a tenant account (admin-only:
   *  the accountId ↔ tenant mapping lives in the ledger, so non-admins
   *  could otherwise probe arbitrary account balances). */
  getLedgerBalance: protectedProcedure
    .input(z.object({ accountId: z.string() }))
    .query(async ({ input, ctx }) => {
      if (ctx.user?.role !== "admin") {
        throw new TRPCError({ code: "FORBIDDEN", message: "Admin access required" });
      }
      try {
        return await ledgerRequest(`/balance/${encodeURIComponent(input.accountId)}`);
      } catch (err: any) {
        return { accountId: input.accountId, credits: 0, debits: 0, balance: 0, error: err.message };
      }
    }),

  /** Reconcile TigerBeetle balance vs DB payment_intents sum */
  reconcileLedger: protectedProcedure
    .input(z.object({ tenantId: z.string(), accountId: z.string() }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const database = await getDb();
      if (!database) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });

      const [dbResult] = await database
        .select({ total: sql<string>`COALESCE(SUM(amount::numeric), 0)` })
        .from(paymentIntents)
        .where(and(eq(paymentIntents.tenantId, input.tenantId), eq(paymentIntents.status, "completed")));
      const dbSum = parseFloat(dbResult?.total ?? "0");

      let ledgerBalance = 0;
      let ledgerError: string | null = null;
      try {
        const data = await ledgerRequest(`/balance/${encodeURIComponent(input.accountId)}`);
        ledgerBalance = (data.balance ?? 0) / 100;
      } catch (err: any) { ledgerError = err.message; }

      const drift = Math.abs(dbSum - ledgerBalance);
      if (drift > 100) {
        await daprPublish("whatsapp-pubsub", "wacommerce.alerts.ledger.drift.detected", {
          tenantId: input.tenantId, accountId: input.accountId, dbSum, ledgerBalance, drift,
          timestamp: new Date().toISOString(),
        });
      }
      return { dbSum, ledgerBalance, drift, inSync: drift < 0.01, ledgerError };
    }),

  /** Get payment stats for a tenant */
  stats: protectedProcedure
    .input(z.object({ tenantId: z.string() }))
    .query(async ({ input, ctx }) => {
      assertTenantAccess(ctx.user, input.tenantId);
      const database = await getDb();
      if (!database) return { total: 0, completed: 0, pending: 0, failed: 0, totalAmount: 0 };
      const rows = await database
        .select({ status: paymentIntents.status, count: sql<string>`COUNT(*)`, amount: sql<string>`COALESCE(SUM(amount::numeric), 0)` })
        .from(paymentIntents)
        .where(eq(paymentIntents.tenantId, input.tenantId))
        .groupBy(paymentIntents.status);
      const stats = { total: 0, completed: 0, pending: 0, failed: 0, initiated: 0, totalAmount: 0 };
      for (const row of rows) {
        const count = parseInt(row.count);
        const amount = parseFloat(row.amount);
        stats.total += count;
        if (row.status === "completed") { stats.completed += count; stats.totalAmount += amount; }
        else if (row.status === "pending") stats.pending += count;
        else if (row.status === "failed") stats.failed += count;
        else if (row.status === "initiated") stats.initiated += count;
      }
      return stats;
    }),
});
