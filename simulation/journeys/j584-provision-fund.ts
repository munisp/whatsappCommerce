// === W57 risk-shield ===
/**
 * J584 — First-loss provision fund: accrual on fee events (configured bps,
 * idempotent, integer cents), draw with the balance gate (fail-closed on
 * insufficient funds) and recovery credits restoring the fund. Platform
 * level (tenantId NULL) is isolated from tenant rows.
 */
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J584",
  name: "provision fund accrual / draw gate / recovery credit",
  feature: "W57 risk-shield F4: first-loss provision fund",
  async run(world: World) {
    const prov = await import("../../server/services/provisionFund");
    const { ProvisionError } = prov;

    const tag = world.newPhone("584").slice(-6);
    const bps = await prov.getProvisionFundBps(world.db as any);
    assert(bps === 250, "escrow_config.provision_fund_bps default 250 (2.5%)");

    // ── 1. Accrual: configured % of a fee, idempotent, integer cents ─────
    const base = await prov.getProvisionBalance(world.db as any, TENANT_ID);
    const feeCents = 123_457; // odd cents — rounding must be deterministic
    const a1 = await prov.accrueFromFeeEvent(world.db as any, { tenantId: TENANT_ID, feeRef: `j584-fee-${tag}`, feeCents });
    const expected = Math.round((feeCents * bps) / 10_000);
    assert(a1.accrued === expected, `accrual ${expected} = ${bps}bps of ${feeCents}`);
    const a2 = await prov.accrueFromFeeEvent(world.db as any, { tenantId: TENANT_ID, feeRef: `j584-fee-${tag}`, feeCents });
    assert(a2.accrued === 0, "accrual idempotent (same feeRef ⇒ no double-post)");
    const mid = await prov.getProvisionBalance(world.db as any, TENANT_ID);
    assert(mid - base === expected, "balance reflects exactly one accrual");

    // ── 2. Draw gate: fail-closed on insufficient funds ──────────────────
    let refused = false;
    try {
      await prov.drawFromFund(world.db as any, {
        tenantId: TENANT_ID, amountCents: mid + 1, ref: `j584-over-${tag}`,
        reason: "should refuse", actorId: "admin-j584",
      });
    } catch (e: any) {
      refused = e instanceof ProvisionError && e.code === "INSUFFICIENT_FUNDS";
    }
    assert(refused, "draw above balance refused (fail-closed money)");

    const drawAmt = Math.floor(expected / 2);
    const d1 = await prov.drawFromFund(world.db as any, {
      tenantId: TENANT_ID, amountCents: drawAmt, ref: `j584-draw-${tag}`,
      reason: "admin-approved write-off", actorId: "admin-j584",
    });
    assert(d1.ok && !d1.duplicate && d1.balanceAfter === mid - drawAmt, "draw within balance succeeds");

    // ── 3. Recovery credit restores the fund (idempotent) ────────────────
    const r1 = await prov.recoveryCredit(world.db as any, {
      tenantId: TENANT_ID, amountCents: drawAmt, ref: `j584-rec-${tag}`, note: "post-default recovery",
    });
    const r2 = await prov.recoveryCredit(world.db as any, {
      tenantId: TENANT_ID, amountCents: drawAmt, ref: `j584-rec-${tag}`,
    });
    assert(r1.credited && !r2.credited, "recovery credit idempotent");
    const end = await prov.getProvisionBalance(world.db as any, TENANT_ID);
    assert(end === base + expected, "fund restored to accrual level after draw + recovery");

    // ── 4. Platform-level rows (tenantId NULL) are isolated ──────────────
    const pBase = await prov.getProvisionBalance(world.db as any, null);
    await prov.accrueFromFeeEvent(world.db as any, {
      tenantId: TENANT_ID, feeRef: `j584-plat-${tag}`, feeCents: 10_000_00, platformShare: true,
    });
    const pAfter = await prov.getProvisionBalance(world.db as any, null);
    assert(pAfter - pBase === Math.round((10_000_00 * bps) / 10_000), "platform-level accrual lands on NULL tenant");
    const tAfter = await prov.getProvisionBalance(world.db as any, TENANT_ID);
    assert(tAfter === end, "tenant balance untouched by platform-level rows");
  },
};
