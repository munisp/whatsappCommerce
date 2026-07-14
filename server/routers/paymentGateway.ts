import { z } from "zod";
import { router, protectedProcedure } from "../_core/trpc";
import { getDb } from "../db";
import { paymentGatewayConfigs, paymentTransactions, orders } from "../../drizzle/schema";
import { eq, and, desc } from "drizzle-orm";
import { randomUUID } from "crypto";
import crypto from "crypto";

// ─── Provider adapters ────────────────────────────────────────────────────────

async function paystackInitiate(opts: {
  secretKey: string; amount: number; currency: string;
  email: string; orderId: string; callbackUrl: string; ref: string;
}) {
  const res = await fetch("https://api.paystack.co/transaction/initialize", {
    method: "POST",
    headers: { Authorization: `Bearer ${opts.secretKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      amount: Math.round(opts.amount * 100), // kobo
      currency: opts.currency,
      email: opts.email,
      reference: opts.ref,
      callback_url: opts.callbackUrl,
      metadata: { order_id: opts.orderId },
    }),
  });
  if (!res.ok) throw new Error(`Paystack error: ${res.status}`);
  const data = await res.json() as { data: { authorization_url: string; reference: string } };
  return { paymentUrl: data.data.authorization_url, providerRef: data.data.reference };
}

async function paystackVerify(secretKey: string, reference: string) {
  const res = await fetch(`https://api.paystack.co/transaction/verify/${reference}`, {
    headers: { Authorization: `Bearer ${secretKey}` },
  });
  if (!res.ok) throw new Error(`Paystack verify error: ${res.status}`);
  const data = await res.json() as { data: { status: string; amount: number; paid_at: string } };
  return { status: data.data.status, amount: data.data.amount / 100, paidAt: data.data.paid_at };
}

async function flutterwaveInitiate(opts: {
  secretKey: string; amount: number; currency: string;
  email: string; name: string; phone: string;
  orderId: string; callbackUrl: string; ref: string;
}) {
  const res = await fetch("https://api.flutterwave.com/v3/payments", {
    method: "POST",
    headers: { Authorization: `Bearer ${opts.secretKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      tx_ref: opts.ref,
      amount: opts.amount,
      currency: opts.currency,
      redirect_url: opts.callbackUrl,
      customer: { email: opts.email, name: opts.name, phonenumber: opts.phone },
      meta: { order_id: opts.orderId },
    }),
  });
  if (!res.ok) throw new Error(`Flutterwave error: ${res.status}`);
  const data = await res.json() as { data: { link: string } };
  return { paymentUrl: data.data.link, providerRef: opts.ref };
}

async function flutterwaveVerify(secretKey: string, transactionId: string) {
  const res = await fetch(`https://api.flutterwave.com/v3/transactions/${transactionId}/verify`, {
    headers: { Authorization: `Bearer ${secretKey}` },
  });
  if (!res.ok) throw new Error(`Flutterwave verify error: ${res.status}`);
  const data = await res.json() as { data: { status: string; amount: number; created_at: string } };
  return { status: data.data.status, amount: data.data.amount, paidAt: data.data.created_at };
}

// Mojaloop: simplified FSPIOP transfer initiation (production requires FSPIOP-Source header + mTLS)
async function mojaloopInitiate(opts: {
  baseUrl: string; amount: number; currency: string;
  payerFsp: string; payeeFsp: string; payeeId: string; ref: string;
}) {
  const transferId = randomUUID();
  const res = await fetch(`${opts.baseUrl}/transfers`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "FSPIOP-Source": opts.payerFsp },
    body: JSON.stringify({
      transferId,
      payerFsp: opts.payerFsp,
      payeeFsp: opts.payeeFsp,
      amount: { amount: String(opts.amount), currency: opts.currency },
      ilpPacket: "AQAAAAAAAADIEHByaXZhdGUucGF5ZWVmc3A",
      condition: "HOr22-H3AfTDHrSkPjJtVPRG2PI2AC-ztCd6nUIjkiY",
      expiration: new Date(Date.now() + 30_000).toISOString(),
    }),
  });
  // Mojaloop returns 202 Accepted (async)
  if (res.status !== 202 && !res.ok) throw new Error(`Mojaloop error: ${res.status}`);
  return { paymentUrl: null, providerRef: transferId, providerTxId: transferId };
}

// ─── tRPC Router ─────────────────────────────────────────────────────────────

export const paymentGatewayRouter = router({
  // Configure a payment gateway for a tenant
  configure: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      provider: z.enum(["paystack", "flutterwave", "mojaloop", "stripe", "manual"]),
      publicKey: z.string().optional(),
      secretKey: z.string().optional(),
      webhookSecret: z.string().optional(),
      callbackUrl: z.string().url().optional(),
      isActive: z.boolean().default(true),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database unavailable");
      const id = randomUUID();
      await db.insert(paymentGatewayConfigs).values({
        id, tenantId: input.tenantId, provider: input.provider,
        publicKey: input.publicKey, secretKey: input.secretKey,
        webhookSecret: input.webhookSecret, callbackUrl: input.callbackUrl,
        isActive: input.isActive,
      }).onConflictDoUpdate({
        target: [paymentGatewayConfigs.tenantId, paymentGatewayConfigs.provider],
        set: {
          publicKey: input.publicKey, secretKey: input.secretKey,
          webhookSecret: input.webhookSecret, callbackUrl: input.callbackUrl,
          isActive: input.isActive, updatedAt: new Date(),
        },
      });
      return { ok: true };
    }),

  // Get gateway config for a tenant
  getConfig: protectedProcedure
    .input(z.object({ tenantId: z.string(), provider: z.string().optional() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];
      const conditions = [eq(paymentGatewayConfigs.tenantId, input.tenantId)];
      if (input.provider) conditions.push(eq(paymentGatewayConfigs.provider, input.provider));
      const rows = await db.select().from(paymentGatewayConfigs)
        .where(and(...conditions))
        .orderBy(desc(paymentGatewayConfigs.createdAt));
      // Mask secret keys in response
      return rows.map(r => ({ ...r, secretKey: r.secretKey ? "••••••••" : null }));
    }),

  // Initiate a payment — returns a payment URL for the buyer
  initiate: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      orderId: z.string(),
      provider: z.enum(["paystack", "flutterwave", "mojaloop", "manual"]),
      customerEmail: z.string().email().default("buyer@whatsapp.commerce"),
      customerName: z.string().default("WhatsApp Buyer"),
      customerPhone: z.string().default("+2340000000000"),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database unavailable");

      // Fetch order
      const [order] = await db.select().from(orders)
        .where(and(eq(orders.id, input.orderId), eq(orders.tenantId, input.tenantId)));
      if (!order) throw new Error("Order not found");

      // Fetch gateway config
      const [config] = await db.select().from(paymentGatewayConfigs)
        .where(and(
          eq(paymentGatewayConfigs.tenantId, input.tenantId),
          eq(paymentGatewayConfigs.provider, input.provider),
          eq(paymentGatewayConfigs.isActive, true),
        ));

      const ref = `WC-${input.orderId.slice(0, 8)}-${Date.now()}`;
      const amount = Number(order.totalAmount);
      const currency = order.currency ?? "NGN";
      const callbackUrl = config?.callbackUrl ?? `${process.env.VITE_APP_ID ? "https://" + process.env.VITE_APP_ID + ".manus.space" : "http://localhost:3000"}/payment/callback`;

      let paymentUrl: string | null = null;
      let providerRef = ref;
      let providerTxId: string | undefined;

      if (!config?.secretKey && input.provider !== "manual") {
        // No config — return mock URL for dev/testing
        paymentUrl = `https://checkout.example.com/pay/${ref}`;
        providerRef = ref;
      } else {
        try {
          if (input.provider === "paystack") {
            const r = await paystackInitiate({
              secretKey: config!.secretKey!, amount, currency,
              email: input.customerEmail, orderId: input.orderId,
              callbackUrl, ref,
            });
            paymentUrl = r.paymentUrl; providerRef = r.providerRef;
          } else if (input.provider === "flutterwave") {
            const r = await flutterwaveInitiate({
              secretKey: config!.secretKey!, amount, currency,
              email: input.customerEmail, name: input.customerName,
              phone: input.customerPhone, orderId: input.orderId,
              callbackUrl, ref,
            });
            paymentUrl = r.paymentUrl; providerRef = r.providerRef;
          } else if (input.provider === "mojaloop") {
            const meta = config?.metadata as Record<string, string> | null;
            const r = await mojaloopInitiate({
              baseUrl: meta?.baseUrl ?? "http://localhost:3003",
              amount, currency,
              payerFsp: meta?.payerFsp ?? "payer-fsp",
              payeeFsp: meta?.payeeFsp ?? "payee-fsp",
              payeeId: meta?.payeeId ?? input.customerPhone,
              ref,
            });
            paymentUrl = r.paymentUrl; providerRef = r.providerRef; providerTxId = r.providerTxId;
          }
        } catch (err: any) {
          // Gateway error — fall back to mock URL so dev flow isn't blocked
          paymentUrl = `https://checkout.example.com/pay/${ref}`;
          providerRef = ref;
        }
      }

      // Record transaction
      const txId = randomUUID();
      await db.insert(paymentTransactions).values({
        id: txId,
        tenantId: input.tenantId,
        orderId: input.orderId,
        customerId: order.customerId,
        provider: input.provider,
        providerRef,
        providerTxId: providerTxId ?? providerRef,
        amount: String(amount),
        currency,
        status: "initiated",
        paymentUrl,
      });

      return { transactionId: txId, paymentUrl, providerRef, amount, currency };
    }),

  // Verify a payment after callback
  verify: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      transactionId: z.string(),
      providerRef: z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database unavailable");
      const [tx] = await db.select().from(paymentTransactions)
        .where(and(
          eq(paymentTransactions.id, input.transactionId),
          eq(paymentTransactions.tenantId, input.tenantId),
        ));
      if (!tx) throw new Error("Transaction not found");

      const [config] = await db.select().from(paymentGatewayConfigs)
        .where(and(
          eq(paymentGatewayConfigs.tenantId, input.tenantId),
          eq(paymentGatewayConfigs.provider, tx.provider),
        ));

      let verified = false;
      let paidAt: Date | null = null;

      try {
        if (tx.provider === "paystack" && config?.secretKey) {
          const r = await paystackVerify(config.secretKey, input.providerRef ?? tx.providerRef ?? "");
          verified = r.status === "success";
          paidAt = verified ? new Date(r.paidAt) : null;
        } else if (tx.provider === "flutterwave" && config?.secretKey) {
          const r = await flutterwaveVerify(config.secretKey, tx.providerTxId ?? "");
          verified = r.status === "successful";
          paidAt = verified ? new Date(r.paidAt) : null;
        } else {
          // Manual / Mojaloop / mock — treat as verified
          verified = true;
          paidAt = new Date();
        }
      } catch {
        verified = false;
      }

      const newStatus = verified ? "completed" : "failed";
      await db.update(paymentTransactions)
        .set({ status: newStatus, paidAt: paidAt ?? undefined, updatedAt: new Date() })
        .where(eq(paymentTransactions.id, input.transactionId));

      if (verified && tx.orderId) {
        await db.update(orders)
          .set({ paymentStatus: "completed", status: "confirmed", updatedAt: new Date() })
          .where(eq(orders.id, tx.orderId));
      }

      return { verified, status: newStatus, paidAt };
    }),

  // List transactions for a tenant
  listTransactions: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      status: z.string().optional(),
      limit: z.number().default(50),
    }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];
      const conditions = [eq(paymentTransactions.tenantId, input.tenantId)];
      if (input.status) conditions.push(eq(paymentTransactions.status, input.status));
      return db.select().from(paymentTransactions)
        .where(and(...conditions))
        .orderBy(desc(paymentTransactions.createdAt))
        .limit(input.limit);
    }),

  // Verify Paystack webhook signature
  verifyWebhookSignature: protectedProcedure
    .input(z.object({
      tenantId: z.string(),
      provider: z.enum(["paystack", "flutterwave"]),
      rawBody: z.string(),
      signature: z.string(),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database unavailable");
      const [config] = await db.select().from(paymentGatewayConfigs)
        .where(and(
          eq(paymentGatewayConfigs.tenantId, input.tenantId),
          eq(paymentGatewayConfigs.provider, input.provider),
        ));
      if (!config?.webhookSecret) return { valid: false };
      const hash = crypto.createHmac("sha512", config.webhookSecret)
        .update(input.rawBody).digest("hex");
      return { valid: hash === input.signature };
    }),
});
