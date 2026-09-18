/**
 * === W45 money-ledger (Coder B3) ===
 * J372 — PAY-16: FX payout Mojaloop leg is a deterministic post-commit outbox
 * delivery.
 *  1. Execute commits PG-only: quote executed with payoutRef == the
 *     DETERMINISTIC transferId derived from the quoteId, wallet debited, and
 *     a payment_outbox row (reference fxmoja:<quoteId>) pending — NO Mojaloop
 *     call happened in-transaction.
 *  2. processPaymentOutbox delivers the leg (POST /transfers with the SAME
 *     deterministic transferId) → row 'delivered'; a second worker tick is a
 *     no-op (exactly-once).
 *  3. Fulfil callback (COMMITTED) converges the quote honestly
 *     (metadata.transferState='fulfilled'); replay is a no-op.
 */
import crypto from "crypto";
import { and, eq } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { tenantCaller } from "./helpers";
import { fmtMajor } from "./loanRaceSeed";
import { meta } from "../metaMock";

const TID = "sim-fx-372";
const BALANCE_CENTS = 20_000_000;
const GROSS_CENTS = 10_000_000;

async function walletCents(world: World): Promise<number> {
  const schema = await import("../../drizzle/schema");
  const [w] = await world.db.select().from(schema.merchantWallets).where(eq(schema.merchantWallets.tenantId, TID));
  return w ? Math.round(parseFloat(w.availableBalance) * 100) : 0;
}

export const journey: Journey = {
  id: "J372",
  name: "FX payout: deterministic transferId + post-commit outbox delivery + fulfil callback (PAY-16)",
  feature: "W45 money-ledger: FX Mojaloop outbox",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const fx = await import("../../server/services/fxPayouts");
    const outbox = await import("../../server/services/paymentOutbox");
    const now = new Date();
    await world.db.insert(schema.tenants).values({ id: TID, name: "J372 FX", slug: TID, status: "active", createdAt: now, updatedAt: now }).onConflictDoNothing();
    const [u] = await world.db.insert(schema.users).values({ openId: `sim-${TID}-owner`, name: "FX Owner", tenantId: TID, lastSignedIn: now })
      .onConflictDoNothing().returning({ id: schema.users.id });
    const uid = u?.id ?? 372001;
    await world.db.insert(schema.tenantMemberships).values({ tenantId: TID, userId: String(uid), role: "owner" }).onConflictDoNothing();
    await world.db.insert(schema.merchantWallets).values({
      id: crypto.randomUUID(), tenantId: TID, currency: "NGN",
      availableBalance: fmtMajor(BALANCE_CENTS), escrowBalance: "0.00",
      totalEarned: "0.00", totalWithdrawn: "0.00",
      custodyMode: "psp", isActive: true, createdAt: now, updatedAt: now,
    }).onConflictDoNothing();

    const savedEnv = {
      FX_RATE_SOURCE: process.env.FX_RATE_SOURCE,
      FX_LIVE_CORRIDORS: process.env.FX_LIVE_CORRIDORS,
      MOJALOOP_URL: process.env.MOJALOOP_URL,
    };
    process.env.FX_RATE_SOURCE = "sim";
    process.env.FX_LIVE_CORRIDORS = "NGN:KES";
    process.env.MOJALOOP_URL = "http://mojaloop.sim.local:3001";
    meta.hostStatus.set("mojaloop.sim.local", 202);
    try {
      const caller = await tenantCaller(TID, { userId: uid });
      const q = await caller.fxPayouts.quote({ tenantId: TID, fromCurrency: "NGN", toCurrency: "KES", amountCents: GROSS_CENTS });
      assert(q.ok === true, "quote ok");
      await caller.fxPayouts.accept({ tenantId: TID, quoteId: q.quote.id });

      // ── 1. Execute commits PG-only: deterministic payoutRef + pending outbox
      const expectedTransferId = fx.fxDeterministicTransferId(q.quote.id);
      const mojaloopCallsBefore = meta.outbound.filter((c) => c.url.includes("mojaloop.sim.local")).length;
      const ex = await caller.fxPayouts.execute({ tenantId: TID, quoteId: q.quote.id });
      assert(ex.ok === true, `execute ok (${JSON.stringify(ex).slice(0, 300)})`);
      assert(ex.payoutRef === expectedTransferId, `payoutRef is the deterministic transferId (got ${ex.payoutRef})`);
      assert((await walletCents(world)) === BALANCE_CENTS - GROSS_CENTS, "wallet debited exactly the gross");
      const mojaloopCallsAfter = meta.outbound.filter((c) => c.url.includes("mojaloop.sim.local")).length;
      assert(mojaloopCallsAfter === mojaloopCallsBefore, "NO Mojaloop call inside the execute transaction (post-commit outbox)");
      const row = await outbox.getPaymentOutboxByReference(world.db, `fxmoja:${q.quote.id}`);
      assert(row && row.status === "pending" && row.kind === "mojaloop_transfer", "outbox row pending");
      assert((row!.payload as any).transferId === expectedTransferId, "outbox payload carries the deterministic transferId");

      // ── 2. Worker delivers with the SAME transferId; replay is a no-op ──
      const tick1 = await outbox.processPaymentOutbox(world.db);
      assert(tick1.delivered >= 1, `worker delivered (got ${JSON.stringify(tick1)})`);
      const post = meta.outbound.find((c) => c.url.includes("mojaloop.sim.local") && c.method === "POST");
      assert(post, "Mojaloop POST happened post-commit");
      assert(JSON.stringify(post!.body).includes(expectedTransferId), "worker reused the deterministic transferId");
      const rowAfter = await outbox.getPaymentOutboxByReference(world.db, `fxmoja:${q.quote.id}`);
      assert(rowAfter!.status === "delivered", "outbox row delivered");
      const tick2 = await outbox.processPaymentOutbox(world.db);
      assert(tick2.claimed === 0, "second worker tick is a no-op (exactly-once)");

      // ── 3. Fulfil callback converges; replay no-op ─────────────────────
      const cb = await fx.handleFxTransferCallback(world.db, { transferId: expectedTransferId, state: "COMMITTED" });
      assert(cb.ok === true && cb.action === "fulfilled", `fulfil callback converges (${JSON.stringify(cb)})`);
      const [fq] = await world.db.select().from(schema.fxQuotes).where(eq(schema.fxQuotes.id, q.quote.id));
      assert((fq.metadata as any)?.transferState === "fulfilled", "quote metadata records fulfilment");
      assert(fq.status === "executed", "quote stays executed (debit stands, delivery confirmed)");
      const cb2 = await fx.handleFxTransferCallback(world.db, { transferId: expectedTransferId, state: "COMMITTED" });
      assert(cb2.ok === true && cb2.action === "noop", "fulfil replay is a no-op");
      assert((await walletCents(world)) === BALANCE_CENTS - GROSS_CENTS, "fulfil moved nothing");
    } finally {
      meta.hostStatus.delete("mojaloop.sim.local");
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  },
};
