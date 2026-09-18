// === W46 uc-docs ===
/**
 * J405 — UC-20: agents/resellers. Attribution by code stamps the order and
 * accrues commission for PAID orders (floor of total × bps); re-attribution
 * never double-accrues (unique agent+order claim); the commission statement
 * binds the period's pending commissions (claim-first), delivers as a chat
 * document, and pays out through the customer-wallet rail with an idempotent
 * refId — a second pay moves NO money twice.
 */
import { and, eq } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { seedUcTenant, seedOrder } from "./w46-uc-docs-seed";

const AGENT_PHONE = "2348040000405";
const BUYER = "2348040001405";

export const journey: Journey = {
  id: "J405",
  name: "agent attribution + commission statement + wallet payout",
  feature: "W46 uc-docs: UC-20 agents/commissions",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const svc = await import("../../server/services/agents");
    const { walletBalance } = await import("../../server/services/customerWallet");
    const { tenantId, caller } = await seedUcTenant(world, "405");

    const { agent } = await caller.ucDocs.upsertAgent({
      tenantId, name: "Agent Abioye", phone: AGENT_PHONE, code: "AGT-405", commissionBps: 1000, // 10%
    });
    assert(agent.code === "AGT-405" && agent.status === "active", "agent created");

    // Unpaid order: attribution stamps metadata but accrues NOTHING.
    const unpaid = await seedOrder(world, tenantId, "405a", BUYER, { paid: false, paymentStatus: "unpaid", unitPrice: "5000.00", qty: 1 });
    const att0 = await svc.attributeOrderToAgent(world.db, { tenantId, orderId: unpaid.orderId, agentCode: "agt-405" });
    assert(att0.attributed && att0.commission === null && att0.reason === "order-not-paid", "unpaid order: attributed, no accrual");
    const [o0] = await world.db.select().from(schema.orders).where(eq(schema.orders.id, unpaid.orderId));
    assert((o0.metadata as any)?.agentCode === "AGT-405", "order stamped with agent code");

    // Paid orders accrue: 10% of ₦10,000 = ₦1,000 (100_000 cents).
    const p1 = await seedOrder(world, tenantId, "405b", BUYER, { unitPrice: "5000.00", qty: 2 });
    const p2 = await seedOrder(world, tenantId, "405c", BUYER, { unitPrice: "2500.00", qty: 1 });
    const att1 = await svc.attributeOrderToAgent(world.db, { tenantId, orderId: p1.orderId, agentCode: "AGT-405" });
    assert(att1.commission?.commissionCents === 100_000, `commission 100000 (got ${att1.commission?.commissionCents})`);
    // Idempotent re-attribution.
    const att1b = await svc.attributeOrderToAgent(world.db, { tenantId, orderId: p1.orderId, agentCode: "AGT-405" });
    assert(att1b.commission?.status && att1b.agent.id === agent.id, "re-attribution returns existing");
    const rows = await world.db.select().from(schema.agentCommissions)
      .where(and(eq(schema.agentCommissions.agentId, agent.id), eq(schema.agentCommissions.orderId, p1.orderId)));
    assert(rows.length === 1, "unique (agent, order) claim — no double accrual");

    // Sweep picks up checkout-attributed orders (metadata.agentCode set at checkout).
    const [p2row] = await world.db.select().from(schema.orders).where(eq(schema.orders.id, p2.orderId));
    await world.db.update(schema.orders).set({ metadata: { ...((p2row.metadata as any) ?? {}), agentCode: "AGT-405" } as any }).where(eq(schema.orders.id, p2.orderId));
    const sweep = await svc.sweepAgentCommissions(world.db, tenantId);
    assert(sweep.accrued === 1, `sweep accrued the one new paid order (got ${sweep.accrued})`);
    const sweep2 = await svc.sweepAgentCommissions(world.db, tenantId);
    assert(sweep2.accrued === 0, "second sweep accrues nothing (idempotent)");

    // Statement binds the two pending commissions (claim-first), PDF first.
    const from = new Date(Date.now() - 30 * 86400000);
    const to = new Date(Date.now() + 86400000);
    const gen = await caller.ucDocs.generateCommissionStatement({ tenantId, agentId: agent.id, from, to });
    assert(gen.statements.length === 1, "one statement (single currency)");
    const st = gen.statements[0]!;
    assert(st.commissionCount === 2 && st.totalCents === 100_000 + 25_000, `total 125000 (got ${st.totalCents})`);
    const bound = await world.db.select().from(schema.agentCommissions).where(eq(schema.agentCommissions.statementId, st.id));
    assert(bound.length === 2 && bound.every((c: any) => c.status === "approved"), "commissions bound + approved");

    // A second generation over the same period is honest: nothing pending.
    let none = false;
    try {
      await svc.generateCommissionStatement(world.db, { tenantId, agentId: agent.id, from, to });
    } catch (e: any) {
      none = e?.code === "NO_COMMISSIONS";
    }
    assert(none, "no double-binding of commissions");

    // Chat delivery of the statement.
    const sent = await caller.ucDocs.sendCommissionStatement({ tenantId, statementId: st.id });
    assert(sent.statement.status === "sent" && sent.delivery.channel === "whatsapp", "statement sent as chat document");

    // Payout via the customer-wallet rail: idempotent refId.
    const pay1 = await caller.ucDocs.payCommissionStatement({ tenantId, statementId: st.id });
    assert(pay1.statement.status === "paid" && pay1.statement.payoutRef === `agent-commission:${st.id}`, "paid with payout ref");
    const bal1 = await walletBalance(tenantId, AGENT_PHONE);
    assert(bal1 === 125_000, `agent wallet credited 125000 (got ${bal1})`);
    const pay2 = await svc.payCommissionStatement(world.db, { tenantId, statementId: st.id });
    assert(pay2.alreadyPaid === true, "re-pay short-circuits");
    const bal2 = await walletBalance(tenantId, AGENT_PHONE);
    assert(bal2 === 125_000, "no money moved twice");
    const paidComms = await world.db.select().from(schema.agentCommissions).where(eq(schema.agentCommissions.statementId, st.id));
    assert(paidComms.every((c: any) => c.status === "paid"), "commissions flipped to paid");

    // Wallet ledger carries the payout attribution (supplierRef convention).
    const entries = await world.db.select().from(schema.customerWalletEntries)
      .where(eq(schema.customerWalletEntries.refId, `agent-commission:${st.id}`));
    assert(entries.length === 1 && (entries[0]!.metadata as any)?.supplierRef === "agent:AGT-405", "ledger entry carries agent attribution");

    // Suspended agent refuses attribution.
    await caller.ucDocs.upsertAgent({ tenantId, name: "Agent Abioye", phone: AGENT_PHONE, code: "AGT-405", commissionBps: 1000, status: "suspended" });
    const p3 = await seedOrder(world, tenantId, "405d", BUYER, { unitPrice: "1000.00", qty: 1 });
    let suspendedRefused = false;
    try {
      await svc.attributeOrderToAgent(world.db, { tenantId, orderId: p3.orderId, agentCode: "AGT-405" });
    } catch (e: any) {
      suspendedRefused = e?.code === "inactive";
    }
    assert(suspendedRefused, "suspended agent refused");
  },
};
