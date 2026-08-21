/**
 * W27 credit — shared deterministic seed for journeys J138–J141.
 *
 * Creates a dedicated merchant tenant ("sim-credit-merchant") with a fully
 * controlled trailing-90d history so the credit score is EXACTLY
 * reproducible (J138 asserts the exact score). All money integer cents at
 * the seed boundary; orders.totalAmount is a decimal major-units string.
 */
import { assert, type World } from "../world";

export const CREDIT_MERCHANT_ID = "sim-credit-merchant";
export const CREDIT_MERCHANT_NAME = "Credit Seed Stores";

export interface CreditSeedSpec {
  /** Delivered orders in the window (₦5,000 each by default). */
  deliveredOrders?: number;
  cancelledOrders?: number;
  /** Major-units amount per delivered order (default 5000 → 500_000 cents). */
  orderAmountMajor?: number;
  completedPayments?: number;
  failedPayments?: number;
  refunds?: number;
  /** Tenant age in whole days (default 200; createdAt is backdated +1h so
   *  the day-floor is stable for the whole journey run). */
  tenureDays?: number;
}

export interface CreditSeedResult {
  merchantId: string;
  /** Signals exactly as the scorer should observe them. */
  expected: {
    totalOrders: number;
    completedOrders: number;
    cancelledOrders: number;
    refundedOrders: number;
    pendingOrders: number;
    salesVolumeCents: number;
    codOrdersTotal: number;
    codCollected: number;
    codFailed: number;
    paymentsCompleted: number;
    paymentsFailed: number;
    refundCount: number;
    buyerDisputeCount: number;
    tenureDays: number;
    trustScore: null;
  };
}

export async function seedCreditMerchant(
  world: World,
  spec: CreditSeedSpec = {},
): Promise<CreditSeedResult> {
  const schema = await import("../../drizzle/schema");
  const delivered = spec.deliveredOrders ?? 10;
  const cancelled = spec.cancelledOrders ?? 1;
  const amountMajor = spec.orderAmountMajor ?? 5000;
  const completedPayments = spec.completedPayments ?? 10;
  const failedPayments = spec.failedPayments ?? 0;
  const refunds = spec.refunds ?? 0;
  const tenureDays = spec.tenureDays ?? 200;

  const now = new Date();
  const createdAt = new Date(now.getTime() - tenureDays * 24 * 3600 * 1000 - 3600 * 1000);
  const orderTs = new Date(now.getTime() - 24 * 3600 * 1000); // inside the 90d window

  await world.db.insert(schema.tenants).values({
    id: CREDIT_MERCHANT_ID,
    name: CREDIT_MERCHANT_NAME,
    slug: "sim-credit-merchant",
    createdAt,
    updatedAt: createdAt,
  }).onConflictDoNothing();

  for (let i = 0; i < delivered; i++) {
    await world.db.insert(schema.orders).values({
      id: `credit-seed-ord-d${i}`,
      tenantId: CREDIT_MERCHANT_ID,
      customerId: "credit-seed-customer",
      orderNumber: `CS-D${i}`,
      status: "delivered",
      paymentStatus: "completed",
      totalAmount: amountMajor.toFixed(2),
      currency: "NGN",
      createdAt: orderTs,
      updatedAt: orderTs,
    }).onConflictDoNothing();
  }
  for (let i = 0; i < cancelled; i++) {
    await world.db.insert(schema.orders).values({
      id: `credit-seed-ord-c${i}`,
      tenantId: CREDIT_MERCHANT_ID,
      customerId: "credit-seed-customer",
      orderNumber: `CS-C${i}`,
      status: "cancelled",
      paymentStatus: "unpaid",
      totalAmount: amountMajor.toFixed(2),
      currency: "NGN",
      createdAt: orderTs,
      updatedAt: orderTs,
    }).onConflictDoNothing();
  }
  for (let i = 0; i < completedPayments; i++) {
    await world.db.insert(schema.paymentTransactions).values({
      id: `credit-seed-ptx-ok${i}`,
      tenantId: CREDIT_MERCHANT_ID,
      provider: "paystack",
      amount: amountMajor.toFixed(2),
      currency: "NGN",
      status: "completed",
      paidAt: orderTs,
      createdAt: orderTs,
      updatedAt: orderTs,
    }).onConflictDoNothing();
  }
  for (let i = 0; i < failedPayments; i++) {
    await world.db.insert(schema.paymentTransactions).values({
      id: `credit-seed-ptx-f${i}`,
      tenantId: CREDIT_MERCHANT_ID,
      provider: "paystack",
      amount: amountMajor.toFixed(2),
      currency: "NGN",
      status: "failed",
      createdAt: orderTs,
      updatedAt: orderTs,
    }).onConflictDoNothing();
  }
  for (let i = 0; i < refunds; i++) {
    const orderId = `credit-seed-ord-d${i}`;
    assert(i < delivered, "refund seed requires a delivered order");
    await world.db.insert(schema.refunds).values({
      id: `credit-seed-ref-${i}`,
      orderId,
      tenantId: CREDIT_MERCHANT_ID,
      amount: amountMajor.toFixed(2),
      currency: "NGN",
      status: "completed",
      createdAt: orderTs,
      updatedAt: orderTs,
    }).onConflictDoNothing();
  }

  return {
    merchantId: CREDIT_MERCHANT_ID,
    expected: {
      totalOrders: delivered + cancelled,
      completedOrders: delivered,
      cancelledOrders: cancelled,
      refundedOrders: 0,
      pendingOrders: 0,
      salesVolumeCents: delivered * Math.round(amountMajor * 100),
      codOrdersTotal: 0,
      codCollected: 0,
      codFailed: 0,
      paymentsCompleted: completedPayments,
      paymentsFailed: failedPayments,
      refundCount: refunds,
      buyerDisputeCount: 0,
      tenureDays,
      trustScore: null,
    },
  };
}
