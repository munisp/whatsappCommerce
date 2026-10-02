// === W59 banking-pos ===
/**
 * J599 — POS expiry sweep releases the session claim: an awaiting session
 * past expiresAt flips to 'expired', a late webhook cannot settle it, and
 * the sweep is idempotent.
 */
import { eq } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { seedUcTenant } from "./w46-uc-docs-seed";

export const journey: Journey = {
  id: "J599",
  name: "POS expiry sweep releases claims; late webhook cannot settle",
  feature: "W59 banking-pos: pos-expiry sweep",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const svc = await import("../../server/services/posPayments");
    const { tenantId } = await seedUcTenant(world, "599", 5991);

    const session = await svc.createSession(world.db, { tenantId, amountCents: 50_000, channel: "ussd_ref", ttlMinutes: 1 });
    // Force expiry.
    await world.db.update(schema.posPaymentSessions).set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(schema.posPaymentSessions.reference, session.reference));
    const run1 = await svc.sweepExpiredSessions(world.db);
    assert(run1.expired >= 1, "sweep expired the session");
    const run2 = await svc.sweepExpiredSessions(world.db);
    assert(run2.expired === 0, "sweep is idempotent");
    const [sess] = await world.db.select().from(schema.posPaymentSessions).where(eq(schema.posPaymentSessions.reference, session.reference));
    assert(sess.status === "expired", "session expired");

    // Late webhook: claim-first UPDATE matches 0 rows → duplicate path, no settle.
    const late = await svc.confirmSession(world.db, session.reference, true);
    assert(late.duplicate === true && late.settledCents === 0, "late webhook settled nothing");
    const wallets = await world.db.select().from(schema.merchantWallets).where(eq(schema.merchantWallets.tenantId, tenantId));
    assert(wallets.length === 0 || parseFloat(wallets[0].availableBalance) === 0, "no wallet credit after expiry");
  },
};
