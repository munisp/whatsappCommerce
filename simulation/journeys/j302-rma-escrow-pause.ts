/**
 * === W41 rma-fx (Coder C) ===
 * J302 — Escrow release is PAUSED while an RMA is open: settleEscrowAtomic
 * refuses to transition (rmaPaused) for requested/approved/received RMAs and
 * the pause lifts when the RMA reaches a terminal state (rejected).
 */
import { TENANT_ID, assert, type World } from "../world";
import type { Journey } from "../runner";
import { seedRmaOrder } from "./w41-rma-seed";

export const journey: Journey = {
  id: "J302",
  name: "escrow release paused while RMA open",
  feature: "settleEscrowAtomic RMA guard",
  async run(world: World) {
    const { requestReturn, decideReturn, hasOpenRma } = await import("../../server/services/rma");
    const { settleEscrowAtomic } = await import("../../server/routers/escrow");
    const phone = world.newPhone("j302");
    const seed = await seedRmaOrder(world, "j302", phone);
    const notify = { waSend: async () => {}, tgSend: async () => {} };

    // No RMA → no pause.
    assert(!(await hasOpenRma(world.db, TENANT_ID, seed.orderId)), "no open RMA initially");

    const { rma } = await requestReturn(world.db, {
      tenantId: TENANT_ID, buyerRef: phone, orderId: seed.orderId, reason: "wrong item", ...notify,
    });
    assert(await hasOpenRma(world.db, TENANT_ID, seed.orderId), "RMA open after request");

    // Release attempt is paused (not lost): no transition, explicit flag.
    const paused = await settleEscrowAtomic(world.db as any, seed.escrowId, {
      autoConfirmed: false, allowedFromStates: ["escrow_held", "delivery_confirmed"],
    });
    assert(paused.transitioned === false, "release blocked");
    assert(paused.rmaPaused === true, "rmaPaused flag surfaced");

    // Still paused after approval + receipt states (approved is open).
    await decideReturn(world.db, { rmaId: rma.id, tenantId: TENANT_ID, approve: true, ...notify });
    const stillPaused = await settleEscrowAtomic(world.db as any, seed.escrowId, {
      autoConfirmed: false, allowedFromStates: ["escrow_held", "delivery_confirmed"],
    });
    assert(stillPaused.rmaPaused === true, "still paused after approval");

    // Terminal RMA (rejected is terminal too, but this one is approved — use a
    // second order/RMA rejected at decision time) → pause lifts.
    const seed2 = await seedRmaOrder(world, "j302b", phone);
    const { rma: rma2 } = await requestReturn(world.db, {
      tenantId: TENANT_ID, buyerRef: phone, orderId: seed2.orderId, reason: "no longer needed", ...notify,
    });
    await decideReturn(world.db, { rmaId: rma2.id, tenantId: TENANT_ID, approve: false, note: "past return window", ...notify });
    assert(!(await hasOpenRma(world.db, TENANT_ID, seed2.orderId)), "pause lifts on terminal RMA");
    const released = await settleEscrowAtomic(world.db as any, seed2.escrowId, {
      autoConfirmed: false, allowedFromStates: ["escrow_held", "delivery_confirmed"],
    });
    assert(released.rmaPaused !== true, "no rmaPaused after rejection");
  },
};
