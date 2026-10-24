// === W66 learning ===
/**
 * J627 — R8(b) dispute outcomes → risk features
 * (services/disputeOutcomeFeatures.ts + escrow.review hook):
 *   1. recordDisputeOutcome writes one feature row (parties, integer-cent
 *      amounts, resolution, days-to-resolve).
 *   2. A replay for the same dispute is a no-op (unique dispute_id claim).
 *   3. disputeRiskSignal aggregates per-tenant outcomes (the additive signal
 *      creditScoring attaches to factors).
 *   4. escrow.review calls the recorder (source wiring) and creditScoring
 *      attaches disputeOutcomes into factors (source wiring).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, type World, TENANT_ID } from "../world";
import type { Journey } from "../runner";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const journey: Journey = {
  id: "J627",
  name: "dispute outcome feature row: idempotent write + tenant risk signal aggregation",
  feature: "W66 R8(b) dispute outcomes → risk features",
  async run(world: World) {
    const svc = await import("../../server/services/disputeOutcomeFeatures");
    const created = new Date(Date.now() - 5 * 24 * 3600_000);

    const w1 = await svc.recordDisputeOutcome(world.db, {
      tenantId: TENANT_ID, disputeId: "d-j627-1", orderId: "o-j627", escrowTxId: "e-j627",
      raisedBy: "buyer", reason: "not_received", resolution: "full_refund_to_buyer",
      outcome: "resolved_buyer", escrowAmountCents: 250_000, refundAmountCents: 250_000,
      disputeCreatedAt: created, resolvedAt: new Date(),
    });
    assert(w1.written, "first write lands");

    // Idempotent replay
    const w2 = await svc.recordDisputeOutcome(world.db, {
      tenantId: TENANT_ID, disputeId: "d-j627-1", outcome: "resolved_merchant",
    });
    assert(!w2.written, "replay is a no-op");
    const row = await svc.getDisputeOutcome(world.db, "d-j627-1");
    assert(row && row.outcome === "resolved_buyer", "original outcome preserved");
    assert(row!.escrowAmountCents === 250_000, `cents ${row!.escrowAmountCents}`);
    assert(row!.daysToResolve === 5, `days ${row!.daysToResolve}`);

    // Second dispute (merchant wins) then aggregate signal
    await svc.recordDisputeOutcome(world.db, {
      tenantId: TENANT_ID, disputeId: "d-j627-2", outcome: "resolved_merchant",
      resolution: "full_release_to_merchant", escrowAmountCents: 100_000,
      disputeCreatedAt: created, resolvedAt: new Date(),
    });
    const signal = await svc.disputeRiskSignal(world.db, TENANT_ID);
    assert(signal && signal.total >= 2, `signal total ${signal?.total}`);
    assert(signal!.merchantLost >= 1 && signal!.buyerLost >= 1, "outcome split");
    assert(signal!.refundCents >= 250_000, `refund cents ${signal!.refundCents}`);
    assert(signal!.avgDaysToResolve != null, "avg days present");

    // Wiring: escrow.review hook + creditScoring factors attachment
    const escrowSrc = fs.readFileSync(path.join(ROOT, "server/routers/escrow.ts"), "utf8");
    assert(escrowSrc.includes("recordDisputeOutcome"), "escrow.review records outcome features");
    const creditSrc = fs.readFileSync(path.join(ROOT, "server/services/creditScoring.ts"), "utf8");
    assert(creditSrc.includes("disputeRiskSignal") && creditSrc.includes("disputeOutcomes"), "creditScoring consumes the signal");
  },
};
