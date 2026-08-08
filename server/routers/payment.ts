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
import { router, protectedProcedure, adminProcedure } from "../_core/trpc";
import * as db from "../db";
import { getDb } from "../db";
import { ENV } from "../_core/env";
import { TRPCError } from "@trpc/server";
import { createHash, randomUUID } from "crypto";
import { paymentIntents } from "../../drizzle/schema";
import { eq, and, sql } from "drizzle-orm";
import { publishPaymentEvent as publishPaymentDaprEvent, daprPublish } from "../dapr";
import { getRedis } from "../redis";

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
    .query(async ({ input }) => {
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
    .mutation(async ({ input }) => {
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
          metadata: { ...(input.metadata ?? {}), customerPhone: input.customerPhone },
          createdAt: new Date(),
          updatedAt: new Date(),
        });

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

        // Step 5: Get payment URL from provider
        let paymentUrl: string | null = null;
        let providerResponse: Record<string, unknown> = {};

        if (input.provider === "paystack") {
          const paystackKey = ENV.paystackSecretKey;
          if (!paystackKey) throw new Error("PAYSTACK_SECRET_KEY not configured");
          const psRes = await fetch("https://api.paystack.co/transaction/initialize", {
            method: "POST",
            headers: { Authorization: `Bearer ${paystackKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              email: `${input.customerPhone.replace(/\D/g, "")}@wa.commerce`,
              amount: Math.round(input.amount * 100),
              currency: input.currency,
              reference,
              metadata: { payment_intent_id: paymentIntentId, tenant_id: input.tenantId, order_id: input.orderId },
              callback_url: `${ENV.appUrl}/api/webhooks/paystack/callback`,
            }),
            signal: AbortSignal.timeout(10000),
          });
          if (!psRes.ok) throw new Error(`Paystack initialization failed: ${await psRes.text()}`);
          const psData = await psRes.json() as { status: boolean; data: { authorization_url: string } };
          if (!psData.status) throw new Error("Paystack returned status=false");
          paymentUrl = psData.data.authorization_url;
          providerResponse = psData.data as Record<string, unknown>;

        } else if (input.provider === "flutterwave") {
          const fwKey = ENV.flwSecretKey;
          if (!fwKey) throw new Error("FLW_SECRET_KEY not configured");
          const fwRes = await fetch("https://api.flutterwave.com/v3/payments", {
            method: "POST",
            headers: { Authorization: `Bearer ${fwKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              tx_ref: reference,
              amount: input.amount,
              currency: input.currency,
              redirect_url: `${ENV.appUrl}/api/webhooks/flutterwave/callback`,
              customer: { phone_number: input.customerPhone },
              meta: { payment_intent_id: paymentIntentId, tenant_id: input.tenantId },
            }),
            signal: AbortSignal.timeout(10000),
          });
          if (!fwRes.ok) throw new Error(`Flutterwave initialization failed: ${await fwRes.text()}`);
          const fwData = await fwRes.json() as { status: string; data: { link: string } };
          paymentUrl = fwData.data.link;
          providerResponse = fwData.data as Record<string, unknown>;

        } else if (input.provider === "mojaloop") {
          paymentUrl = `${ENV.appUrl}/pay/${reference}`;
          providerResponse = { mojaloop: true, transferId: paymentIntentId };
        }

        // Step 6: Update DB with payment URL (stored in jsonb metadata —
        // payment_intents has no paymentUrl / providerResponse columns)
        await database.update(paymentIntents)
          .set({
            status: "initiated",
            metadata: {
              ...(input.metadata ?? {}),
              customerPhone: input.customerPhone,
              paymentUrl,
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

        return { paymentIntentId, reference, paymentUrl, status: "initiated",
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

      // Ledger 2-phase settlement:
      //  - success → COMMIT the reserved transfer (POST /ledger/commit)
      //  - failure → VOID the reservation (POST /ledger/void)
      // A commit failure means the payment is NOT confirmed — it is surfaced
      // as an error, never silently swallowed.
      if (newStatus === "completed") {
        if (intent.ledgerPendingId) {
          try {
            await ledgerRequest("/ledger/commit", "POST", { pending_id: intent.ledgerPendingId });
          } catch (commitErr: any) {
            const reason = `ledger_commit_failed: ${commitErr?.message ?? "unknown"}`;
            console.error(`[payment.confirm] Ledger commit failed for pending_id=${intent.ledgerPendingId}:`, commitErr?.message);
            await database.update(paymentIntents)
              .set({ failureReason: reason, updatedAt: new Date() })
              .where(eq(paymentIntents.id, intent.id))
              .catch(() => {});
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
            await database.update(paymentIntents)
              .set({ failureReason: reason, updatedAt: new Date() })
              .where(eq(paymentIntents.id, intent.id))
              .catch(() => {});
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

      // Guarded transition — a concurrent confirm must not double-commit.
      const transitioned = await database.update(paymentIntents)
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
          sql`${paymentIntents.status} NOT IN ('completed', 'failed')`,
        ))
        .returning({ id: paymentIntents.id });
      if (transitioned.length === 0) {
        // Lost a race with a concurrent confirm — report the row's actual state.
        const [current] = await database.select({ status: paymentIntents.status })
          .from(paymentIntents).where(eq(paymentIntents.id, intent.id)).limit(1);
        return { ok: true, skipped: true, status: current?.status ?? "completed" };
      }

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

  /** Query TigerBeetle ledger balance for a tenant account */
  getLedgerBalance: protectedProcedure
    .input(z.object({ accountId: z.string() }))
    .query(async ({ input }) => {
      try {
        return await ledgerRequest(`/balance/${encodeURIComponent(input.accountId)}`);
      } catch (err: any) {
        return { accountId: input.accountId, credits: 0, debits: 0, balance: 0, error: err.message };
      }
    }),

  /** Reconcile TigerBeetle balance vs DB payment_intents sum */
  reconcileLedger: protectedProcedure
    .input(z.object({ tenantId: z.string(), accountId: z.string() }))
    .query(async ({ input }) => {
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
    .query(async ({ input }) => {
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
