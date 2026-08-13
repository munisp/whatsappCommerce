/**
 * J64 — Downward limit revision (W13). reviseLimits re-underwrites the
 * facility from the deterministic scorer and APPLIES downward revisions
 * immediately (pre-W13 they were advisory-only):
 *   1. on-time rate collapses (late payments) while outstanding exceeds the
 *      new suggestion → the revision clamps AT outstanding (never below it),
 *      audit row reason 'limit_clamped'
 *   2. outstanding repaid down → the lowered suggestion applies as a clean
 *      downward revision, audit row reason 'auto_revision'
 *   3. behavior improves (on-time payments recover) → the upward path is
 *      restored (reason 'auto_revision', limit raised)
 * Every applied revision writes its audit row in the same transaction.
 */
import { randomUUID } from "crypto";
import { asc, eq } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { SUPPLIER_TENANT_ID } from "../world";
import { adminCaller } from "./helpers";

const HOUR_MS = 60 * 60 * 1000;

export const journey: Journey = {
  id: "J64",
  name: "downward limit revision",
  feature: "reviseLimits: auto_revision + limit_clamped + upward restore",
  async run(world) {
    const schema = await import("../../drizzle/schema");
    const admin = await adminCaller();
    const buy = (await admin.onboarding.start({ name: "Revision Buyer Co" })).tenantId;

    // Facility at ₦648,000 (a previously-underwritten limit), no outstanding.
    const accountId = randomUUID();
    await world.db.insert(schema.creditAccounts).values({
      id: accountId,
      supplierTenantId: SUPPLIER_TENANT_ID,
      buyerTenantId: buy,
      limitCents: 64_800_000,
      outstandingCents: 0,
      termsDays: 14,
      status: "active",
    });

    // Platform history: ₦1,000,000 30-day order volume (2 × ₦500,000).
    const now = Date.now();
    for (let i = 0; i < 2; i++) {
      await world.db.insert(schema.orders).values({
        id: randomUUID(),
        tenantId: buy,
        customerId: `j64-customer-${i}`,
        orderNumber: `J64-${now}-${i}`,
        status: "delivered",
        totalAmount: "500000.00",
        currency: "NGN",
      });
    }
    // Payment behavior helper: on-time (paid ≤24h) or late (paid 48h later).
    let paySeq = 0;
    const addPayment = async (onTime: boolean) => {
      paySeq += 1;
      const created = new Date(now - 2 * 24 * HOUR_MS + paySeq * 1000);
      await world.db.insert(schema.paymentTransactions).values({
        id: randomUUID(),
        tenantId: buy,
        provider: "paystack",
        providerRef: `J64PAY-${now}-${paySeq}`,
        amount: "1000.00",
        currency: "NGN",
        status: "completed",
        createdAt: created,
        paidAt: new Date(created.getTime() + (onTime ? 1 : 48) * HOUR_MS),
      });
    };
    await addPayment(true); // 1/1 on-time → score 56, suggestion ₦648,000

    const { reviseLimits } = await import("../../server/services/tradeCredit");
    const history = () =>
      world.db
        .select()
        .from(schema.creditLimitHistory)
        .where(eq(schema.creditLimitHistory.accountId, accountId))
        .orderBy(asc(schema.creditLimitHistory.createdAt));
    const account = async () =>
      (await world.db.select().from(schema.creditAccounts).where(eq(schema.creditAccounts.id, accountId)).limit(1))[0];

    // Sanity: no change while behavior matches the current limit.
    const noop = await reviseLimits(accountId);
    assert(noop?.ok === true && noop.changed === false, `matching suggestion ⇒ no revision (${JSON.stringify(noop)})`);
    assert((await history()).length === 0, "no audit row for a no-op revision");

    // ── 1. Behavior deteriorates with HIGH outstanding → clamp ────────────
    // 3 late payments (on-time 1/4 = 25% → suggestion ₦352,000) while
    // outstanding (₦400,000) exceeds the suggestion: the revision clamps AT
    // outstanding — never below it — marked 'limit_clamped'.
    await world.backdate(`UPDATE credit_accounts SET outstanding_cents = $1 WHERE id = $2`, [40_000_000, accountId]);
    await addPayment(false);
    await addPayment(false);
    await addPayment(false);
    const clamped = await reviseLimits(accountId);
    assert(clamped?.ok === true && clamped.changed === true, "clamped revision applied");
    assert(clamped.suggestedLimitCents === 35_200_000, `suggestion below outstanding (got ${clamped.suggestedLimitCents})`);
    assert(clamped.newLimitCents === 40_000_000, `limit clamps AT outstanding, never below (got ${clamped.newLimitCents})`);
    assert(clamped.oldLimitCents === 64_800_000, "old limit recorded");
    assert(clamped.clampedAtOutstanding === true && clamped.reason === "limit_clamped", `clamp marker (${clamped.reason})`);
    const afterClamp = await account();
    assert(Number(afterClamp.limitCents) === Number(afterClamp.outstandingCents), "limit == outstanding after clamp");
    let rows = await history();
    assert(rows.length === 1 && rows[0].reason === "limit_clamped" && Number(rows[0].newLimitCents) === 40_000_000,
      "audit row: limit_clamped");

    // ── 2. Outstanding repaid down → clean downward auto_revision ─────────
    await world.backdate(`UPDATE credit_accounts SET outstanding_cents = $1 WHERE id = $2`, [10_000_000, accountId]);
    const down = await reviseLimits(accountId);
    assert(down?.ok === true && down.changed === true, "downward revision applied");
    assert(down.clampedAtOutstanding === false && down.reason === "auto_revision", `clean downward revision (${down.reason})`);
    assert(down.newLimitCents === 35_200_000, `limit lowered to the suggestion (got ${down.newLimitCents})`);
    assert(Number((await account()).limitCents) === 35_200_000, "limit persisted");
    rows = await history();
    assert(rows.length === 2 && rows[1].reason === "auto_revision" && Number(rows[1].newLimitCents) === 35_200_000,
      "audit row: auto_revision downward");

    // ── 3. Behavior improves: on-time rate recovers (7/10 = 70%) ──────────
    for (let i = 0; i < 6; i++) await addPayment(true);
    const up = await reviseLimits(accountId);
    assert(up?.ok === true && up.changed === true, "upward revision applied");
    assert(up.reason === "auto_revision" && up.clampedAtOutstanding === false, "upward path restored");
    assert(up.newLimitCents === 52_800_000, `limit raised to the new suggestion (got ${up.newLimitCents})`);
    assert(Number((await account()).limitCents) === 52_800_000, "raised limit persisted");
    rows = await history();
    assert(rows.length === 3 && rows[2].reason === "auto_revision" && Number(rows[2].newLimitCents) === 52_800_000,
      "audit row: upward auto_revision");
    assert(Number((await account()).score) === up.score, "revision score persisted on the account");
  },
};
