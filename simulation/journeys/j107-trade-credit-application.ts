/**
 * J107 — S1: merchant applies for trade credit end-to-end.
 *
 *   1. Seed the supplier's credit book (21 clean + 21 late/defaulted buyers)
 *      so the per-tenant ML PD model clears the 40-sample training gate.
 *   2. tradeCredit.trainPdModel trains the tenant model deterministically;
 *      scorePd on the applicant returns model-backed PD (no fallback) and
 *      PD(known-bad buyer) > PD(applicant).
 *   3. Bureau pull in SANDBOX mode (BUREAU_PULL_PROVIDER=sandbox,
 *      BUREAU_PULL_REQUIRED=true): a clean subject approves; a subject whose
 *      deterministic sandbox report shows active defaults is hard-declined
 *      with BureauPullDeclinedError — both probed deterministically via
 *      pullBureauReport before approval.
 *   4. Approval snapshots the expected-loss fee (feeBps) + score-band tenor
 *      on the credit account; the bureau_pull audit row is logged.
 *   5. Tenant guards: cross-tenant trainPdModel / pdModelStatus FORBIDDEN.
 */
import { randomUUID } from "crypto";
import { eq, and } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { adminCaller, expectTrpcError, tenantCaller } from "./helpers";

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const N_EACH = 21;

export const journey: Journey = {
  id: "J107",
  name: "trade credit application + PD + bureau sandbox",
  feature: "seeded PD training, sandbox bureau pull gate, terms band + expected-loss fee snapshot, tenant guards",
  async run(world) {
    const schema = await import("../../drizzle/schema");
    const admin = await adminCaller();
    const sup = (await admin.onboarding.start({ name: "J107 Supplier" })).tenantId;
    const buyer = (await admin.onboarding.start({ name: "J107 Applicant" })).tenantId;
    const supCaller = await tenantCaller(sup, { userId: 1070 });
    const buyCaller = await tenantCaller(buyer, { userId: 1071 });
    const intruder = await tenantCaller((await admin.onboarding.start({ name: "J107 Intruder" })).tenantId, { userId: 1072 });

    // ── 1. Seed the supplier's credit book ────────────────────────────────
    const now = Date.now();
    const seedBuyer = async (id: string, clean: boolean) => {
      for (const [k, daysAgo] of [[0, 120], [1, 10]] as const) {
        await world.db.insert(schema.orders).values({
          id: `j107-ord-${id}-${k}`, tenantId: id, customerId: `j107-cust-${id}`,
          orderNumber: `J107-${id}-${k}`, status: "delivered",
          totalAmount: "500000.00", currency: "NGN",
          createdAt: new Date(now - daysAgo * DAY), updatedAt: new Date(now - daysAgo * DAY),
        }).onConflictDoNothing();
      }
      const created = new Date(now - 20 * DAY);
      await world.db.insert(schema.paymentTransactions).values({
        id: `j107-pay-${id}`, tenantId: id, provider: "paystack", providerRef: `J107PAY-${id}`,
        amount: "1000.00", currency: "NGN", status: "completed",
        createdAt: created, paidAt: new Date(created.getTime() + (clean ? 1 : 72) * HOUR),
      }).onConflictDoNothing();
      const accountId = randomUUID();
      await world.db.insert(schema.creditAccounts).values({
        id: accountId, supplierTenantId: sup, buyerTenantId: id,
        limitCents: 30_000_000, outstandingCents: 0, termsDays: 30, status: "active",
      });
      await world.db.insert(schema.creditLedger).values({
        creditAccountId: accountId, kind: "invoice_draw", amountCents: 5_000_000,
        poId: `po-j107-${id}`, ref: `draw:po-j107-${id}`,
        status: clean ? "settled" : "posted",
        dueDate: new Date(now - 15 * DAY),
        note: clean ? null : "late fee applied [dun:fee]",
        createdAt: new Date(now - 40 * DAY),
      });
      if (!clean) {
        // Late but repaid to zero: label 1 via late marker (cured at zero).
        await world.db.insert(schema.creditLedger).values({
          creditAccountId: accountId, kind: "repayment", amountCents: 5_000_000,
          ref: `repay:j107-${id}`, createdAt: new Date(now - 10 * DAY),
        });
        await world.db.update(schema.creditLedger)
          .set({ status: "settled" })
          .where(and(eq(schema.creditLedger.ref, `draw:po-j107-${id}`), eq(schema.creditLedger.creditAccountId, accountId)));
      }
    };
    for (let i = 0; i < N_EACH; i++) {
      await seedBuyer(`j107-good-${i}`, true);
      await seedBuyer(`j107-bad-${i}`, false);
    }

    // ── 2. Train the tenant PD model (deterministic) ──────────────────────
    const trained = await supCaller.tradeCredit.trainPdModel({ tenantId: sup });
    assert(trained.trained === true && trained.sampleCount === 2 * N_EACH, `PD model trained on ${2 * N_EACH} samples`);
    assert(trained.version === 1, "first model version");
    await expectTrpcError(intruder.tradeCredit.trainPdModel({ tenantId: sup }), "FORBIDDEN", "cross-tenant train rejected");
    await expectTrpcError(intruder.tradeCredit.pdModelStatus({ tenantId: sup }), "FORBIDDEN", "cross-tenant status rejected");

    const ml = await import("../../server/services/tradeCredit/mlPdScoring");
    const tc = await import("../../server/services/tradeCredit");

    // Applicant's own platform history (orders + on-time payment, no credit).
    for (const [k, daysAgo] of [[0, 150], [1, 8]] as const) {
      await world.db.insert(schema.orders).values({
        id: `j107-ord-applicant-${k}`, tenantId: buyer, customerId: "j107-cust-applicant",
        orderNumber: `J107-APP-${k}`, status: "delivered",
        totalAmount: "800000.00", currency: "NGN",
        createdAt: new Date(now - daysAgo * DAY), updatedAt: new Date(now - daysAgo * DAY),
      }).onConflictDoNothing();
    }
    const payCreated = new Date(now - 8 * DAY);
    await world.db.insert(schema.paymentTransactions).values({
      id: "j107-pay-applicant", tenantId: buyer, provider: "paystack", providerRef: "J107PAY-APP",
      amount: "8000.00", currency: "NGN", status: "completed",
      createdAt: payCreated, paidAt: new Date(payCreated.getTime() + HOUR),
    }).onConflictDoNothing();

    const pdApplicant = await ml.scorePd(world.db, sup, buyer);
    assert(pdApplicant.fallbackUsed === false && pdApplicant.modelScope === "tenant", "model-backed PD for applicant");
    const pdBad = await ml.scorePd(world.db, sup, "j107-bad-0");
    assert(pdBad.pd > pdApplicant.pd, `PD(bad) ${pdBad.pd} > PD(applicant) ${pdApplicant.pd}`);

    // ── 3+4. Bureau sandbox gate + approval with terms + EL fee snapshot ──
    const bureau = await import("../../server/services/tradeCredit/bureauPull");
    const { bureauConsentRef } = await import("../../server/services/tradeCredit/accounts");
    const env = {
      ...process.env,
      BUREAU_PULL_PROVIDER: "sandbox",
      BUREAU_PULL_REQUIRED: "true",
      BUREAU_PULL_MIN_SCORE: "200",
    };
    // The sandbox report is sha256(subject fields + consentRef) — the REAL
    // approval pull uses the account's bureauConsentRef, so probe with that
    // exact ref (derived per-run from the account id created below).
    // Probe deterministic sandbox reports against the account's OWN consent
    // refs: find a clean subject (approve) and a defaulted subject (decline).
    // Merchant applies for credit (with bureau consent).
    const requested = await buyCaller.tradeCredit.requestAccount({
      buyerTenantId: buyer, supplierTenantId: sup, note: "J107 application", bureauConsent: true,
    });
    const accountId = (requested as any).id;
    assert(typeof accountId === "string", "application created the account");

    let cleanName = "", dirtyName = "";
    const cleanRef = bureauConsentRef(accountId);
    for (let i = 0; i < 400 && !cleanName; i++) {
      const name = `J107 Applicant Probe ${i}`;
      const probe = await bureau.pullBureauReport({ businessName: name }, cleanRef, { env });
      if (probe.report && probe.report.activeDefaults === 0 && (probe.report.score ?? 0) >= 200) cleanName = name;
    }
    const { requestCreditAccountTx: reqAcct } = await import("../../server/services/tradeCredit/accounts");
    const dirtyAccount = await reqAcct(world.db, {
      buyerTenantId: "j107-dirty-applicant", supplierTenantId: sup, bureauConsent: true,
    });
    const dirtyRef = bureauConsentRef(dirtyAccount.id);
    for (let i = 0; i < 400 && !dirtyName; i++) {
      const name = `J107 Declined Probe ${i}`;
      const probe = await bureau.pullBureauReport({ businessName: name }, dirtyRef, { env });
      if (probe.report && probe.report.activeDefaults > 0) dirtyName = name;
    }
    assert(cleanName && dirtyName, "sandbox probe found clean + defaulted subjects");

    const prevEnv = { ...process.env };

    // Rule-score the applicant → terms band; EL fee from the trained PD.
    const suggestion = await supCaller.tradeCredit.suggestLimit({ supplierTenantId: sup, buyerTenantId: buyer });
    assert(typeof suggestion.score === "number" && suggestion.score > 0, "applicant scored");
    const band = tc.termsForScore(suggestion.score);
    assert(band.decline === false, "applicant inside an approval band");
    const el = ml.expectedLossTerms(pdApplicant.pd, band.tenorDays);
    assert(el.feeBps >= 0 && el.feeBps <= ml.EL_PRICING.maxFeeBps, `EL fee ${el.feeBps}bps within envelope`);

    // Merchant applies for credit (with bureau consent).
    Object.assign(process.env, {
      BUREAU_PULL_PROVIDER: "sandbox",
      BUREAU_PULL_REQUIRED: "true",
      BUREAU_PULL_MIN_SCORE: "200",
    });
    try {
      // Declined subject first: hard BureauPullDeclinedError, account stays pending.
      const { approveCreditAccountTx, BureauPullDeclinedError } = await import("../../server/services/tradeCredit/accounts");
      let declineCaught = false;
      try {
        await approveCreditAccountTx(world.db, {
          accountId: dirtyAccount!.id, supplierTenantId: sup,
          subject: { businessName: dirtyName },
        });
      } catch (e: any) {
        declineCaught = e instanceof BureauPullDeclinedError && e.reason === "bureau_report";
      }
      assert(declineCaught, "defaulted sandbox report hard-declines approval");
      const [dirtyRow] = await world.db.select().from(schema.creditAccounts)
        .where(eq(schema.creditAccounts.id, dirtyAccount!.id)).limit(1);
      assert(dirtyRow.status === "pending", "declined account stays pending");

      // Clean approval: bureau pulled, terms band tenor + EL fee snapshot.
      const approved = await approveCreditAccountTx(world.db, {
        accountId, supplierTenantId: sup,
        limitCents: suggestion.suggestedLimitCents,
        termsDays: band.tenorDays,
        feeBps: el.feeBps,
        bureauConsent: true,
        subject: { businessName: cleanName },
      });
      assert(approved && approved.status === "active", "account approved active");
      assert((approved as any).bureauPull?.bureauPulled === true && (approved as any).bureauPull?.provider === "sandbox", "sandbox bureau pull attached");
      assert(approved.termsDays === band.tenorDays, `tenor snapped to band (${band.tenorDays}d)`);
      assert((approved as any).feeBps === el.feeBps, `feeBps snapshot = EL fee ${el.feeBps}`);
      assert(approved.limitCents === suggestion.suggestedLimitCents, "limit matches suggestion");

      // Audit: bureau_pull rows logged for both the decline and the approval.
      const logs = await world.db.select().from(schema.bureauReportLog)
        .where(eq(schema.bureauReportLog.eventType, "bureau_pull")).limit(50);
      assert(logs.some((l: any) => l.accountId === accountId && l.status === "sent"), "approval bureau_pull audit logged");
      assert(logs.some((l: any) => l.accountId === dirtyAccount!.id), "decline bureau_pull audit logged");
    } finally {
      for (const k of ["BUREAU_PULL_PROVIDER", "BUREAU_PULL_REQUIRED", "BUREAU_PULL_MIN_SCORE"]) {
        if ((prevEnv as any)[k] === undefined) delete process.env[k];
        else process.env[k] = (prevEnv as any)[k];
      }
    }
  },
};
