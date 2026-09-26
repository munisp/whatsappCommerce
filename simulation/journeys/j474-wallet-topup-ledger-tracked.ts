/**
 * J474 — a confirmed wallet top-up is visibly ledger-tracked (assurance
 * finding AF-05).
 *
 * Wallet top-ups never reserve on the ledger (no ledgerPendingId): on
 * confirmation paymentConfirm posts the two direct single-phase legs
 * (settle-in:<id>, settle:<id>). recon-worker only recognised
 * ledgerPendingId, so every top-up raised "completed without ledger
 * tracking" on every 5-minute pass (seen live, ~281 times for one ₦5,000
 * top-up). The fix stamps metadata.ledgerSettle = { mode: "direct", … } once
 * both legs are posted; recon-worker counts that as tracked.
 *
 * Through the REAL escrow.topUp procedure and /api/webhooks/paystack.
 */
import { eq } from "drizzle-orm";
import { TENANT_ID, assert, type World } from "../world";
import type { Journey } from "../runner";
import { adminCaller, paystackChargeSuccess } from "./helpers";

export const journey: Journey = {
  id: "J474",
  name: "wallet top-up is ledger-tracked (AF-05)",
  feature: "direct-leg settlement stamped for recon-worker",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { ledger } = await import("../metaMock");
    const caller = await adminCaller();

    const top = await caller.wallet.topUp({ tenantId: TENANT_ID, amount: 5_000, note: "J474" });
    const [intent] = await world.db.select().from(schema.paymentIntents)
      .where(eq(schema.paymentIntents.id, (top as any).paymentIntentId)).limit(1);
    assert(intent, `top-up intent persisted (got ${JSON.stringify(top).slice(0, 200)})`);
    assert(!intent.ledgerPendingId, "precondition: a top-up has no two-phase reservation");

    const before = ledger.transfers.length;
    const res = await paystackChargeSuccess(world, { reference: intent.providerPaymentId!, amountMajor: 5_000 });
    assert(res.status === 200 && res.json?.ok, `webhook confirmed the top-up (got ${res.status} ${JSON.stringify(res.json)})`);

    const legs = ledger.transfers.slice(before).map((t) => t.body?.idempotency_key);
    assert(legs.includes(`settle-in:${intent.id}`) && legs.includes(`settle:${intent.id}`),
      `both direct legs posted (got ${JSON.stringify(legs)})`);

    const [after] = await world.db.select().from(schema.paymentIntents)
      .where(eq(schema.paymentIntents.id, intent.id)).limit(1);
    const settle = (after.metadata as any)?.ledgerSettle;
    assert(after.status === "completed", `top-up completed (got ${after.status})`);
    assert(settle?.mode === "direct", `metadata.ledgerSettle.mode = direct (got ${JSON.stringify(settle)})`);
    assert(settle?.amountMinor === 500_000, `settled amount recorded in minor units (got ${settle?.amountMinor})`);
    assert((after.metadata as any)?.creditedAt, "wallet credit still applied");

    // The SQL recon-worker runs sees the stamp (same expression as main.rs).
    const probe = await world.db.execute(
      `SELECT metadata->'ledgerSettle'->>'mode' AS mode FROM payment_intents WHERE id = '${intent.id}'`,
    );
    const mode = ((probe as any).rows ?? probe)[0]?.mode;
    assert(mode === "direct", `recon-worker's query reads mode=direct (got ${mode})`);
  },
};
