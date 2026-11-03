/**
 * J614 — A shop's Escrow and Revenue pages show only its own money, and never reach the platform-wide figures.
 */
import { randomUUID } from "crypto";
import { TENANT_ID, assert, type World } from "../world";
import type { Journey } from "../runner";
import { expectTrpcError, tenantCaller } from "./helpers";

const OTHER = "sim-money-other";

export const journey: Journey = {
  id: "J614",
  name: "merchant escrow and revenue",
  feature: "Shop-only escrow and revenue figures, isolated from other shops and the platform",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    await world.db.insert(schema.tenants).values({ id: OTHER, name: "Money Other", slug: "sim-money-other", status: "active" } as any).onConflictDoNothing();
    const orderIn = async (tenantId: string, total: string) => {
      const id = randomUUID();
      await world.db.insert(schema.orders).values({ id, tenantId, customerId: randomUUID(), conversationId: randomUUID(), orderNumber: `J614-${id.slice(0, 8)}`, items: [], totalAmount: total, currency: "NGN", status: "confirmed", paymentStatus: "completed" } as any);
      return id;
    };
    await world.db.insert(schema.tenantMemberships).values({ tenantId: OTHER, userId: "61401", role: "owner" }).onConflictDoNothing();
    const owner = await tenantCaller(OTHER, { userId: 61401 });
    const empty = await owner.tenantPortal.getMyRevenue({ tenantId: OTHER });
    assert(empty.totals.length === 0, "a new shop has no revenue");

    const mine = await orderIn(OTHER, "1000.00");
    await orderIn(TENANT_ID, "999999.00");
    await world.db.insert(schema.escrowTransactions).values({ orderId: mine, tenantId: OTHER, amount: "1000.00", platformFee: "50.00", netMerchantAmount: "950.00", currency: "NGN", state: "escrow_held" } as any);

    const revenue = await owner.tenantPortal.getMyRevenue({ tenantId: OTHER });
    assert(revenue.totals[0]?.total === 1000, `only this shop's orders count (got ${revenue.totals[0]?.total})`);
    assert(revenue.totals[0]?.thisMonth === 1000 && revenue.months.length === 1, "this month and the monthly list include it");

    const escrow = await owner.tenantPortal.getMyEscrow({ tenantId: OTHER });
    assert(escrow.held === 950, `held is what the shop will get (got ${escrow.held})`);
    assert(escrow.items.length === 1 && !("customerId" in escrow.items[0]), "lists its payments, without customer details");

    await expectTrpcError(owner.tenantPortal.getMyRevenue({ tenantId: TENANT_ID }), "FORBIDDEN", "another shop's revenue is refused");
    await expectTrpcError(owner.tenantPortal.getMyEscrow({ tenantId: TENANT_ID }), "FORBIDDEN", "another shop's escrow is refused");
    await expectTrpcError(owner.revenue.summary(), "FORBIDDEN", "platform revenue stays admin-only");
    await expectTrpcError(owner.escrow.getStats(), "FORBIDDEN", "platform escrow stats stay admin-only");
  },
};
