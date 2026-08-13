/**
 * J72 — Credit hardening e2e (W14, W13.1 residuals).
 *
 * Part A — CREDIT_ENFORCEMENT_STRICT: with strict mode ON, a suspension
 * lookup outage (credit_accounts briefly renamed away — a real DB-level
 * failure against the unmodified query path) blocks PO submission with the
 * transient "credit status unavailable, try again" copy and persists NO PO;
 * the buyer's draft cart survives and submits once the outage clears. With
 * strict mode unset (test env default) the same outage fails OPEN (a paynow
 * PO still submits) — the historical behavior.
 *
 * Part B — settle-fail recovery: a durable zero-amount settlement_retry
 * ledger marker (the artifact capture.ts persists when a mandate charge
 * succeeds but settlement refuses) is retried via the admin
 * tradeCredit.retrySettlement procedure: settles exactly once with the SAME
 * reference, a double-call is an 'already_settled' no-op, unknown references
 * fail closed, and no dunning notice is re-sent.
 */
import { eq, like } from "drizzle-orm";
import { assert, bodyText, type World } from "../world";
import type { Journey } from "../runner";
import {
  ADMIN_PHONE,
  CREDIT_ACCOUNT_ID,
  SUPPLIER_TENANT_ID,
  TENANT_ID,
} from "../world";
import { adminCaller, catalogItemNumbers, creditAccount, enableProcurementMenu, restoreMenu } from "./helpers";
import { notifLogRows } from "../world";

export const journey: Journey = {
  id: "J72",
  name: "credit hardening e2e",
  feature: "strict fail-closed PO gate + exactly-once retrySettlement",
  async run(world) {
    const schema = await import("../../drizzle/schema");
    const admin = await adminCaller();
    const before = await enableProcurementMenu(world);

    const renameOut = () => world.backdate(`ALTER TABLE credit_accounts RENAME COLUMN buyer_tenant_id TO buyer_tenant_id_w14outage`);
    const renameBack = () => world.backdate(`ALTER TABLE credit_accounts RENAME COLUMN buyer_tenant_id_w14outage TO buyer_tenant_id`);
    const poCount = async () =>
      (await world.db.select().from(schema.purchaseOrders).where(eq(schema.purchaseOrders.buyerTenantId, TENANT_ID))).length;

    /** Drive a procurement cart up to (but not past) CONFIRM. */
    const buildCart = async (phone: string, payment: "credit" | "paynow") => {
      await world.text(phone, "menu");
      await world.text(phone, "4");
      await world.text(phone, "1");
      await world.text(phone, "1");
      const numbers = catalogItemNumbers(bodyText(world.outbound.lastOfType("text", phone)));
      await world.text(phone, `add ${numbers.get("PET Preforms 500ml")} 100`);
      await world.text(phone, "done");
      await world.text(phone, payment === "credit" ? "1" : "2");
      if (payment === "credit") await world.text(phone, "2"); // net 14
    };

    try {
      // ── A1. STRICT: lookup outage blocks the credit PO submit ──────────
      const phoneA = world.newPhone("7");
      await world.grantConsent(phoneA);
      await buildCart(phoneA, "credit");
      const posBefore = await poCount();
      process.env.CREDIT_ENFORCEMENT_STRICT = "true";
      // Capture console.info: while the outage window disturbs the
      // tenant-creds lookup the block reply takes waSender's simulated path
      // (logged, not posted to the Graph mock), so the log line is where the
      // exact buyer-facing copy is observable.
      const infos: string[] = [];
      const origInfo = console.info;
      console.info = (...args: any[]) => { infos.push(args.map(String).join(" ")); };
      await renameOut();
      try {
        await world.text(phoneA, "CONFIRM");
      } finally {
        await renameBack();
        console.info = origInfo;
      }
      const blocked = infos.find((m) => m.includes("couldn't confirm your credit status"));
      assert(blocked, "strict outage produced the credit-unavailable reply");
      assert(!blocked.includes("Ordering is suspended"), "W14.1: transient outage is NOT dunning copy (no 'Ordering is suspended')");
      assert(!blocked.includes("Repay your outstanding"), "W14.1: transient outage is NOT dunning copy (no repay guidance)");
      // (The "resend CONFIRM" tail is truncated in the log — the neutral
      // copy + no-dunning assertions above cover the copy; cart survival is
      // proven behaviorally below by the plain-CONFIRM resubmit.)
      // (Cart survival is proven behaviorally below: the same cart submits
      // once the outage clears — the reply tail is truncated in the log.)
      assert((await poCount()) === posBefore, "NO PO persisted while the gate fails closed");

      // Recovery: outage cleared. W14.1 — the suspension block keeps the
      // confirm session alive, so the SAME draft cart submits on a plain
      // CONFIRM resend (no cart rebuild).
      await world.text(phoneA, "CONFIRM");
      assert((await poCount()) === posBefore + 1, "PO submits after the outage clears (session survived the block)");
      delete process.env.CREDIT_ENFORCEMENT_STRICT;

      // ── A2. DEFAULT (test env): same outage fails OPEN for paynow ──────
      const phoneB = world.newPhone("8");
      await world.grantConsent(phoneB);
      await buildCart(phoneB, "paynow");
      const posBeforeB = await poCount();
      await renameOut();
      try {
        await world.text(phoneB, "CONFIRM");
      } finally {
        await renameBack();
      }
      assert((await poCount()) === posBeforeB + 1, "fail-open default: paynow PO submits during the outage");

      // ── B. settle-fail marker → exactly-once admin retry ───────────────
      const { drawOnCredit } = await import("../../server/services/tradeCredit");
      const draw = await drawOnCredit({
        supplierTenantId: SUPPLIER_TENANT_ID,
        buyerTenantId: TENANT_ID,
        amountCents: 5_000_000,
        poId: "po-j72-settle",
        termsDays: 14,
      });
      assert(draw.ok === true, "seed draw for the settle-fail path");
      const REF = "cr-j72-ref-000001";
      await world.db.insert(schema.creditLedger).values({
        creditAccountId: CREDIT_ACCOUNT_ID,
        kind: "adjustment",
        amountCents: 0,
        ref: REF,
        note: `[settlement_retry] {"amountCents":2000000}`,
      });
      const dunningToAdmin = () =>
        world.outbound.toPhone(ADMIN_PHONE).filter((c) => bodyText(c).includes("couldn't collect")).length;
      const dunningBefore = dunningToAdmin();

      const first = await admin.tradeCredit.retrySettlement({ accountId: CREDIT_ACCOUNT_ID, reference: REF });
      assert(first.ok === true && first.status === "settled", `retry settles (${JSON.stringify(first)})`);
      assert(first.outstandingAfter === 3_000_000, "amount recovered from the marker note");
      assert(Number((await creditAccount(world)).outstandingCents) === 3_000_000, "outstanding decremented exactly once");
      const markers = await world.db
        .select()
        .from(schema.creditLedger)
        .where(like(schema.creditLedger.note, "[settlement_retry]%"));
      assert(markers.length === 0, "marker consumed by the retry");

      const second = await admin.tradeCredit.retrySettlement({ accountId: CREDIT_ACCOUNT_ID, reference: REF });
      assert(second.ok === true && second.status === "already_settled", "double-call is an already_settled no-op");
      const repayments = (await world.db.select().from(schema.creditLedger).where(eq(schema.creditLedger.creditAccountId, CREDIT_ACCOUNT_ID)))
        .filter((r: any) => r.kind === "repayment" && r.ref === REF);
      assert(repayments.length === 1, "exactly one repayment ledger row across both calls");
      assert(Number((await creditAccount(world)).outstandingCents) === 3_000_000, "outstanding unchanged by the no-op");
      assert(dunningToAdmin() === dunningBefore, "no dunning notice re-triggered by the retry");

      const unknown = await admin.tradeCredit.retrySettlement({ accountId: CREDIT_ACCOUNT_ID, reference: "cr-j72-nope" });
      assert(unknown.ok === false && unknown.status === "no_pending_retry", "unknown reference fails closed");
    } finally {
      delete process.env.CREDIT_ENFORCEMENT_STRICT;
      // Safety net: never leave the outage table behind.
      await world.backdate(`ALTER TABLE credit_accounts RENAME COLUMN buyer_tenant_id_w14outage TO buyer_tenant_id`).catch(() => {});
      await restoreMenu(world, before);
    }
  },
};
