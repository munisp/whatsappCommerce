/**
 * J69 — Bureau retry & dispute (W14 F3). The durable outbox drains exactly
 * right:
 *   - 'pending' rows (disabled provider era) and 'failed' rows (provider
 *     outage era) are both re-attempted by retryFailedReports once a live
 *     provider is configured (injected FakeHttp — no network) → 'sent' with
 *     the upstream response recorded;
 *   - a DISPUTED row (markDisputed, NDPR data-subject right) is skipped by
 *     the sweep and never sent;
 *   - an account whose consent was withdrawn after logging is re-checked at
 *     retry time and excluded;
 *   - markDisputed returns the updated row, null for unknown ids.
 */
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { bureauLogRows, provisionCreditPair } from "./helpers";

export const journey: Journey = {
  id: "J69",
  name: "bureau retry & dispute",
  feature: "retryFailedReports sweep + markDisputed exclusion",
  async run(world) {
    const { drawOnCredit, applyRepayment } = await import("../../server/services/tradeCredit");
    const { retryFailedReports, markDisputed } = await import("../../server/services/compliance/bureau");
    const { makeFakeHttp } = await import("../../server/services/compliance/fakeHttp");

    // ── Account D: two pending rows (disabled provider era) ──────────────
    const d = await provisionCreditPair(world, { userIdBase: 691, name: "J69 Pending" });
    await d.supCaller.tradeCredit.approveAccount({
      supplierTenantId: d.sup, accountId: d.accountId, limitCents: 5_000_000, bureauConsent: true,
    });
    await drawOnCredit({ supplierTenantId: d.sup, buyerTenantId: d.buy, amountCents: 1_000_000, poId: "po-j69-d", termsDays: 14 });
    await applyRepayment({ accountId: d.accountId, amountCents: 400_000, ref: "repay:j69-d" });
    const dRows = await bureauLogRows(world, d.accountId);
    assert(dRows.length === 2 && dRows.every((r) => r.status === "pending"), "account D: two pending outbox rows");

    // ── Account E: one failed row (provider outage era) ──────────────────
    const e = await provisionCreditPair(world, { userIdBase: 693, name: "J69 Failed" });
    await e.supCaller.tradeCredit.approveAccount({
      supplierTenantId: e.sup, accountId: e.accountId, limitCents: 5_000_000, bureauConsent: true,
    });
    process.env.BUREAU_PROVIDER = "crc";
    process.env.BUREAU_API_BASE = "http://bureau.sim.local";
    try {
      await drawOnCredit({ supplierTenantId: e.sup, buyerTenantId: e.buy, amountCents: 200_000, poId: "po-j69-e", termsDays: 14 });
    } finally {
      delete process.env.BUREAU_PROVIDER;
      delete process.env.BUREAU_API_BASE;
    }
    const eRows = await bureauLogRows(world, e.accountId);
    assert(eRows.length === 1 && eRows[0].status === "failed", "account E: one failed row");

    // ── Account F: pending row, then consent withdrawn ───────────────────
    const f = await provisionCreditPair(world, { userIdBase: 695, name: "J69 Revoked" });
    await f.supCaller.tradeCredit.approveAccount({
      supplierTenantId: f.sup, accountId: f.accountId, limitCents: 5_000_000, bureauConsent: true,
    });
    await drawOnCredit({ supplierTenantId: f.sup, buyerTenantId: f.buy, amountCents: 300_000, poId: "po-j69-f", termsDays: 14 });
    await world.backdate(`UPDATE credit_accounts SET bureau_consent_at = NULL, bureau_consent_ref = NULL WHERE id = $1`, [f.accountId]);

    // ── Dispute one of D's rows before the sweep ─────────────────────────
    const disputed = await markDisputed(world.db, dRows[1].id);
    assert(disputed && disputed.status === "disputed", "markDisputed flips the row to disputed");
    const unknown = await markDisputed(world.db, "00000000-0000-0000-0000-000000000000");
    assert(unknown === null, "markDisputed returns null for an unknown id");

    // ── Sweep with a live provider (injected FakeHttp) ───────────────────
    const http = makeFakeHttp({
      routes: { "http://bureau.sim.local": { status: 200, body: { accepted: true, ref: "bureau-ack-1" } } },
    });
    const env = {
      BUREAU_PROVIDER: "customHttp",
      BUREAU_API_BASE: "http://bureau.sim.local/report",
      BUREAU_API_KEY: "sim-retry-key",
    } as NodeJS.ProcessEnv;
    const result = await retryFailedReports(world.db, { env, http });
    // attempted: D-disbursement (sent), D-repayment is disputed (not even
    // selected), E-failed (sent), F-pending (consent re-check excludes).
    assert(result.sent === 2 && result.failed === 0, `sweep sent the two eligible rows (${JSON.stringify(result)})`);

    const sentAccounts = http.requests.map((r) => JSON.parse(String(r.body)).account_ref);
    assert(sentAccounts.includes(d.accountId), "D disbursement re-sent");
    assert(sentAccounts.includes(e.accountId), "E failed row re-sent");
    assert(!sentAccounts.includes(f.accountId), "consent-withdrawn account excluded from the sweep");
    assert(sentAccounts.length === 2, "exactly two sends (disputed row never sent)");

    const dAfter = await bureauLogRows(world, d.accountId);
    assert(dAfter[0].status === "sent", "D disbursement sent");
    assert((dAfter[0].response as any)?.ref === "bureau-ack-1", "upstream response recorded on the sent row");
    assert(dAfter[0].bureau === "customHttp", "sent row carries the live adapter name");
    assert(dAfter[1].status === "disputed", "disputed row untouched by the sweep");

    const eAfter = await bureauLogRows(world, e.accountId);
    assert(eAfter[0].status === "sent", "E row recovered from failed → sent");

    const fAfter = await bureauLogRows(world, f.accountId);
    assert(fAfter.length === 1 && fAfter[0].status === "pending", "F row stays pending while consent is withdrawn");

    // ── Second sweep is a no-op (nothing eligible remains) ───────────────
    const again = await retryFailedReports(world.db, { env, http: makeFakeHttp({ routes: {} }) });
    assert(again.sent === 0 && again.failed === 0 && again.attempted === 1, `re-sweep only re-checks F (${JSON.stringify(again)})`);
  },
};
