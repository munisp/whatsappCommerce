// === W45 orders-p0 (Coder C) ===
/**
 * J380 — PLT-12 + PLT-13 hardening:
 *  PLT-12: the delivery-PIN daily cap is atomic — claimPinAttempt admits
 *    exactly MAX attempts (single guarded UPDATE; concurrent claims cannot
 *    both pass a stale read) and rejects the (limit+1)-th; day rollover
 *    resets honestly.
 *  PLT-13: escrow bankApiBaseUrl is validated — z.string().url() at the
 *    schema layer, ssrfGuard at write time (setConfig rejects private IPs)
 *    and call time (assertSafeBankApiBaseUrl fail-closed).
 */
import { eq } from "drizzle-orm";
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { seedOrderWithItem, seedShipment } from "./w45-orders-seed";

export const journey: Journey = {
  id: "J380",
  name: "atomic PIN cap + escrow bankApiBaseUrl SSRF guard",
  feature: "PLT-12 claimPinAttempt + PLT-13 setConfig/call-time ssrfGuard",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const { claimPinAttempt, MAX_PIN_ATTEMPTS_PER_DAY } = await import("../../server/routers/logistics");
    const phone = world.newPhone("j380");
    await world.grantConsent(phone);
    const { orderId } = await seedOrderWithItem(world, "j380", phone);
    const shipmentId = await seedShipment(world, "j380", orderId, null);

    // Exactly MAX attempts admitted, the next rejected — atomically.
    for (let i = 0; i < MAX_PIN_ATTEMPTS_PER_DAY; i++) {
      assert(await claimPinAttempt(world.db, shipmentId), `attempt ${i + 1} admitted`);
    }
    assert(!(await claimPinAttempt(world.db, shipmentId)), "cap enforced atomically");
    const [shp] = await world.db.select().from(schema.logisticsShipments)
      .where(eq(schema.logisticsShipments.id, shipmentId));
    assert((shp.metadata as any).pinAttempts.count === MAX_PIN_ATTEMPTS_PER_DAY, "counter persisted");

    // Parallel burst: 10 concurrent claims — exactly (limit - used) admitted.
    const sid2 = await seedShipment(world, "j380b", orderId, null);
    const burst = await Promise.all(
      Array.from({ length: 10 }, () => claimPinAttempt(world.db, sid2)),
    );
    assert(burst.filter(Boolean).length === MAX_PIN_ATTEMPTS_PER_DAY,
      `concurrent burst admits exactly ${MAX_PIN_ATTEMPTS_PER_DAY} (got ${burst.filter(Boolean).length})`);

    // Day rollover resets the counter.
    const tomorrow = new Date(Date.now() + 26 * 3600_000);
    assert(await claimPinAttempt(world.db, shipmentId, MAX_PIN_ATTEMPTS_PER_DAY, tomorrow),
      "day rollover resets the cap");

    // PLT-13: call-time guard fails closed on unsafe/unset URLs.
    const { assertSafeBankApiBaseUrl } = await import("../../server/routers/escrow");
    let unset = false;
    try { await assertSafeBankApiBaseUrl(null); } catch { unset = true; }
    assert(unset, "unset bankApiBaseUrl refused at call time");
    let ssrf = false;
    try { await assertSafeBankApiBaseUrl("http://169.254.169.254/latest/meta-data"); } catch { ssrf = true; }
    assert(ssrf, "metadata-endpoint URL refused at call time");
    let notUrl = false;
    try { await assertSafeBankApiBaseUrl("not-a-url"); } catch { notUrl = true; }
    assert(notUrl, "non-URL refused at call time");
    const ok = await assertSafeBankApiBaseUrl("https://bank-api.example.com");
    assert(ok.hostname === "bank-api.example.com", "valid https URL accepted");

    // Write-time: setConfig schema rejects a non-URL (z.string().url()).
    const { escrowRouter } = await import("../../server/routers/escrow");
    const caller = escrowRouter.createCaller({ user: { id: 1, role: "admin" } } as any);
    let writeRejected = false;
    try {
      await caller.setConfig({ bankApiBaseUrl: "not-a-url" });
    } catch { writeRejected = true; }
    assert(writeRejected, "setConfig rejects non-URL bankApiBaseUrl");
    let writeSsrf = false;
    try {
      await caller.setConfig({ bankApiBaseUrl: "http://127.0.0.1:8080/internal" });
    } catch { writeSsrf = true; }
    assert(writeSsrf, "setConfig rejects private-IP bankApiBaseUrl (ssrfGuard at write time)");
  },
};
// === END W45 orders-p0 ===
