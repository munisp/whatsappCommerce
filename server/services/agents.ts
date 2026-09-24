// === W46 uc-docs ===
/**
 * UC-20 — agents / resellers: order attribution + commission statements.
 *
 * Model:
 *  - `agents`: a merchant tenant's resellers, keyed by a human attribution
 *    code (unique per tenant) that buyers quote at checkout.
 *  - Attribution: orders.metadata.agentCode (captured at checkout or set
 *    post-hoc by the merchant). `attributeOrderToAgent` resolves the code →
 *    agent and stamps metadata {agentId, agentCode}; accrual happens ONLY
 *    for paid orders (payment_status 'completed', not refunded).
 *  - `agent_commissions`: one row per (agent, order) — the unique index is
 *    the exactly-once claim; re-attribution and re-sweeps never double
 *    accrue. Commission = floor(orderTotalCents * commissionBps / 10000).
 *  - Commission statements aggregate a period's unpaid commissions into a
 *    PDF delivered as a chat document (WA/TG, parity category
 *    'agent_commission'), then pay out through the EXISTING customer-wallet
 *    payout rail: creditWallet(reason 'agent_commission', refId
 *    `agent-commission:<statementId>`) — idempotent by the ledger's
 *    (ref_id, direction) claim. payout_ref records the wallet entry.
 */
import crypto from "crypto";
import { and, eq, sql } from "drizzle-orm";
import { agentCommissions, agentCommissionStatements, agents, orders } from "../../drizzle/schema";
import { linesToPdf, writeDocPdf, sendChatDocument } from "./ucDocsPdf";

type Db = any;

export class AgentError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "AgentError";
    this.code = code;
  }
}

function toCents(v: unknown): number {
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

// === W47 stakeholders === ONB-S-11 agent self-dealing guards.
/** Per-tenant commission cap (bps). Env-overridable; default 30%. */
export function agentCommissionBpsCap(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.AGENT_COMMISSION_BPS_CAP ?? "3000");
  return Number.isInteger(raw) && raw >= 0 && raw <= 10000 ? raw : 3000;
}

/** Digit-normalised phone comparison (agent phone vs order customer). */
export function phonesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const d = (p: string) => p.replace(/\D/g, "");
  return d(a).length > 0 && d(a) === d(b);
}
// === END W47 stakeholders ===

// ── Agent CRUD ────────────────────────────────────────────────────────────────
export async function upsertAgent(
  db: Db,
  input: { tenantId: string; name: string; phone: string; code: string; commissionBps: number; status?: "active" | "suspended"; metadata?: Record<string, unknown> | null; phoneChangeAuthorized?: boolean },
) {
  if (!input.name?.trim()) throw new AgentError("invalid-agent", "agent name required");
  if (!input.phone?.trim()) throw new AgentError("invalid-agent", "agent phone required");
  const code = input.code.trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9-]{1,31}$/.test(code)) throw new AgentError("invalid-agent", "code must be 2-32 chars of A-Z 0-9 -");
  if (!Number.isInteger(input.commissionBps) || input.commissionBps < 0 || input.commissionBps > 10000) {
    throw new AgentError("invalid-agent", "commissionBps must be an integer 0..10000");
  }
  // === W47 stakeholders === ONB-S-11: commission cap (default 3000 bps =
  // 30%) — an operator can no longer mint a 100%-commission agent.
  const cap = agentCommissionBpsCap();
  if (input.commissionBps > cap) {
    throw new AgentError("commission-cap", `commissionBps may not exceed the tenant cap of ${cap} bps (${cap / 100}%)`);
  }
  // === END W47 stakeholders ===
  const [existing] = await db.select().from(agents)
    .where(and(eq(agents.tenantId, input.tenantId), eq(agents.code, code))).limit(1);
  const now = new Date();
  if (existing) {
    // === W47 stakeholders === ONB-S-11: the payout phone is IMMUTABLE once
    // the agent has any paid commission unless the caller authorized the
    // change out-of-band (router enforces a payout_change step-up OTP).
    const phoneChanged = !phonesMatch(existing.phone, input.phone);
    if (phoneChanged) {
      const [paid] = await db.select({ id: agentCommissions.id }).from(agentCommissions)
        .where(and(eq(agentCommissions.agentId, existing.id), eq(agentCommissions.status, "paid"))).limit(1);
      if (paid && !input.phoneChangeAuthorized) {
        throw new AgentError("payout-phone-locked", "agent payout phone is locked after the first paid commission — a payout_change step-up OTP is required to reroute payouts");
      }
    }
    // === END W47 stakeholders ===
    await db.update(agents).set({
      name: input.name, phone: input.phone, commissionBps: input.commissionBps,
      status: input.status ?? existing.status,
      metadata: input.metadata !== undefined ? input.metadata : existing.metadata,
      updatedAt: now,
    }).where(eq(agents.id, existing.id));
    const [row] = await db.select().from(agents).where(eq(agents.id, existing.id));
    return { agent: row, created: false };
  }
  const id = crypto.randomUUID();
  await db.insert(agents).values({
    id, tenantId: input.tenantId, name: input.name, phone: input.phone, code,
    commissionBps: input.commissionBps, status: input.status ?? "active",
    metadata: input.metadata ?? null, createdAt: now, updatedAt: now,
  });
  const [row] = await db.select().from(agents).where(eq(agents.id, id));
  return { agent: row, created: true };
}

export async function findAgentByCode(db: Db, tenantId: string, code: string) {
  const [row] = await db.select().from(agents)
    .where(and(eq(agents.tenantId, tenantId), eq(agents.code, code.trim().toUpperCase()))).limit(1);
  return row ?? null;
}

// ── Attribution + accrual ─────────────────────────────────────────────────────
/**
 * Attribute an order to an agent (by code) and accrue commission when the
 * order is already paid. Idempotent: the (agent_id, order_id) unique index
 * is the claim; a second call returns the existing row untouched.
 */
export async function attributeOrderToAgent(
  db: Db,
  opts: { tenantId: string; orderId: string; agentCode: string },
) {
  const agent = await findAgentByCode(db, opts.tenantId, opts.agentCode);
  if (!agent) throw new AgentError("not-found", `no agent with code ${opts.agentCode}`);
  if (agent.status !== "active") throw new AgentError("inactive", `agent ${agent.code} is ${agent.status}`);
  const [order] = await db.select().from(orders)
    .where(and(eq(orders.id, opts.orderId), eq(orders.tenantId, opts.tenantId))).limit(1);
  if (!order) throw new AgentError("not-found", "order not found");

  // === W47 stakeholders === ONB-S-11: self-order exclusion — an agent can
  // never earn commission on an order placed by their OWN phone.
  if (phonesMatch(order.customerId, agent.phone)) {
    throw new AgentError("self-dealing", "an agent cannot be attributed to their own order (agent phone matches the order customer)");
  }
  // === END W47 stakeholders ===

  // Stamp attribution onto the order (merge into existing metadata).
  const meta = { ...((order.metadata as any) ?? {}), agentId: agent.id, agentCode: agent.code };
  await db.update(orders).set({ metadata: meta as any, updatedAt: new Date() }).where(eq(orders.id, order.id));

  const paid = order.paymentStatus === "completed";
  if (!paid) return { agent, orderId: order.id, attributed: true, commission: null, reason: "order-not-paid" };
  const accrual = await accrueCommission(db, { tenantId: opts.tenantId, agent, order });
  return { agent, orderId: order.id, attributed: true, commission: accrual.commission, commissionDuplicate: accrual.duplicate };
}

/** Accrue (or return the existing) commission for a paid order. */
export async function accrueCommission(db: Db, opts: { tenantId: string; agent: any; order: any }) {
  const { agent, order } = opts;
  // === W47 stakeholders === ONB-S-11: self-order exclusion at the single
  // accrual point too (sweep/checkout-attributed orders bypass
  // attributeOrderToAgent's guard).
  if (phonesMatch(order.customerId, agent.phone)) {
    throw new AgentError("self-dealing", "an agent cannot accrue commission on their own order");
  }
  // === END W47 stakeholders ===
  const orderTotalCents = toCents(order.totalAmount);
  if (!(orderTotalCents > 0)) throw new AgentError("invalid-amount", "order total is not positive");
  const commissionCents = Math.floor((orderTotalCents * Number(agent.commissionBps)) / 10000);
  const currency = (order.currency ?? "NGN").toUpperCase().slice(0, 3);
  const claimed = await db.insert(agentCommissions).values({
    id: crypto.randomUUID(),
    tenantId: opts.tenantId,
    agentId: agent.id,
    orderId: order.id,
    orderTotalCents,
    commissionCents,
    currency,
    status: "pending",
    createdAt: new Date(),
    updatedAt: new Date(),
  }).onConflictDoNothing({ target: [agentCommissions.agentId, agentCommissions.orderId] }).returning();
  if (claimed?.length) return { commission: claimed[0], duplicate: false };
  const [existing] = await db.select().from(agentCommissions)
    .where(and(eq(agentCommissions.agentId, agent.id), eq(agentCommissions.orderId, order.id))).limit(1);
  return { commission: existing, duplicate: true };
}

/**
 * Sweep: accrue commissions for every PAID order carrying
 * metadata.agentCode that has no commission row yet (e.g. orders attributed
 * at checkout time by the NLP engine). Claim-first per (agent, order).
 */
export async function sweepAgentCommissions(db: Db, tenantId: string): Promise<{ accrued: number; errors: string[] }> {
  const rows = await db.select().from(orders)
    .where(and(
      eq(orders.tenantId, tenantId),
      eq(orders.paymentStatus, "completed"),
      sql`${orders.metadata}->>'agentCode' IS NOT NULL`,
    )).catch(() => [] as any[]);
  let accrued = 0;
  const errors: string[] = [];
  for (const order of rows ?? []) {
    try {
      const agent = await findAgentByCode(db, tenantId, (order.metadata as any).agentCode);
      if (!agent || agent.status !== "active") continue;
      const r = await accrueCommission(db, { tenantId, agent, order });
      if (!r.duplicate) accrued++;
    } catch (e: any) {
      errors.push(String(order.id));
    }
  }
  return { accrued, errors };
}

// ── Commission statements ─────────────────────────────────────────────────────
export function commissionStatementPdfLines(st: any, agent: any, lines: any[]): string[] {
  const fmt = (c: number) => `${st.currency} ${(c / 100).toFixed(2)}`;
  return [
    `Merchant:      ${st.tenantId}`,
    `Agent:         ${agent.name} (${agent.code})`,
    `Period:        ${new Date(st.periodStart).toISOString().slice(0, 10)} .. ${new Date(st.periodEnd).toISOString().slice(0, 10)}`,
    `Currency:      ${st.currency}`,
    "",
    "COMMISSIONS",
    ...lines.map((c) => `  order ${String(c.orderId).slice(0, 12).padEnd(12)}  base ${fmt(c.orderTotalCents).padEnd(14)} commission ${fmt(c.commissionCents)}`),
    "",
    `Total commission: ${fmt(st.totalCents)} across ${st.commissionCount} order(s)`,
    "",
    "Generated from real attributed paid orders.",
  ];
}

/**
 * Generate a commission statement for an agent over a period: collects the
 * period's pending commissions (per currency), writes the PDF FIRST, then
 * claims the commissions onto the statement (statement_id flip is the
 * claim — concurrent generation never double-binds a commission).
 */
export async function generateCommissionStatement(
  db: Db,
  opts: { tenantId: string; agentId: string; from: Date; to: Date },
) {
  const { tenantId, agentId, from, to } = opts;
  if (!(from < to)) throw new AgentError("invalid-period", "from must be before to");
  const [agent] = await db.select().from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.tenantId, tenantId))).limit(1);
  if (!agent) throw new AgentError("not-found", "agent not found");

  // Claim-first binding: pending, unbound, in-period → statement. Do it per
  // currency (one statement per currency, never summed across).
  const currencies: any = await db.execute(sql`
    SELECT DISTINCT currency FROM agent_commissions
    WHERE tenant_id = ${tenantId} AND agent_id = ${agentId}
      AND status = 'pending' AND statement_id IS NULL
      AND created_at >= ${from.toISOString()} AND created_at < ${to.toISOString()}
  `);
  const curRows: any[] = Array.isArray(currencies) ? currencies : currencies?.rows ?? [];
  if (!curRows.length) throw new AgentError("NO_COMMISSIONS", "no pending commissions for this agent in that period");

  const out: any[] = [];
  for (const { currency } of curRows) {
    const statementId = crypto.randomUUID();
    const bound: any = await db.execute(sql`
      UPDATE agent_commissions
      SET statement_id = ${statementId}, status = 'approved', updated_at = now()
      WHERE tenant_id = ${tenantId} AND agent_id = ${agentId}
        AND status = 'pending' AND statement_id IS NULL AND currency = ${currency}
        AND created_at >= ${from.toISOString()} AND created_at < ${to.toISOString()}
      RETURNING id, order_id, order_total_cents, commission_cents
    `);
    const lines: any[] = Array.isArray(bound) ? bound : bound?.rows ?? [];
    if (!lines.length) continue; // raced — another sweep bound them first
    const totalCents = lines.reduce((s, l) => s + Number(l.commission_cents), 0);
    const st = {
      tenantId, agentId, periodStart: from, periodEnd: to, currency,
      commissionCount: lines.length, totalCents,
    };
    const pdf = linesToPdf({
      title: `Agent Commission Statement — ${agent.code}`,
      lines: commissionStatementPdfLines({ ...st, tenant_id: tenantId }, agent, lines.map((l) => ({ orderId: l.order_id, orderTotalCents: Number(l.order_total_cents), commissionCents: Number(l.commission_cents) }))),
    });
    const rel = `${String(tenantId).replace(/[^A-Za-z0-9_.-]/g, "_")}/commissions/${agent.code}-${from.toISOString().slice(0, 10)}_${to.toISOString().slice(0, 10)}.${currency}.${statementId.slice(0, 8)}.pdf`;
    writeDocPdf(rel, pdf); // throws honestly before any row claims 'generated'

    const now = new Date();
    await db.insert(agentCommissionStatements).values({
      id: statementId, ...st,
      status: "generated", pdfPath: rel, generatedAt: now, createdAt: now, updatedAt: now,
    });
    const [row] = await db.select().from(agentCommissionStatements).where(eq(agentCommissionStatements.id, statementId));
    out.push(row);
  }
  if (!out.length) throw new AgentError("NO_COMMISSIONS", "commissions were claimed by a concurrent statement run");
  return { statements: out, agent };
}

/** Send a generated commission statement to the agent as a chat document. */
export async function sendCommissionStatement(db: Db, opts: { tenantId: string; statementId: string }) {
  const [st] = await db.select().from(agentCommissionStatements)
    .where(and(eq(agentCommissionStatements.id, opts.statementId), eq(agentCommissionStatements.tenantId, opts.tenantId)))
    .limit(1);
  if (!st) throw new AgentError("not-found", "statement not found");
  if (!st.pdfPath) throw new AgentError("no-pdf", "statement PDF missing — regenerate first");
  const [agent] = await db.select().from(agents).where(eq(agents.id, st.agentId)).limit(1);
  if (!agent) throw new AgentError("not-found", "agent not found");

  const res = await sendChatDocument(opts.tenantId, agent.phone, {
    relPath: st.pdfPath,
    filename: `commission-statement-${st.id.slice(0, 8)}-${st.currency}.pdf`,
    caption: `Commission statement from ${opts.tenantId}: ${st.currency} ${(st.totalCents / 100).toFixed(2)} across ${st.commissionCount} order(s).`,
    notifType: "agent_commission_statement_send",
    category: "agent_commission",
  });
  const now = new Date();
  await db.update(agentCommissionStatements).set({
    status: "sent", sentAt: now, waMessageId: res.messageId, channel: res.channel, updatedAt: now,
  }).where(eq(agentCommissionStatements.id, st.id));
  const [row] = await db.select().from(agentCommissionStatements).where(eq(agentCommissionStatements.id, st.id));
  return { statement: row, delivery: res };
}

/**
 * Pay a generated/sent commission statement through the existing payout
 * rail: an idempotent customer-wallet credit to the agent's phone
 * (creditWallet reason 'agent_commission', refId
 * `agent-commission:<statementId>` — the (ref_id, direction) ledger claim
 * makes retries safe). Commissions flip to 'paid' only after the credit.
 */
export async function payCommissionStatement(db: Db, opts: { tenantId: string; statementId: string }) {
  const [st] = await db.select().from(agentCommissionStatements)
    .where(and(eq(agentCommissionStatements.id, opts.statementId), eq(agentCommissionStatements.tenantId, opts.tenantId)))
    .limit(1);
  if (!st) throw new AgentError("not-found", "statement not found");
  if (st.status === "paid") return { statement: st, alreadyPaid: true };
  if (st.status === "cancelled") throw new AgentError("bad-status", "a cancelled statement cannot be paid");
  if (!(st.totalCents > 0)) throw new AgentError("invalid-amount", "statement total is not positive");
  const [agent] = await db.select().from(agents).where(eq(agents.id, st.agentId)).limit(1);
  if (!agent) throw new AgentError("not-found", "agent not found");

  const refId = `agent-commission:${st.id}`;
  const { creditWallet } = await import("./customerWallet");
  const credited = await creditWallet(opts.tenantId, { phone: agent.phone }, st.totalCents, "agent_commission", refId, db, {
    agentId: agent.id, agentCode: agent.code, statementId: st.id,
    supplierRef: `agent:${agent.code}`, supplierName: agent.name, currency: st.currency,
  });
  if (!credited.ok) throw new AgentError("payout-failed", `wallet payout refused: ${credited.error ?? "unknown"}`);

  const now = new Date();
  await db.update(agentCommissions).set({ status: "paid", updatedAt: now })
    .where(and(eq(agentCommissions.statementId, st.id), eq(agentCommissions.status, "approved")));
  await db.update(agentCommissionStatements).set({
    status: "paid", paidAt: now, payoutRef: refId, updatedAt: now,
  }).where(eq(agentCommissionStatements.id, st.id));
  const [row] = await db.select().from(agentCommissionStatements).where(eq(agentCommissionStatements.id, st.id));
  return { statement: row, alreadyPaid: credited.duplicate === true, balanceCents: credited.balanceCents };
}
// === END W46 uc-docs ===
