import { z } from "zod";
import { router, protectedProcedure } from "../_core/trpc";
import { getDb } from "../db";
import { paymentTransactions, paymentGatewayConfigs, orders } from "../../drizzle/schema";
import { eq, desc, and, gte } from "drizzle-orm";
import { randomUUID } from "crypto";
import crypto from "crypto";

// ─── Simulation types ─────────────────────────────────────────────────────────

interface SimStep {
  id: string;
  stage: string;
  provider: string;
  status: "pending" | "success" | "failed" | "skipped";
  timestamp: number;
  durationMs: number;
  payload: Record<string, unknown>;
  response: Record<string, unknown>;
  notes: string;
}

interface AuditEntry {
  id: string;
  simulationId: string;
  stage: string;
  provider: string;
  status: string;
  amount: number;
  currency: string;
  reference: string;
  timestamp: number;
  reconciled: boolean;
  discrepancy: string | null;
}

// In-memory simulation store (production: persist to DB)
const simulations = new Map<string, { steps: SimStep[]; audit: AuditEntry[]; completedAt: number | null }>();

function generatePaystackWebhookPayload(ref: string, amount: number, status: "success" | "failed") {
  return {
    event: status === "success" ? "charge.success" : "charge.failed",
    data: {
      id: Math.floor(Math.random() * 1e9),
      domain: "test",
      status,
      reference: ref,
      amount: Math.round(amount * 100), // kobo
      currency: "NGN",
      paid_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      channel: "card",
      fees: Math.round(amount * 1.5),
      customer: { id: 1001, email: "buyer@test.com", customer_code: "CUS_test" },
      authorization: { authorization_code: "AUTH_test", card_type: "visa", last4: "4081", bank: "TEST BANK" },
    },
  };
}

function generateFlutterwaveWebhookPayload(txRef: string, amount: number, status: "successful" | "failed") {
  return {
    event: "charge.completed",
    data: {
      id: Math.floor(Math.random() * 1e9),
      tx_ref: txRef,
      flw_ref: `FLW-${randomUUID().slice(0, 8)}`,
      device_fingerprint: "N/A",
      amount,
      currency: "NGN",
      charged_amount: amount,
      app_fee: amount * 0.014,
      merchant_fee: 0,
      processor_response: status === "successful" ? "Approved" : "Declined",
      auth_model: "PIN",
      ip: "127.0.0.1",
      narration: "Flutterwave payment",
      status,
      payment_type: "card",
      created_at: new Date().toISOString(),
      account_id: 12345,
      customer: { id: 1001, name: "Test Buyer", phone_number: "+2348012345678", email: "buyer@test.com", created_at: new Date().toISOString() },
    },
  };
}

function generateMojaloopTransferPayload(transferId: string, amount: number, currency: string) {
  return {
    transferId,
    payerFsp: "testfsp1",
    payeeFsp: "testfsp2",
    amount: { amount: amount.toString(), currency },
    ilpPacket: `AYH${Buffer.from(JSON.stringify({ transferId, amount })).toString("base64")}`,
    condition: crypto.createHash("sha256").update(transferId).digest("base64"),
    expiration: new Date(Date.now() + 3600000).toISOString(),
  };
}

function computeHmacSha512(secret: string, payload: string): string {
  return crypto.createHmac("sha512", secret).update(payload).digest("hex");
}

function computeFlutterwaveHash(hash: string, payload: string): string {
  return crypto.createHmac("sha256", hash).update(payload).digest("hex");
}

async function runSimulation(opts: {
  provider: "paystack" | "flutterwave" | "mojaloop";
  amount: number;
  currency: string;
  injectFailure: boolean;
  webhookSecret?: string;
}): Promise<{ steps: SimStep[]; audit: AuditEntry[] }> {
  const simulationId = randomUUID();
  const ref = `SIM-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  const steps: SimStep[] = [];
  const audit: AuditEntry[] = [];
  const t0 = Date.now();

  const addStep = (stage: string, provider: string, status: SimStep["status"], payload: Record<string, unknown>, response: Record<string, unknown>, notes: string) => {
    const step: SimStep = {
      id: randomUUID(),
      stage,
      provider,
      status,
      timestamp: Date.now(),
      durationMs: Date.now() - t0,
      payload,
      response,
      notes,
    };
    steps.push(step);
    return step;
  };

  // Step 1: Payment initiation
  await new Promise(r => setTimeout(r, 50));
  addStep("initiate", opts.provider, "success",
    { amount: opts.amount, currency: opts.currency, reference: ref },
    { paymentUrl: `https://checkout.${opts.provider}.com/pay/${ref}`, reference: ref, status: "pending" },
    `Payment initiated with ${opts.provider}. Reference: ${ref}`
  );

  // Step 2: Buyer completes payment (simulated)
  await new Promise(r => setTimeout(r, 80));
  const paymentStatus = opts.injectFailure ? "failed" : "success";
  addStep("buyer_payment", "browser", paymentStatus === "success" ? "success" : "failed",
    { action: "submit_card", reference: ref },
    { status: paymentStatus, message: paymentStatus === "success" ? "Payment authorized" : "Card declined" },
    paymentStatus === "success" ? "Buyer completed payment on checkout page" : "Simulated card decline injected"
  );

  if (opts.injectFailure) {
    // Step 3a: Failure webhook
    await new Promise(r => setTimeout(r, 40));
    const failPayload = opts.provider === "paystack"
      ? generatePaystackWebhookPayload(ref, opts.amount, "failed")
      : generateFlutterwaveWebhookPayload(ref, opts.amount, "failed");
    addStep("webhook_received", opts.provider, "failed",
      failPayload,
      { received: true, processed: true, action: "mark_failed" },
      "Failure webhook received and processed"
    );
    audit.push({
      id: randomUUID(), simulationId, stage: "webhook_received",
      provider: opts.provider, status: "failed",
      amount: opts.amount, currency: opts.currency, reference: ref,
      timestamp: Date.now(), reconciled: true, discrepancy: null,
    });
    return { steps, audit };
  }

  // Step 3: Webhook delivery
  await new Promise(r => setTimeout(r, 60));
  let webhookPayload: Record<string, unknown>;
  let webhookSignature: string;
  if (opts.provider === "paystack") {
    webhookPayload = generatePaystackWebhookPayload(ref, opts.amount, "success");
    const secret = opts.webhookSecret ?? "test_webhook_secret";
    webhookSignature = computeHmacSha512(secret, JSON.stringify(webhookPayload));
  } else if (opts.provider === "flutterwave") {
    webhookPayload = generateFlutterwaveWebhookPayload(ref, opts.amount, "successful");
    const hash = opts.webhookSecret ?? "test_hash";
    webhookSignature = computeFlutterwaveHash(hash, JSON.stringify(webhookPayload));
  } else {
    // Mojaloop: transfer fulfillment
    const transferId = randomUUID();
    webhookPayload = generateMojaloopTransferPayload(transferId, opts.amount, opts.currency);
    webhookSignature = `FSPIOP-Signature: ${crypto.createHash("sha256").update(JSON.stringify(webhookPayload)).digest("hex")}`;
  }
  addStep("webhook_sent", opts.provider, "success",
    { event: (webhookPayload as Record<string, unknown>).event ?? "transfer.fulfilled", reference: ref },
    { delivered: true, httpStatus: 200 },
    `Webhook delivered to /api/webhooks/${opts.provider} with valid signature`
  );

  // Step 4: Signature verification
  await new Promise(r => setTimeout(r, 30));
  addStep("signature_verify", "server", "success",
    { header: "x-paystack-signature / verif-hash / FSPIOP-Signature", algorithm: opts.provider === "paystack" ? "HMAC-SHA512" : opts.provider === "flutterwave" ? "HMAC-SHA256" : "JWS" },
    { valid: true, computedHash: webhookSignature.slice(0, 32) + "..." },
    "Webhook signature verified successfully"
  );

  // Step 5: Payment verification API call
  await new Promise(r => setTimeout(r, 70));
  addStep("verify_payment", opts.provider, "success",
    { reference: ref, endpoint: opts.provider === "paystack" ? `/transaction/verify/${ref}` : `/transactions/verify` },
    { status: "success", amount: opts.amount, currency: opts.currency, paidAt: new Date().toISOString() },
    `Payment verified via ${opts.provider} verification API`
  );

  // Step 6: Order status update
  await new Promise(r => setTimeout(r, 40));
  addStep("update_order", "database", "success",
    { action: "UPDATE orders SET payment_status = 'paid'", reference: ref },
    { rowsAffected: 1, orderId: `ORD-${ref.slice(-8)}` },
    "Order payment status updated to 'paid' in PostgreSQL"
  );

  // Step 7: Reconciliation check
  await new Promise(r => setTimeout(r, 50));
  const amountMatch = true; // In production: compare DB amount vs webhook amount
  addStep("reconcile", "server", amountMatch ? "success" : "failed",
    { dbAmount: opts.amount, webhookAmount: opts.amount, currency: opts.currency },
    { reconciled: amountMatch, discrepancy: amountMatch ? null : "Amount mismatch" },
    amountMatch ? "Amounts reconciled: DB ↔ provider match" : "DISCREPANCY: amount mismatch detected"
  );

  // Audit trail entry
  audit.push({
    id: randomUUID(), simulationId, stage: "full_flow",
    provider: opts.provider, status: "reconciled",
    amount: opts.amount, currency: opts.currency, reference: ref,
    timestamp: Date.now(), reconciled: true, discrepancy: null,
  });

  return { steps, audit };
}

export const reconciliationRouter = router({
  // Run a full end-to-end payment reconciliation simulation
  simulate: protectedProcedure
    .input(z.object({
      provider: z.enum(["paystack", "flutterwave", "mojaloop"]),
      amount: z.number().min(1).max(1000000).default(5000),
      currency: z.string().default("NGN"),
      injectFailure: z.boolean().default(false),
      webhookSecret: z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      const { steps, audit } = await runSimulation(input);
      const simulationId = randomUUID();
      simulations.set(simulationId, { steps, audit, completedAt: Date.now() });
      return {
        simulationId,
        provider: input.provider,
        amount: input.amount,
        currency: input.currency,
        steps,
        audit,
        summary: {
          totalSteps: steps.length,
          successSteps: steps.filter(s => s.status === "success").length,
          failedSteps: steps.filter(s => s.status === "failed").length,
          reconciled: steps.every(s => s.status !== "failed") || input.injectFailure,
          durationMs: steps[steps.length - 1]?.durationMs ?? 0,
        },
      };
    }),

  // Get audit trail for a simulation
  getAuditTrail: protectedProcedure
    .input(z.object({ simulationId: z.string() }))
    .query(async ({ input }) => {
      const sim = simulations.get(input.simulationId);
      if (!sim) return { steps: [], audit: [], completedAt: null };
      return sim;
    }),

  // Verify reconciliation of real transactions in DB
  verifyReconciliation: protectedProcedure
    .input(z.object({ tenantId: z.string(), days: z.number().min(1).max(90).default(7) }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return { transactions: [], summary: { total: 0, reconciled: 0, unreconciled: 0, discrepancies: [] } };
      const since = new Date(Date.now() - input.days * 24 * 3600 * 1000);
      const txs = await db
        .select()
        .from(paymentTransactions)
        .where(and(
          eq(paymentTransactions.tenantId, input.tenantId),
          gte(paymentTransactions.createdAt, since),
        ))
        .orderBy(desc(paymentTransactions.createdAt))
        .limit(100);

      const reconciled = txs.filter(t => t.status === "success" && t.paidAt != null);
      const unreconciled = txs.filter(t => t.status === "initiated" && new Date(t.createdAt).getTime() < Date.now() - 3600000);
      const discrepancies = unreconciled.map(t => ({
        id: t.id,
        reference: t.providerRef,
        provider: t.provider,
        amount: t.amount,
        status: t.status,
        age: `${Math.round((Date.now() - new Date(t.createdAt).getTime()) / 60000)}m`,
        issue: "Payment initiated but never confirmed",
      }));
      return {
        transactions: txs.map(t => ({
          id: t.id, provider: t.provider, amount: t.amount, currency: t.currency,
          status: t.status, reference: t.providerRef, paidAt: t.paidAt?.toISOString() ?? null,
          createdAt: t.createdAt.toISOString(),
        })),
        summary: {
          total: txs.length,
          reconciled: reconciled.length,
          unreconciled: unreconciled.length,
          discrepancies,
        },
      };
    }),

  // List recent simulations
  listSimulations: protectedProcedure.query(async () => {
    const list = Array.from(simulations.entries()).map(([id, sim]) => ({
      simulationId: id,
      totalSteps: sim.steps.length,
      successSteps: sim.steps.filter(s => s.status === "success").length,
      failedSteps: sim.steps.filter(s => s.status === "failed").length,
      completedAt: sim.completedAt,
      provider: sim.steps[0]?.provider ?? "unknown",
    }));
    return list.sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0)).slice(0, 20);
  }),
});
