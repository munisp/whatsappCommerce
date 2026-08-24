/**
 * W30 loans-credit (Coder A) — parameterized micro-loan merchant seed for
 * the race-condition journeys J162–J164. Same deterministic shape as
 * creditSeed (tier B score: 10 × ₦5,000 delivered + 10 completed payments,
 * 200d tenure) but with a caller-chosen tenant id so each journey owns its
 * merchant (the shared CREDIT_MERCHANT_ID is J138–J141's fixture).
 */
import type { World } from "../world";

export const LOAN_RACE_FACILITY_ID = "f30f30f3-0000-4000-8000-000000000030";
export const LOAN_RACE_FACILITY_COMMITMENT_CENTS = 1_000_000_000_00;

export async function seedLoanMerchant(world: World, tenantId: string): Promise<void> {
  const schema = await import("../../drizzle/schema");
  const now = Date.now();
  const createdAt = new Date(now - 200 * 24 * 3600 * 1000 - 3600 * 1000);
  const orderTs = new Date(now - 24 * 3600 * 1000); // inside the 90d window

  await world.db.insert(schema.tenants).values({
    id: tenantId,
    name: `Loan Race Merchant (${tenantId})`,
    slug: tenantId,
    createdAt,
    updatedAt: createdAt,
  }).onConflictDoNothing();

  // W30 merge: credit.accept is KYB-gated (V2#1) — approved KYB per tenant.
  await world.db.insert(schema.kycApplications).values({
    id: `kyb-seed-${tenantId}`,
    tenantId,
    type: "kyb",
    status: "approved",
    applicantName: "Sim Owner",
    businessName: tenantId,
  }).onConflictDoNothing();

  for (let i = 0; i < 10; i++) {
    await world.db.insert(schema.orders).values({
      id: `${tenantId}-ord-d${i}`,
      tenantId,
      customerId: `${tenantId}-customer`,
      orderNumber: `LR-${tenantId}-D${i}`,
      status: "delivered",
      paymentStatus: "completed",
      totalAmount: "5000.00",
      currency: "NGN",
      createdAt: orderTs,
      updatedAt: orderTs,
    }).onConflictDoNothing();
    await world.db.insert(schema.paymentTransactions).values({
      id: `${tenantId}-ptx-ok${i}`,
      tenantId,
      provider: "paystack",
      amount: "5000.00",
      currency: "NGN",
      status: "completed",
      paidAt: orderTs,
      createdAt: orderTs,
      updatedAt: orderTs,
    }).onConflictDoNothing();
  }
}

/** fmt helper: integer cents → numeric major-units string ("1234.56"). */
export function fmtMajor(cents: number): string {
  const neg = cents < 0;
  const abs = Math.abs(Math.round(cents));
  return `${neg ? "-" : ""}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}
