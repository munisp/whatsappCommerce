/**
 * J174 — W30 KYB gate on money paths (V2#1): an UNVERIFIED tenant (no
 * approved KYB application) is blocked — fail-closed FORBIDDEN — from
 * escrow.createHold, wallet.requestWithdrawal and credit.accept. After KYB
 * approval the same calls pass the gate and fail only on their normal
 * business preconditions (never FORBIDDEN/KYB).
 */
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { approveKyb, expectTrpcError, tenantCaller } from "./helpers";

const TID = "j174-tenant";

export const journey: Journey = {
  id: "J174",
  name: "KYB gate blocks withdrawal/hold/loan for unverified tenants",
  feature: "kycGate on createHold + requestWithdrawal + credit.accept",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");

    // Fresh tenant with NO KYB application + an owner membership so the
    // role-aware guards pass and the KYB gate is the ONLY thing that can
    // block.
    await world.db.insert(schema.tenants).values({
      id: TID, name: "J174 Unverified", slug: TID, status: "active",
    }).onConflictDoNothing();
    await world.db.insert(schema.tenantMemberships).values({
      tenantId: TID, userId: "1741", role: "owner",
    }).onConflictDoNothing();
    const caller = await tenantCaller(TID, { userId: 1741 });

    // ── Unverified: all three money surfaces fail closed ────────────────
    const holdErr = await expectTrpcError(
      caller.escrow.createHold({ orderId: "j174-no-order", tenantId: TID }),
      "FORBIDDEN",
      "createHold without KYB",
    );
    assert(/KYB/i.test(holdErr.message), `createHold rejection cites KYB (${holdErr.message})`);

    const wdErr = await expectTrpcError(
      caller.wallet.requestWithdrawal({ tenantId: TID, amount: 100 }),
      "FORBIDDEN",
      "requestWithdrawal without KYB",
    );
    assert(/KYB/i.test(wdErr.message), `withdrawal rejection cites KYB (${wdErr.message})`);

    const loanErr = await expectTrpcError(
      caller.credit.accept({ tenantId: TID, principalCents: 100_000 }),
      "FORBIDDEN",
      "credit.accept without KYB",
    );
    assert(/KYB/i.test(loanErr.message), `credit.accept rejection cites KYB (${loanErr.message})`);

    // ── Verified: the gate opens; only normal preconditions remain ──────
    await approveKyb(world, TID);

    // Withdrawal now reaches the custody-mode precondition (sim seeds pssp).
    await expectTrpcError(
      caller.wallet.requestWithdrawal({ tenantId: TID, amount: 100 }),
      "PRECONDITION_FAILED",
      "requestWithdrawal with KYB reaches custody check",
    );

    // createHold proceeds past KYB to its payment-verification checks.
    // W30 merge: the verify-first rail fails closed with PRECONDITION_FAILED
    // on an unverifiable payment; BAD_REQUEST/NOT_FOUND for a missing order
    // are equally fine — the only unacceptable verdict is a KYB FORBIDDEN.
    const holdErr2 = await caller.escrow
      .createHold({ orderId: "j174-no-order", tenantId: TID })
      .then(() => { throw new Error("createHold unexpectedly succeeded"); })
      .catch((e: any) => {
        assert(e?.code !== "FORBIDDEN" || !/KYB/i.test(e?.message ?? ""), `createHold failure is not KYB-related (got ${e?.code}: ${e?.message})`);
        assert(["BAD_REQUEST", "NOT_FOUND", "PRECONDITION_FAILED"].includes(e?.code), `createHold with KYB reaches payment checks (got ${e?.code})`);
        return e;
      });
    assert(!/KYB/i.test(holdErr2.message), "createHold failure is not KYB-related");

    // credit.accept reaches loan-offer evaluation (no offers → BAD_REQUEST).
    const loanErr2 = await expectTrpcError(
      caller.credit.accept({ tenantId: TID, principalCents: 100_000 }),
      "BAD_REQUEST",
      "credit.accept with KYB fails on offers, not KYB",
    );
    assert(!/KYB/i.test(loanErr2.message), "credit.accept failure is not KYB-related");
  },
};
