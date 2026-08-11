/**
 * J56 — Marketplace abuse. A non-admin tenant user attempts to suspend a
 * rival seller (competitive sabotage via updateSellerStatus) → FORBIDDEN;
 * the platform admin's suspension succeeds and is asserted in the DB.
 */
import { eq } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { SUPPLIER_TENANT_ID, TENANT_ID } from "../world";
import { adminCaller, expectTrpcError, publicCaller, tenantCaller } from "./helpers";

export const journey: Journey = {
  id: "J56",
  name: "marketplace abuse",
  feature: "updateSellerStatus admin gate",
  async run(world) {
    const schema = await import("../../drizzle/schema");
    const pub = await publicCaller();

    // Two rival sellers on tenant A's marketplace.
    const rival = await pub.marketplace.registerSeller({
      tenantId: TENANT_ID,
      businessName: "Rival Retail Co",
      ownerPhone: "2348011100001",
      category: "retail",
    });
    const attackerSeller = await pub.marketplace.registerSeller({
      tenantId: SUPPLIER_TENANT_ID,
      businessName: "Attacker Wholesale",
      ownerPhone: "2348011100002",
      category: "wholesale",
    });
    const admin = await adminCaller();
    await admin.marketplace.updateSellerStatus({ id: rival.id, status: "active" });
    await admin.marketplace.updateSellerStatus({ id: attackerSeller.id, status: "active" });

    // ── Attack: the rival (non-admin) tries to suspend the competition ────
    const attacker = await tenantCaller(SUPPLIER_TENANT_ID, { userId: 88 });
    await expectTrpcError(
      attacker.marketplace.updateSellerStatus({ id: rival.id, status: "suspended" }),
      "FORBIDDEN",
      "non-admin suspension of rival seller",
    );
    await expectTrpcError(
      attacker.marketplace.updateSellerCommission({ id: rival.id, commissionRate: "99.00" }),
      "FORBIDDEN",
      "non-admin commission tampering",
    );

    // Rival is untouched.
    const [rivalAfter] = await world.db
      .select()
      .from(schema.marketplaceSellers)
      .where(eq(schema.marketplaceSellers.id, rival.id))
      .limit(1);
    assert(rivalAfter.status === "active", `rival seller still active (got ${rivalAfter.status})`);
    assert(String(rivalAfter.commissionRate) === "10.00", `rival commission untouched (got ${rivalAfter.commissionRate})`);

    // ── Control: platform admin suspension works ──────────────────────────
    const r = await admin.marketplace.updateSellerStatus({ id: rival.id, status: "suspended" });
    assert(r.ok, "admin suspension accepted");
    const [suspended] = await world.db
      .select()
      .from(schema.marketplaceSellers)
      .where(eq(schema.marketplaceSellers.id, rival.id))
      .limit(1);
    assert(suspended.status === "suspended", "admin suspension persisted");
    // Attacker's own seller is unaffected.
    const [attackerRow] = await world.db
      .select()
      .from(schema.marketplaceSellers)
      .where(eq(schema.marketplaceSellers.id, attackerSeller.id))
      .limit(1);
    assert(attackerRow.status === "active", "attacker's seller unaffected");
  },
};
