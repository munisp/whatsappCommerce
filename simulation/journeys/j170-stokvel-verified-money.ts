/**
 * J170 — W30 (V1#1): stokvel money truth.
 *   1. A contribution with a FABRICATED payment reference stays `pending`
 *      (never paid) with an honest audit event.
 *   2. Contributions with VERIFIED payment references (completed payment
 *      intents, the state the paystack webhook leaves) mark paid.
 *   3. The completed cycle's payout REALLY credits the recipient's wallet
 *      (wallet_tx reference stokvelpay:<circleId>:<cycle>, balance moved) —
 *      "paid" only with money movement; retry sweep is idempotent.
 */
import { and, eq } from "drizzle-orm";
import { TENANT_ID, assert, type World } from "../world";
import type { Journey } from "../runner";
import { adminCaller, seedCompletedPayment } from "./helpers";

export const journey: Journey = {
  id: "J170",
  name: "stokvel verified contributions + real wallet payout",
  feature: "V1#1 remediation: verified payment refs, wallet-credited payouts, single-tx cycle advance",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const stokvel = await import("../../server/services/stokvel");
    const admin = await adminCaller();
    const phones = [world.newPhone("v1"), world.newPhone("v2")];

    const { circle } = await admin.stokvel.createCircle({
      tenantId: TENANT_ID,
      name: "Verified Money Circle",
      contributionAmountCents: 30_000,
      frequency: "weekly",
      members: phones.map((p) => ({ phone: p })),
    });

    // ── 1. Fabricated reference → stays pending, honestly ────────────────
    const fake = await admin.stokvel.recordContribution({
      tenantId: TENANT_ID, circleId: circle.id, phone: phones[0], paymentRef: "fabricated-ref-170",
    });
    assert(fake.pending === true && !fake.alreadyPaid, "unverified contribution stays pending");
    assert(fake.contribution.status === "pending", `row stays pending (got ${fake.contribution.status})`);
    const noPayout = await world.db.select().from(schema.stokvelPayouts)
      .where(eq(schema.stokvelPayouts.circleId, circle.id));
    assert(noPayout.length === 0, "no payout from unverified money");
    let events = await world.db.select().from(schema.stokvelEvents)
      .where(eq(schema.stokvelEvents.circleId, circle.id));
    assert(events.some((e: any) => e.kind === "contribution_pending"), "audit: contribution_pending logged");
    assert(!events.some((e: any) => e.kind === "contribution_paid"), "no paid event for fabricated money");

    // ── 2. Verified references → paid ────────────────────────────────────
    for (let i = 0; i < phones.length; i++) {
      const ref = `stk170-${circle.id.slice(0, 8)}-${i}`;
      await seedCompletedPayment(world, { reference: ref, amountCents: 30_000, customerId: phones[i] });
      const res = await admin.stokvel.recordContribution({
        tenantId: TENANT_ID, circleId: circle.id, phone: phones[i], paymentRef: ref,
      });
      assert(res.pending !== true, `verified contribution ${i} accepted`);
      assert(res.contribution.status === "paid", `verified contribution ${i} paid`);
    }

    // ── 3. Payout REALLY credited the recipient's wallet ─────────────────
    const [payout] = await world.db.select().from(schema.stokvelPayouts)
      .where(and(eq(schema.stokvelPayouts.circleId, circle.id), eq(schema.stokvelPayouts.cycle, 1)));
    assert(payout, "payout recorded");
    assert(payout.status === "paid", `payout paid WITH money movement (got ${payout.status})`);
    assert(payout.amountCents === 60_000, `pool = 2 × 30,000 (got ${payout.amountCents})`);
    assert(payout.phone === phones[0], "rotation pays first member");

    const walletKey = stokvel.stokvelWalletTenantKey(phones[0]);
    const [wallet] = await world.db.select().from(schema.merchantWallets)
      .where(eq(schema.merchantWallets.tenantId, walletKey));
    assert(wallet, "recipient wallet created");
    assert(Number(wallet.availableBalance) === 600, `wallet credited 600.00 (got ${wallet.availableBalance})`);

    const wtx = await world.db.select().from(schema.walletTransactions)
      .where(eq(schema.walletTransactions.walletId, wallet.id));
    const payTx = wtx.find((t: any) => t.reference === `stokvelpay:${circle.id}:1`);
    assert(payTx, "wallet_tx with deterministic stokvelpay reference exists");
    assert(Number(payTx.amount) === 600, "wallet_tx amount matches the pool");
    assert(payTx.description?.includes("Stokvel payout"), "wallet_tx honestly labelled");

    events = await world.db.select().from(schema.stokvelEvents)
      .where(eq(schema.stokvelEvents.circleId, circle.id));
    assert(events.some((e: any) => e.kind === "payout_paid"), "audit: payout_paid only after credit");

    // Circle advanced in the same flow (2-member circle: rotation continues).
    const [fresh] = await world.db.select().from(schema.stokvelCircles)
      .where(eq(schema.stokvelCircles.id, circle.id));
    assert(fresh.currentCycle === 2 && fresh.rotationIndex === 1, "cycle advanced atomically");

    // Retry sweep is a no-op when everything is already paid.
    const retry = await admin.stokvel.retryPendingPayouts({ tenantId: TENANT_ID });
    assert(retry.stillPending === 0, "no stranded pending_payout rows");
  },
};
