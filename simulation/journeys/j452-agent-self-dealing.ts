// === W47 stakeholders ===
/**
 * J452 — ONB-S-11 agent self-dealing guards:
 *   - commissionBps is capped (default 3000 bps);
 *   - agent mint/update + commission payout are OWNER-only (an operator
 *     caller is refused);
 *   - self-orders are excluded: attributing an order whose customer phone
 *     equals the agent's phone fails, and the sweep never accrues it;
 *   - rerouting the payout phone AFTER a paid commission requires a
 *     payout_change step-up OTP.
 */
import { randomUUID } from "crypto";
import { and, eq } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { expectTrpcError, tenantCaller } from "./helpers";
import { seedUcTenant, seedOrder } from "./w46-uc-docs-seed";

const AGENT_PHONE = "2348040000452";
const BUYER = "2348040001452";

async function seedPayoutChallenge(world: World, tenantId: string, userId: string, otp: string): Promise<string> {
  const schema = await import("../../drizzle/schema");
  const { hashOtp } = await import("../../server/routers/phoneAuth");
  const id = randomUUID();
  await world.db.insert(schema.stepUpChallenges).values({
    id, tenantId, userId, purpose: "payout_change",
    otpHash: hashOtp(otp), phone: "+2348000000452", attempts: 0,
    expiresAt: new Date(Date.now() + 10 * 60_000),
  });
  return id;
}

export const journey: Journey = {
  id: "J452",
  name: "agent self-dealing guards: cap, owner-only, self-order exclusion, payout-phone step-up",
  feature: "W47 stakeholders: ONB-S-11 agent rails",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const svc = await import("../../server/services/agents");
    const { tenantId, caller } = await seedUcTenant(world, "452");
    // An OPERATOR caller on the same tenant (owner-only guard probe).
    await world.db.insert(schema.tenantMemberships).values({
      tenantId, userId: "4529", role: "operator",
    }).onConflictDoNothing();
    const operator = await tenantCaller(tenantId, { userId: 4529 });

    // ── 1. commissionBps cap (3000 default) ─────────────────────────────
    await expectTrpcError(
      caller.ucDocs.upsertAgent({ tenantId, name: "Greedy", phone: AGENT_PHONE, code: "GREEDY", commissionBps: 5000 }),
      "BAD_REQUEST",
      "commissionBps above the cap refused",
    );

    // ── 2. Owner-only: operator cannot mint agents ──────────────────────
    await expectTrpcError(
      operator.ucDocs.upsertAgent({ tenantId, name: "Op Agent", phone: "2348040002452", code: "OP-452", commissionBps: 1000 }),
      "FORBIDDEN",
      "operator cannot mint agents (owner-only)",
    );

    const { agent } = await caller.ucDocs.upsertAgent({
      tenantId, name: "Agent Ada", phone: AGENT_PHONE, code: "AGT-452", commissionBps: 1000,
    });
    assert(agent.code === "AGT-452", "agent created by owner");

    // ── 3. Self-order exclusion ─────────────────────────────────────────
    const selfOrder = await seedOrder(world, tenantId, "452s", AGENT_PHONE, { unitPrice: "9000.00", qty: 1 });
    let selfDealing = false;
    try {
      await svc.attributeOrderToAgent(world.db, { tenantId, orderId: selfOrder.orderId, agentCode: "AGT-452" });
    } catch (e: any) {
      selfDealing = true;
      assert(e?.code === "self-dealing", `self-order refusal coded (${e?.code})`);
    }
    assert(selfDealing, "agent cannot be attributed to their own order");
    // Sweep path: even with a pre-stamped agentCode the accrual refuses.
    const [so] = await world.db.select().from(schema.orders).where(eq(schema.orders.id, selfOrder.orderId));
    await world.db.update(schema.orders)
      .set({ metadata: { ...((so.metadata as any) ?? {}), agentCode: "AGT-452" } as any })
      .where(eq(schema.orders.id, selfOrder.orderId));
    const sweep = await svc.sweepAgentCommissions(world.db, tenantId);
    assert(sweep.accrued === 0, "sweep never accrues a self-order");

    // ── 4. Legit order accrues; statement pays out (owner) ──────────────
    const p1 = await seedOrder(world, tenantId, "452b", BUYER, { unitPrice: "5000.00", qty: 2 });
    const att = await svc.attributeOrderToAgent(world.db, { tenantId, orderId: p1.orderId, agentCode: "AGT-452" });
    assert(att.commission?.commissionCents === 100_000, "legit attribution accrues");
    const { statements } = await svc.generateCommissionStatement(world.db, {
      tenantId, agentId: agent.id, from: new Date(Date.now() - 86400_000), to: new Date(Date.now() + 60_000),
    });
    await expectTrpcError(
      operator.ucDocs.payCommissionStatement({ tenantId, statementId: statements[0].id }),
      "FORBIDDEN",
      "operator cannot pay commission statements (owner-only)",
    );
    const paid = await caller.ucDocs.payCommissionStatement({ tenantId, statementId: statements[0].id });
    assert(paid.statement.status === "paid", "owner pays the statement");

    // ── 5. Payout-phone reroute after a paid commission needs step-up ───
    await expectTrpcError(
      caller.ucDocs.upsertAgent({ tenantId, name: "Agent Ada", phone: "2348099999452", code: "AGT-452", commissionBps: 1000 }),
      "PRECONDITION_FAILED",
      "payout phone change without step-up refused",
    );
    const challenge = await seedPayoutChallenge(world, tenantId, "4601", "777777");
    const rerouted = await caller.ucDocs.upsertAgent({
      tenantId, name: "Agent Ada", phone: "2348099999452", code: "AGT-452", commissionBps: 1000,
      stepUpChallengeId: challenge, stepUpOtp: "777777",
    });
    assert(rerouted.agent.phone === "2348099999452", "payout phone changed with step-up");
    const audit = await world.db.select().from(schema.auditLogs)
      .where(and(eq(schema.auditLogs.action, "agent.payoutPhoneChanged"), eq(schema.auditLogs.tenantId, tenantId)));
    assert(audit.length === 1, "payout phone change audited");
  },
};
