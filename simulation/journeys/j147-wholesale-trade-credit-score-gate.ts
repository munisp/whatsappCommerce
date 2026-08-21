/**
 * J147 — Wholesale trade-credit checkout GATED by the platform credit score:
 * with the score threshold set above the buyer's score the order is refused
 * BEFORE any credit draw (outstanding unchanged, no order row); with the
 * threshold at/below the score the checkout draws on the existing credit
 * facility (drawOnCreditTx — atomic, integer cents) and confirms the order.
 */
import { eq } from "drizzle-orm";
import { TENANT_ID, SUPPLIER_TENANT_ID, assert, type World } from "../world";
import type { Journey } from "../runner";
import { tenantCaller, creditAccount, creditLedgerRows } from "./helpers";

export const journey: Journey = {
  id: "J147",
  name: "trade-credit checkout gated by credit score",
  feature: "getMerchantScore gate + drawOnCreditTx wholesale checkout",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { createWholesaleListingTx, replaceWholesaleTiersTx } =
      await import("../../server/services/wholesaleCatalog");

    const listing = await createWholesaleListingTx(world.db, {
      tenantId: SUPPLIER_TENANT_ID,
      title: "Plastic Crates 20L (bulk)",
      category: "packaging",
      moq: 10,
      status: "active",
    });
    await replaceWholesaleTiersTx(world.db, {
      tenantId: SUPPLIER_TENANT_ID,
      listingId: listing.id,
      tiers: [{ minQty: 10, maxQty: null, unitPriceCents: 240_000 }], // ₦2,400.00
    });

    const caller = await tenantCaller(TENANT_ID);
    const before = await creditAccount(world);
    assert(Number(before.outstandingCents) === 0, "facility starts at zero outstanding");

    const prevMin = process.env.WHOLESALE_CREDIT_MIN_SCORE;
    try {
      // ── 1. Threshold ABOVE the buyer's score → refused, NO draw ────────
      process.env.WHOLESALE_CREDIT_MIN_SCORE = "1000"; // requires a perfect score
      let refused: any = null;
      try {
        await caller.wholesale.placeOrder({
          tenantId: TENANT_ID,
          listingId: listing.id,
          quantity: 20,
          paymentMode: "trade_credit",
        });
      } catch (e: any) {
        refused = e;
      }
      assert(refused, "low-score trade-credit checkout refused");
      assert(
        String(refused?.message ?? "").includes("credit_score_too_low"),
        `refusal names the score gate (got ${refused?.message})`,
      );
      const afterRefusal = await creditAccount(world);
      assert(Number(afterRefusal.outstandingCents) === 0, "refused checkout never draws");
      const refusedOrders = await world.db
        .select()
        .from(schema.wholesaleOrders)
        .where(eq(schema.wholesaleOrders.listingId, listing.id));
      assert(refusedOrders.length === 0, "refused checkout persists no order");

      // ── 2. Threshold AT/BELOW the score → draw + confirmed order ───────
      process.env.WHOLESALE_CREDIT_MIN_SCORE = "0";
      const placed = await caller.wholesale.placeOrder({
        tenantId: TENANT_ID,
        listingId: listing.id,
        quantity: 20,
        paymentMode: "trade_credit",
        termsDays: 14,
      });
      assert(placed.ok, "scored trade-credit checkout succeeds");
      assert(placed.order.status === "confirmed", `order confirmed on credit (got ${placed.order.status})`);
      assert(placed.order.paymentMode === "trade_credit", "paymentMode recorded");
      assert(placed.order.totalCents === 4_800_000, `integer-cents total (got ${placed.order.totalCents})`);
      assert(placed.order.creditLedgerId, "credit ledger row linked");
      assert(typeof placed.order.creditScore === "number", "score used at checkout recorded");

      const account = await creditAccount(world);
      assert(
        Number(account.outstandingCents) === 4_800_000,
        `outstanding rose by the draw (got ${account.outstandingCents})`,
      );
      const draws = await creditLedgerRows(world, "invoice_draw");
      assert(draws.length === 1, `exactly one invoice_draw (got ${draws.length})`);
      assert(Number(draws[0].amountCents) === 4_800_000, "draw amount == order total");

      // ── 3. Idempotent replay: same idempotency key → original order, no
      // second draw. ──────────────────────────────────────────────────────
      const replayKey = crypto.randomUUID();
      const first = await caller.wholesale.placeOrder({
        tenantId: TENANT_ID, listingId: listing.id, quantity: 10,
        paymentMode: "trade_credit", idempotencyKey: replayKey,
      });
      const replay = await caller.wholesale.placeOrder({
        tenantId: TENANT_ID, listingId: listing.id, quantity: 10,
        paymentMode: "trade_credit", idempotencyKey: replayKey,
      });
      assert(first.ok && replay.ok, "both calls succeed");
      assert(replay.order.id === first.order.id, "replay returns the original order");
      const drawsAfter = await creditLedgerRows(world, "invoice_draw");
      assert(drawsAfter.length === 2, `no double draw on replay (got ${drawsAfter.length})`);
    } finally {
      if (prevMin === undefined) delete process.env.WHOLESALE_CREDIT_MIN_SCORE;
      else process.env.WHOLESALE_CREDIT_MIN_SCORE = prevMin;
    }
  },
};
