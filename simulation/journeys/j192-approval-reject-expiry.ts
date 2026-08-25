/**
 * J192 — W31 approvals: reject moves nothing (wallet untouched + audit
 * trail); expiry sweep flips stale pending requests to 'expired' via the
 * /api/scheduled/approvals-expiry cron route; expired requests cannot be
 * approved (CONFLICT); threshold 0 disables approvals honestly.
 */
import { eq, and } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { approveKyb, expectTrpcError, tenantCaller } from "./helpers";

const TID = "j192-tenant";

export const journey: Journey = {
  id: "J192",
  name: "reject moves nothing + audit; expiry sweep expires stale requests; threshold 0 = off",
  feature: "W31 approvals: reject path + sweepExpiredApprovals cron + honest policy-off semantics",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");

    await world.db.insert(schema.tenants).values({
      id: TID, name: "J192 Approvals", slug: TID, status: "active",
    }).onConflictDoNothing();
    await approveKyb(world, TID);
    const [ownerUser] = await world.db.insert(schema.users).values({
      openId: "j192-owner", email: "j192-owner@sim.local", name: "J192 Owner",
      loginMethod: "keycloak", role: "user", tenantId: TID, phone: "+2348019200001", lastSignedIn: new Date(),
    }).returning();
    await world.db.insert(schema.tenantMemberships).values({
      tenantId: TID, userId: String(ownerUser.id), role: "owner",
    }).onConflictDoNothing();
    const owner = await tenantCaller(TID, { userId: ownerUser.id });

    await world.db.update(schema.escrowConfig).set({ custodyMode: "psp" })
      .where(eq(schema.escrowConfig.id, 1));
    await world.db.insert(schema.merchantWallets).values({
      tenantId: TID,
      custodyMode: "psp",
      availableBalance: "20000.00",
      bankAccountName: "J192 Merchant",
      bankAccountNumber: "0987654321",
      bankCode: "058",
    }).onConflictDoNothing();

    await owner.approvals.setPolicy({
      tenantId: TID, thresholdCents: 10_000, kinds: ["withdrawal"], approverRole: "owner", expiryHours: 72,
    });

    // ── 1. Reject: nothing moves, decision audited ──────────────────────
    const parked = await owner.wallet.requestWithdrawal({ tenantId: TID, amount: 300 });
    assert(parked.status === "pending_approval", "withdrawal parked for approval");
    const rejected = await owner.approvals.reject({
      tenantId: TID, approvalId: parked.approvalId, note: "not this month",
    });
    assert(rejected.status === "rejected", `request rejected (got ${rejected.status})`);
    const [walletAfterReject] = await world.db.select().from(schema.merchantWallets)
      .where(eq(schema.merchantWallets.tenantId, TID));
    assert(walletAfterReject.availableBalance === "20000.00", "reject moved nothing");
    const txRows = await world.db.select().from(schema.walletTransactions)
      .where(eq(schema.walletTransactions.tenantId, TID));
    assert(txRows.length === 0, "no wallet ledger rows for a rejected request");
    const auditRows = await world.db.select().from(schema.auditLogs)
      .where(and(eq(schema.auditLogs.tenantId, TID), eq(schema.auditLogs.action, "approval.rejected")));
    assert(auditRows.length === 1, "rejection written to the audit log");
    // A rejected request cannot be re-decided.
    await expectTrpcError(
      owner.approvals.approve({ tenantId: TID, approvalId: parked.approvalId }),
      "CONFLICT",
      "rejected request cannot later be approved",
    );

    // ── 2. Expiry sweep: stale pending request → expired ────────────────
    const stale = await owner.wallet.requestWithdrawal({ tenantId: TID, amount: 200 });
    assert(stale.status === "pending_approval", "second withdrawal parked");
    await world.db.update(schema.approvalRequests)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(schema.approvalRequests.id, stale.approvalId));
    const cron = await world.runCron("/api/scheduled/approvals-expiry");
    assert(cron.status === 200 && cron.json?.ok === true, `expiry cron ran (${cron.status})`);
    assert(cron.json.expired >= 1, `cron expired >=1 request (got ${cron.json.expired})`);
    const [expiredRow] = await world.db.select().from(schema.approvalRequests)
      .where(eq(schema.approvalRequests.id, stale.approvalId));
    assert(expiredRow.status === "expired", `stale request expired (got ${expiredRow.status})`);
    await expectTrpcError(
      owner.approvals.approve({ tenantId: TID, approvalId: stale.approvalId }),
      "CONFLICT",
      "expired request cannot be approved",
    );
    const [walletAfterExpiry] = await world.db.select().from(schema.merchantWallets)
      .where(eq(schema.merchantWallets.tenantId, TID));
    assert(walletAfterExpiry.availableBalance === "20000.00", "expiry moved nothing");

    // ── 3. Threshold 0 = approvals OFF (honest default) ─────────────────
    await owner.approvals.setPolicy({ tenantId: TID, thresholdCents: 0 });
    const direct = await owner.wallet.requestWithdrawal({ tenantId: TID, amount: 150 });
    assert(direct.success === true && direct.status !== "pending_approval", "policy off → direct execution");
    const [walletFinal] = await world.db.select().from(schema.merchantWallets)
      .where(eq(schema.merchantWallets.tenantId, TID));
    assert(walletFinal.availableBalance === "19850.00", `direct withdrawal debited once (got ${walletFinal.availableBalance})`);
  },
};
