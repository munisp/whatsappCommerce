/**
 * J78 — W14.1 regression e2e.
 *
 * Part A — repayment exactly-once (migration 0052): two CONCURRENT
 * retrySettlement calls for the same reference with NO durable marker (the
 * marker-persist failure the W14.1 index defends against — explicit
 * amountCents supplied) → exactly one repayment ledger row, one 'settled' +
 * one 'already_settled', outstanding decremented exactly once. A direct
 * concurrent applyRepaymentTx pair deterministically exercises the 23505 →
 * alreadySettled translation.
 *
 * Part B — poFlow suspension preserves the session: a suspended buyer's
 * CONFIRM is blocked with DUNNING copy ("Ordering is suspended … Repay your
 * outstanding balance"), no PO persists, and the draft cart SURVIVES; after
 * repay-to-zero auto-lifts the suspension the buyer resends a plain CONFIRM
 * (no cart rebuild) and the order completes.
 *
 * Part C — copy polarity: transient outage (unavailable) renders the neutral
 * orderingUnavailable copy, never the dunning accusation.
 */
import { eq } from "drizzle-orm";
import { assert, bodyText, type World } from "../world";
import type { Journey } from "../runner";
import { CREDIT_ACCOUNT_ID, SUPPLIER_TENANT_ID, TENANT_ID } from "../world";
import {
  adminCaller,
  catalogItemNumbers,
  creditAccount,
  enableProcurementMenu,
  restoreMenu,
} from "./helpers";

export const journey: Journey = {
  id: "J78",
  name: "w14.1 credit regression e2e",
  feature: "repayment 23505 exactly-once + suspension session survival + copy polarity",
  async run(world) {
    const schema = await import("../../drizzle/schema");
    const admin = await adminCaller();
    const { drawOnCredit, applyRepayment } = await import("../../server/services/tradeCredit");
    const { applyRepaymentTx } = await import("../../server/services/tradeCredit/repayment");
    const { suspensionMessage } = await import("../../server/services/procurement/creditEnforcement");
    const before = await enableProcurementMenu(world);

    const poCount = async () =>
      (await world.db.select().from(schema.purchaseOrders).where(eq(schema.purchaseOrders.buyerTenantId, TENANT_ID))).length;
    const repaymentRows = async (ref: string) =>
      (await world.db.select().from(schema.creditLedger).where(eq(schema.creditLedger.creditAccountId, CREDIT_ACCOUNT_ID)))
        .filter((r: any) => r.kind === "repayment" && r.ref === ref);

    try {
      // ── A1. Concurrent retrySettlement, marker-persist failure ───────────
      const drawA = await drawOnCredit({
        supplierTenantId: SUPPLIER_TENANT_ID,
        buyerTenantId: TENANT_ID,
        amountCents: 5_000_000,
        poId: "po-j78-a",
        termsDays: 14,
      });
      assert(drawA.ok === true, "seed draw for the concurrent-retry race");
      const REF_A = "cr-j78-race-0001";
      // No settlement_retry marker exists (its persist failed after the charge
      // succeeded) — both retries carry the explicit amount and race.
      const [r1, r2] = await Promise.all([
        admin.tradeCredit.retrySettlement({ accountId: CREDIT_ACCOUNT_ID, reference: REF_A, amountCents: 2_000_000 }),
        admin.tradeCredit.retrySettlement({ accountId: CREDIT_ACCOUNT_ID, reference: REF_A, amountCents: 2_000_000 }),
      ]);
      const statuses = [r1.status, r2.status].sort();
      assert(
        statuses.join(",") === "already_settled,settled",
        `exactly one winner + one already_settled no-op (got ${statuses.join(",")})`,
      );
      assert((await repaymentRows(REF_A)).length === 1, "exactly ONE repayment ledger row across the race");
      assert(
        Number((await creditAccount(world)).outstandingCents) === 3_000_000,
        "outstanding decremented exactly once",
      );

      // ── A2. Deterministic 23505 → alreadySettled translation ─────────────
      const REF_B = "cr-j78-race-0002";
      const [t1, t2] = await Promise.all([
        applyRepaymentTx(world.db, { accountId: CREDIT_ACCOUNT_ID, amountCents: 1_000_000, ref: REF_B }),
        applyRepaymentTx(world.db, { accountId: CREDIT_ACCOUNT_ID, amountCents: 1_000_000, ref: REF_B }),
      ]);
      assert(t1.ok && t2.ok, "both concurrent repayments report ok");
      assert(
        [t1.alreadySettled === true, t2.alreadySettled === true].filter(Boolean).length === 1,
        "exactly one loser translated 23505 → alreadySettled",
      );
      assert((await repaymentRows(REF_B)).length === 1, "one repayment row for ref B");
      assert(
        Number((await creditAccount(world)).outstandingCents) === 2_000_000,
        "outstanding reflects exactly two repayments total",
      );

      // ── B. Suspended PO submit preserves the session ─────────────────────
      const phone = world.newPhone("7");
      await world.grantConsent(phone);
      await world.text(phone, "menu");
      await world.text(phone, "4");
      await world.text(phone, "1");
      await world.text(phone, "1");
      const numbers = catalogItemNumbers(bodyText(world.outbound.lastOfType("text", phone)));
      await world.text(phone, `add ${numbers.get("PET Preforms 500ml")} 100`);
      await world.text(phone, "done");
      await world.text(phone, "1"); // pay on credit
      await world.text(phone, "2"); // net 14

      // Suspend the facility (dunning freeze) with the ₦20,000 outstanding.
      await world.db
        .update(schema.creditAccounts)
        .set({ suspended: true, suspendedAt: new Date(), suspensionReason: "dunning +7d freeze", updatedAt: new Date() })
        .where(eq(schema.creditAccounts.id, CREDIT_ACCOUNT_ID));

      const posBefore = await poCount();
      await world.text(phone, "CONFIRM");
      const blockedReply = bodyText(world.outbound.lastOfType("text", phone));
      assert(
        blockedReply.includes("Ordering is suspended with this supplier"),
        `suspension block uses dunning copy (got ${blockedReply.slice(0, 200)})`,
      );
      assert(
        blockedReply.includes("Repay your outstanding balance"),
        "dunning copy carries repay guidance",
      );
      assert(
        !blockedReply.includes("couldn't confirm your credit status"),
        "dunning is NOT the neutral outage copy",
      );
      assert((await poCount()) === posBefore, "no PO persisted while suspended");

      // Repay to zero → suspension auto-lifts in the same transaction.
      const repay = await applyRepayment({ accountId: CREDIT_ACCOUNT_ID, amountCents: 2_000_000, ref: "repay:j78-lift" });
      assert(repay.ok === true && repay.outstandingAfter === 0, "repay-to-zero lands");
      const lifted = await creditAccount(world);
      assert(lifted.suspended === false && lifted.suspensionReason == null, "suspension auto-lifted on repay-to-zero");

      // W14.1: the draft cart SURVIVED the block — plain CONFIRM resubmits.
      await world.text(phone, "CONFIRM");
      assert((await poCount()) === posBefore + 1, "PO submitted after repay-to-zero (session preserved)");
      const doneReply = bodyText(world.outbound.lastOfType("text", phone));
      assert(doneReply.includes("submitted"), `order completes after resubmit (got ${doneReply.slice(0, 160)})`);

      // ── C. Copy polarity at the seam ─────────────────────────────────────
      const fmt = (c: number) => `₦${(c / 100).toLocaleString("en-NG")}`;
      const neutral = suspensionMessage({ suspended: true, unavailable: true, reason: null, outstandingCents: null }, fmt);
      assert(
        neutral.includes("couldn't confirm your credit status") &&
          !neutral.includes("Repay your outstanding") &&
          !neutral.includes("Ordering is suspended"),
        "transient outage renders neutral try-again copy",
      );
      const dunning = suspensionMessage(
        { suspended: true, reason: "dunning +7d freeze", outstandingCents: 2_000_000 },
        fmt,
      );
      assert(
        dunning.includes("Ordering is suspended") && dunning.includes("Repay your outstanding balance"),
        "real suspension renders dunning repay copy",
      );
    } finally {
      await restoreMenu(world, before);
    }
  },
};
