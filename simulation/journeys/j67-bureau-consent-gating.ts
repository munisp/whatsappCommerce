/**
 * J67 — Bureau consent gating (W14 F3). reportEvent is consent-gated:
 *   1. facility approved WITHOUT bureauConsent → no bureau_consent_at stamp,
 *      a consent_missing warning is surfaced, and draws/repayments on the
 *      account log ZERO bureau_report_log rows;
 *   2. facility approved WITH bureauConsent → bureau_consent_at/ref stamped
 *      (deterministic bcr:<accountId> ref) and draw/repayment events land in
 *      bureau_report_log ('pending' under the default disabled provider);
 *   3. repayment-to-zero additionally emits the 'cure' event.
 */
import { eq } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { bureauLogRows, provisionCreditPair } from "./helpers";

export const journey: Journey = {
  id: "J67",
  name: "bureau consent gating",
  feature: "reportEvent consent gate + consent_missing warning",
  async run(world) {
    const schema = await import("../../drizzle/schema");
    const { drawOnCredit, applyRepayment } = await import("../../server/services/tradeCredit");

    // Capture console.warn to observe the consent_missing ops warning.
    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: any[]) => { warns.push(args.map(String).join(" ")); };

    try {
      // ── 1. Approval WITHOUT consent → excluded from reporting ──────────
      const a = await provisionCreditPair(world, { userIdBase: 671, name: "J67 NoConsent" });
      const approvedA = await a.supCaller.tradeCredit.approveAccount({
        supplierTenantId: a.sup,
        accountId: a.accountId,
        limitCents: 5_000_000, // exactly the micro-credit floor — no mandate needed
      });
      assert(approvedA.status === "active", "consentless approval still activates (consent is advisory)");
      const [rowA] = await world.db.select().from(schema.creditAccounts).where(eq(schema.creditAccounts.id, a.accountId)).limit(1);
      assert(rowA.bureauConsentAt == null && rowA.bureauConsentRef == null, "no consent stamp without bureauConsent");
      assert(
        warns.some((w) => w.includes("consent_missing") && w.includes(a.accountId)),
        "consentless approval surfaces the consent_missing warning",
      );

      const drawA = await drawOnCredit({
        supplierTenantId: a.sup,
        buyerTenantId: a.buy,
        amountCents: 1_000_000,
        poId: "po-j67-a",
        termsDays: 14,
      });
      assert(drawA.ok === true, "draw on the non-consented account succeeds (bureau never blocks money)");
      const repayA = await applyRepayment({ accountId: a.accountId, amountCents: 400_000, ref: "repay:j67-a" });
      assert(repayA.ok === true, "repayment on the non-consented account succeeds");
      assert((await bureauLogRows(world, a.accountId)).length === 0, "ZERO bureau events without consent");

      // ── 2. Approval WITH consent → stamped + reported ──────────────────
      const b = await provisionCreditPair(world, { userIdBase: 673, name: "J67 Consent" });
      warns.length = 0;
      const approvedB = await b.supCaller.tradeCredit.approveAccount({
        supplierTenantId: b.sup,
        accountId: b.accountId,
        limitCents: 5_000_000,
        bureauConsent: true,
      });
      assert(approvedB.status === "active", "consented approval activates");
      const [rowB] = await world.db.select().from(schema.creditAccounts).where(eq(schema.creditAccounts.id, b.accountId)).limit(1);
      assert(rowB.bureauConsentAt != null, "bureau_consent_at stamped on approval");
      assert(rowB.bureauConsentRef === `bcr:${b.accountId}`, `deterministic consent ref (got ${rowB.bureauConsentRef})`);
      assert(!warns.some((w) => w.includes("consent_missing")), "no consent_missing warning when consent given");

      const drawB = await drawOnCredit({
        supplierTenantId: b.sup,
        buyerTenantId: b.buy,
        amountCents: 1_000_000,
        poId: "po-j67-b",
        termsDays: 14,
      });
      assert(drawB.ok === true, "draw on the consented account succeeds");
      const afterDraw = await bureauLogRows(world, b.accountId);
      assert(afterDraw.length === 1 && afterDraw[0].eventType === "disbursement", "draw logs ONE disbursement event");
      assert(afterDraw[0].status === "pending" && afterDraw[0].bureau === "disabled", "default provider: logged pending, never sent");

      // ── 3. Repayment-to-zero → repayment + cure ────────────────────────
      const repayB = await applyRepayment({ accountId: b.accountId, amountCents: 1_000_000, ref: "repay:j67-b" });
      assert(repayB.ok === true && repayB.outstandingAfter === 0, "full repayment lands");
      const finalRows = await bureauLogRows(world, b.accountId);
      const types = finalRows.map((r) => r.eventType);
      assert(
        types.join(",") === "disbursement,repayment,cure",
        `consented lifecycle events disbursement→repayment→cure (got ${types.join(",")})`,
      );
      assert(finalRows.every((r) => r.status === "pending"), "all events pending under the disabled provider");
    } finally {
      console.warn = origWarn;
    }
  },
};
