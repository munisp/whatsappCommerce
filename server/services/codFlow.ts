/**
 * codFlow.ts — W17/F10: Cash-on-delivery + offline-trade flow depth.
 *
 * State machine (orders.codState):
 *
 *   cod_pending ──▶ rider_assigned ──▶ out_for_delivery ──▶ delivered_pending_cash
 *        │               │                    │                     │
 *        ▼               ▼                    ▼                     ▼
 *     refused      delivery_failed      delivery_failed      cash_collected ──▶ settled
 *        │               │                    │                     │
 *        ▼               ▼                    ▼                     ▼
 *     returned ◀── returned/retry ◀──── refused              returned
 *
 * Every transition is validated against COD_TRANSITIONS — an illegal move
 * throws CodTransitionError (never a silent no-op) — and recorded in the
 * append-only `cod_events` table.
 *
 * FUNDS-CRITICAL discipline (escrow.ts/poFlow.ts patterns):
 *   - Cash collection claims via a unique providerRef on payment_transactions
 *     (`cod-collect:<orderId>:<state>:<amount>`) — a replay inserts nothing and
 *     reports applied:false, so money rows are never doubled.
 *   - cash_collected / settled are claimed FIRST by inserting the cod_events
 *     row (partial unique indexes in migration 0056 allow at most one of each
 *     per order); only the claim winner mutates the order. A replay / lost
 *     race is a no-op read-back, never a second write.
 *   - Discrepancies (collected ≠ expected) raise a merchant_notifications
 *     alert (type cod_discrepancy).
 */
import { and, eq, gte, inArray, isNotNull } from "drizzle-orm";
import {
  codEvents,
  merchantNotifications,
  orders,
  paymentTransactions,
  tenants,
  type Order,
} from "../../drizzle/schema";

/** Minimal db handle so unit tests can drive the flow with an in-memory fake
 * (same discipline as services/procurement/fakeDb.ts). */
export interface DbHandle {
  select: (...args: any[]) => any;
  insert: (...args: any[]) => any;
  update: (...args: any[]) => any;
  transaction?: <T>(fn: (tx: DbHandle) => Promise<T>) => Promise<T>;
}

// ── State machine ────────────────────────────────────────────────────────────

export const COD_STATES = [
  "cod_pending",
  "rider_assigned",
  "out_for_delivery",
  "delivered_pending_cash",
  "cash_collected",
  "settled",
  "delivery_failed",
  "refused",
  "returned",
] as const;
export type CodState = (typeof COD_STATES)[number];

export const COD_TRANSITIONS: Record<CodState, readonly CodState[]> = {
  cod_pending: ["rider_assigned", "refused"],
  rider_assigned: ["out_for_delivery", "delivery_failed", "refused"],
  out_for_delivery: ["delivered_pending_cash", "delivery_failed", "refused"],
  delivered_pending_cash: ["cash_collected", "refused", "returned"],
  cash_collected: ["settled", "returned"],
  settled: [],
  delivery_failed: ["rider_assigned", "returned"], // retry or give up
  refused: ["returned"],
  returned: [],
};

export class CodTransitionError extends Error {
  readonly code = "ILLEGAL_COD_TRANSITION";
  constructor(
    public readonly fromState: string | null,
    public readonly toState: string,
    message?: string,
  ) {
    super(
      message ??
        `Illegal COD transition: ${fromState ?? "(none)"} → ${toState}`,
    );
    this.name = "CodTransitionError";
  }
}

export function assertCodTransition(from: string | null, to: CodState): void {
  if (from == null) {
    // Only entry into the machine is cod_pending (set at order creation).
    throw new CodTransitionError(from, to, `Order is not in the COD flow (cannot move to ${to})`);
  }
  const allowed = COD_TRANSITIONS[from as CodState];
  if (!allowed || !allowed.includes(to)) {
    throw new CodTransitionError(from, to);
  }
}

// ── Reads ────────────────────────────────────────────────────────────────────

export async function getCodOrder(db: DbHandle, tenantId: string, orderId: string): Promise<Order | null> {
  const [row] = await db
    .select()
    .from(orders)
    .where(and(eq(orders.id, orderId), eq(orders.tenantId, tenantId)))
    .limit(1);
  return row ?? null;
}

export async function listCodOrders(db: DbHandle, tenantId: string): Promise<Order[]> {
  return db
    .select()
    .from(orders)
    .where(and(eq(orders.tenantId, tenantId), isNotNull(orders.codState)))
    .orderBy(orders.createdAt);
}

export async function codEventsForOrder(db: DbHandle, tenantId: string, orderId: string) {
  return db
    .select()
    .from(codEvents)
    .where(and(eq(codEvents.tenantId, tenantId), eq(codEvents.orderId, orderId)))
    .orderBy(codEvents.createdAt);
}

// ── Merchant alerts ──────────────────────────────────────────────────────────

async function notifyMerchant(
  db: DbHandle,
  tenantId: string,
  type: "cod_discrepancy" | "cod_delivery_failed",
  title: string,
  body: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await db.insert(merchantNotifications).values({
    tenantId,
    type,
    title,
    body,
    metadata,
  });
}

// ── Transitions ──────────────────────────────────────────────────────────────

export interface TransitionResult {
  orderId: string;
  fromState: string | null;
  toState: CodState;
}

/**
 * Validated COD transition. delivery_failed/refused/returned raise a merchant
 * notification (the merchant must know cash will never arrive).
 */
export async function transitionCod(
  db: DbHandle,
  opts: {
    tenantId: string;
    orderId: string;
    to: CodState;
    actor: string;
    note?: string | null;
    /** Required for delivery_failed (audited reason). */
    reason?: string | null;
  },
): Promise<TransitionResult> {
  const order = await getCodOrder(db, opts.tenantId, opts.orderId);
  if (!order) throw new CodTransitionError(null, opts.to, "Order not found for tenant");
  assertCodTransition(order.codState, opts.to);
  if (opts.to === "delivery_failed" && !opts.reason) {
    throw new CodTransitionError(order.codState, opts.to, "delivery_failed requires a reason");
  }

  const apply = async (h: DbHandle) => {
    await h.insert(codEvents).values({
      id: crypto.randomUUID(),
      tenantId: opts.tenantId,
      orderId: opts.orderId,
      fromState: order.codState,
      toState: opts.to,
      actor: opts.actor,
      note: opts.note ?? opts.reason ?? null,
    });
    await h
      .update(orders)
      .set({ codState: opts.to, updatedAt: new Date() })
      .where(and(eq(orders.id, opts.orderId), eq(orders.tenantId, opts.tenantId)));
  };
  if (db.transaction) await db.transaction(apply);
  else await apply(db);

  if (opts.to === "delivery_failed" || opts.to === "refused" || opts.to === "returned") {
    const label =
      opts.to === "delivery_failed"
        ? `Delivery failed${opts.reason ? `: ${opts.reason}` : ""}`
        : opts.to === "refused"
          ? "Customer refused the order"
          : "Order returned";
    await notifyMerchant(
      db,
      opts.tenantId,
      "cod_delivery_failed",
      `COD ${opts.to.replace(/_/g, " ")} — ${order.orderNumber}`,
      `${label} for COD order ${order.orderNumber} (₦${order.totalAmount}). ${opts.note ?? ""}`.trim(),
      { orderId: opts.orderId, orderNumber: order.orderNumber, toState: opts.to, reason: opts.reason ?? null },
    ).catch(() => {});
  }

  return { orderId: opts.orderId, fromState: order.codState, toState: opts.to };
}

// ── Partial-payment summary ──────────────────────────────────────────────────

export interface OrderPaymentSummary {
  orderId: string;
  total: number;
  totalPaid: number;
  remaining: number;
  status: "unpaid" | "partial" | "paid";
  /** collected − total (0 when exact; positive when over-collected). */
  variance: number;
}

/** Sums COMPLETED payment rows (online gateway confirms + COD cash +
 * offline cash/transfer records) against the order total. */
export async function orderPaymentSummary(
  db: DbHandle,
  tenantId: string,
  orderId: string,
): Promise<OrderPaymentSummary> {
  const order = await getCodOrder(db, tenantId, orderId);
  if (!order) throw new Error(`Order ${orderId} not found for tenant`);
  const rows = await db
    .select()
    .from(paymentTransactions)
    .where(
      and(
        eq(paymentTransactions.tenantId, tenantId),
        eq(paymentTransactions.orderId, orderId),
        eq(paymentTransactions.status, "completed"),
      ),
    );
  const total = Number(order.totalAmount);
  const totalPaid = rows.reduce((s: number, r: any) => s + Number(r.amount), 0);
  const remaining = Math.max(0, Math.round((total - totalPaid) * 100) / 100);
  const variance = Math.round((totalPaid - total) * 100) / 100;
  return {
    orderId,
    total,
    totalPaid: Math.round(totalPaid * 100) / 100,
    remaining,
    status: totalPaid <= 0 ? "unpaid" : remaining > 0 ? "partial" : "paid",
    variance,
  };
}

// ── Cash collection (idempotent) ─────────────────────────────────────────────

export interface ConfirmCollectionResult {
  applied: boolean; // false on idempotent replay
  summary: OrderPaymentSummary;
  codState: string | null;
  completed: boolean; // reached cash_collected
  discrepancy?: { expected: number; collected: number; variance: number };
}

/**
 * Rider confirms cash collected for an order. Idempotency key is derived from
 * orderId + current codState + amount (`cod-collect:<orderId>:<state>:<amount>`)
 * unless the caller supplies one — replaying the same confirmation claims
 * nothing (providerRef partial unique index) and returns applied:false.
 *
 * Partial collection: the cash row is recorded, the order stays in
 * delivered_pending_cash and the remaining balance is tracked via
 * orderPaymentSummary. When the balance reaches zero (or opts.final forces
 * completion with an under-collection variance) the order advances to
 * cash_collected (claim-first on the cod_events partial unique index).
 */
export async function confirmCashCollection(
  db: DbHandle,
  opts: {
    tenantId: string;
    orderId: string;
    /** Major units collected this confirmation (e.g. naira). */
    amount: number;
    actor: string;
    note?: string | null;
    idempotencyKey?: string;
    /** Force cash_collected even when collected < expected (variance alert). */
    final?: boolean;
  },
): Promise<ConfirmCollectionResult> {
  const order = await getCodOrder(db, opts.tenantId, opts.orderId);
  if (!order) throw new Error(`Order ${opts.orderId} not found for tenant`);
  if (order.codState !== "delivered_pending_cash" && order.codState !== "cash_collected") {
    throw new CodTransitionError(
      order.codState,
      "cash_collected",
      `Cash can only be confirmed while delivered_pending_cash (order is ${order.codState ?? "not COD"})`,
    );
  }
  if (!(opts.amount > 0)) throw new Error("Collected amount must be positive");

  const amount = Math.round(opts.amount * 100) / 100;
  const ref =
    opts.idempotencyKey ??
    `cod-collect:${opts.orderId}:${order.codState}:${amount.toFixed(2)}`;

  // Claim-first: the unique providerRef makes a replay a no-op insert.
  const claimed = await db
    .insert(paymentTransactions)
    .values({
      id: crypto.randomUUID(),
      tenantId: opts.tenantId,
      orderId: opts.orderId,
      customerId: order.customerId,
      provider: "cod",
      providerRef: ref,
      amount: amount.toFixed(2),
      currency: order.currency,
      status: "completed",
      paidAt: new Date(),
      metadata: { kind: "cod_collection", actor: opts.actor, note: opts.note ?? null },
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoNothing()
    .returning({ id: paymentTransactions.id });

  const summary = await orderPaymentSummary(db, opts.tenantId, opts.orderId);
  if (!claimed || claimed.length === 0) {
    // Idempotent replay — nothing was written; report current state.
    return {
      applied: false,
      summary,
      codState: (await getCodOrder(db, opts.tenantId, opts.orderId))?.codState ?? order.codState,
      completed: order.codState === "cash_collected" || summary.remaining <= 0,
    };
  }

  await db.insert(codEvents).values({
    id: crypto.randomUUID(),
    tenantId: opts.tenantId,
    orderId: opts.orderId,
    fromState: order.codState,
    toState: order.codState, // cash record, no state change yet
    actor: opts.actor,
    note: `Cash collected: ${amount.toFixed(2)} ${order.currency}${opts.note ? ` — ${opts.note}` : ""}`,
  });

  // Advance to cash_collected when the balance is covered (or forced final).
  let completed = false;
  let discrepancy: ConfirmCollectionResult["discrepancy"];
  if (summary.remaining <= 0 || opts.final) {
    const claim = await db
      .insert(codEvents)
      .values({
        id: crypto.randomUUID(),
        tenantId: opts.tenantId,
        orderId: opts.orderId,
        fromState: "delivered_pending_cash",
        toState: "cash_collected",
        actor: opts.actor,
        note: summary.remaining > 0 ? `final with shortfall ${summary.remaining.toFixed(2)}` : null,
      })
      .onConflictDoNothing()
      .returning({ id: codEvents.id });
    if (claim && claim.length > 0) {
      // Claim winner mutates the order.
      await db
        .update(orders)
        .set({ codState: "cash_collected", paymentStatus: "completed", updatedAt: new Date() })
        .where(and(eq(orders.id, opts.orderId), eq(orders.tenantId, opts.tenantId)));
    }
    completed = true;
    const expected = summary.total;
    const collected = summary.totalPaid;
    if (Math.abs(collected - expected) > 0.004) {
      discrepancy = { expected, collected, variance: Math.round((collected - expected) * 100) / 100 };
      await notifyMerchant(
        db,
        opts.tenantId,
        "cod_discrepancy",
        `COD variance — ${order.orderNumber}`,
        `Cash collected (${collected.toFixed(2)}) ≠ order total (${expected.toFixed(2)}) for ${order.orderNumber}. Variance: ${discrepancy.variance.toFixed(2)} ${order.currency}.`,
        { orderId: opts.orderId, orderNumber: order.orderNumber, ...discrepancy },
      ).catch(() => {});
    }
  }

  const after = await getCodOrder(db, opts.tenantId, opts.orderId);
  return { applied: true, summary, codState: after?.codState ?? order.codState, completed, discrepancy };
}

// ── Settlement (idempotent, claim-first) ─────────────────────────────────────

export interface SettleResult {
  settled: boolean;
  replay: boolean; // true when already settled (no second write)
  summary: OrderPaymentSummary;
}

/**
 * Merchant settles collected rider cash against the order. Claim-first: the
 * cod_events 'settled' row is guarded by a partial unique index (one per
 * order); only the claim winner flips orders.codState → settled. Replays and
 * lost races are read-back no-ops.
 */
export async function settleCod(
  db: DbHandle,
  opts: { tenantId: string; orderId: string; actor: string; note?: string | null },
): Promise<SettleResult> {
  const order = await getCodOrder(db, opts.tenantId, opts.orderId);
  if (!order) throw new Error(`Order ${opts.orderId} not found for tenant`);
  const summary = await orderPaymentSummary(db, opts.tenantId, opts.orderId);

  if (order.codState === "settled") return { settled: true, replay: true, summary };
  assertCodTransition(order.codState, "settled");

  const claim = await db
    .insert(codEvents)
    .values({
      id: crypto.randomUUID(),
      tenantId: opts.tenantId,
      orderId: opts.orderId,
      fromState: order.codState,
      toState: "settled",
      actor: opts.actor,
      note: opts.note ?? `Settled ${summary.totalPaid.toFixed(2)} against ${summary.total.toFixed(2)}`,
    })
    .onConflictDoNothing()
    .returning({ id: codEvents.id });

  if (!claim || claim.length === 0) {
    return { settled: true, replay: true, summary }; // lost the race / replay
  }
  await db
    .update(orders)
    .set({ codState: "settled", updatedAt: new Date() })
    .where(and(eq(orders.id, opts.orderId), eq(orders.tenantId, opts.tenantId)));
  return { settled: true, replay: false, summary };
}

// ── Reconciliation ───────────────────────────────────────────────────────────

export interface ReconciliationDay {
  date: string; // YYYY-MM-DD (UTC)
  expected: number;
  collected: number;
  variance: number;
}

export interface UnsettledAgingRow {
  orderId: string;
  orderNumber: string;
  codState: string;
  totalAmount: number;
  collectedAmount: number;
  remaining: number;
  ageHours: number;
}

export interface CodReconciliationReport {
  days: ReconciliationDay[];
  unsettled: UnsettledAgingRow[];
  totals: { expected: number; collected: number; variance: number };
}

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Per-day expected (order totals that reached cash_collected that day) vs
 * collected (COD cash rows that day) vs variance, plus the unsettled aging
 * list (cash_collected but not settled, and delivered_pending_cash awaiting
 * cash). `now`/`windowDays` injectable for deterministic tests.
 */
export async function codReconciliation(
  db: DbHandle,
  tenantId: string,
  opts: { windowDays?: number; now?: Date } = {},
): Promise<CodReconciliationReport> {
  const now = opts.now ?? new Date();
  const windowDays = Math.min(Math.max(opts.windowDays ?? 14, 1), 90);
  const since = new Date(now.getTime() - windowDays * 24 * 3600 * 1000);

  const collectedRows: any[] = await db
    .select()
    .from(paymentTransactions)
    .where(
      and(
        eq(paymentTransactions.tenantId, tenantId),
        eq(paymentTransactions.provider, "cod"),
        eq(paymentTransactions.status, "completed"),
        gte(paymentTransactions.paidAt, since),
      ),
    );

  const collectedEvents: any[] = await db
    .select()
    .from(codEvents)
    .where(
      and(
        eq(codEvents.tenantId, tenantId),
        eq(codEvents.toState, "cash_collected"),
        gte(codEvents.createdAt, since),
      ),
    );

  const expectedByOrder = new Map<string, number>();
  for (const ev of collectedEvents) {
    const [o] = await db
      .select()
      .from(orders)
      .where(and(eq(orders.id, ev.orderId), eq(orders.tenantId, tenantId)))
      .limit(1);
    if (o) expectedByOrder.set(dayKey(new Date(ev.createdAt)), (expectedByOrder.get(dayKey(new Date(ev.createdAt))) ?? 0) + Number(o.totalAmount));
  }

  const collectedByDay = new Map<string, number>();
  for (const tx of collectedRows) {
    const k = dayKey(new Date(tx.paidAt ?? tx.createdAt));
    collectedByDay.set(k, (collectedByDay.get(k) ?? 0) + Number(tx.amount));
  }

  const days: ReconciliationDay[] = [];
  for (let i = windowDays - 1; i >= 0; i--) {
    const k = dayKey(new Date(now.getTime() - i * 24 * 3600 * 1000));
    const expected = Math.round((expectedByOrder.get(k) ?? 0) * 100) / 100;
    const collected = Math.round((collectedByDay.get(k) ?? 0) * 100) / 100;
    days.push({ date: k, expected, collected, variance: Math.round((collected - expected) * 100) / 100 });
  }

  // Unsettled aging: cash still with riders / still being collected.
  const openOrders: any[] = await db
    .select()
    .from(orders)
    .where(
      and(
        eq(orders.tenantId, tenantId),
        inArray(orders.codState, ["delivered_pending_cash", "cash_collected"]),
      ),
    );
  const unsettled: UnsettledAgingRow[] = [];
  for (const o of openOrders) {
    const sum = await orderPaymentSummary(db, tenantId, o.id);
    const ageHours = Math.max(
      0,
      Math.round(((now.getTime() - new Date(o.updatedAt ?? o.createdAt).getTime()) / 3600000) * 10) / 10,
    );
    unsettled.push({
      orderId: o.id,
      orderNumber: o.orderNumber,
      codState: o.codState,
      totalAmount: sum.total,
      collectedAmount: sum.totalPaid,
      remaining: sum.remaining,
      ageHours,
    });
  }
  unsettled.sort((a, b) => b.ageHours - a.ageHours);

  const totals = days.reduce(
    (acc, d) => ({
      expected: Math.round((acc.expected + d.expected) * 100) / 100,
      collected: Math.round((acc.collected + d.collected) * 100) / 100,
      variance: Math.round((acc.variance + d.variance) * 100) / 100,
    }),
    { expected: 0, collected: 0, variance: 0 },
  );
  return { days, unsettled, totals };
}

// ── Rider WhatsApp confirmation ──────────────────────────────────────────────

export const RIDER_CONFIRM_RE = /^\s*RIDER_CONFIRM\s+([A-Za-z0-9-]+)(?:\s+(\d+(?:\.\d{1,2})?))?\s*$/i;

/** Rider phone numbers for a tenant come from settings.codRiderPhones. */
export function riderPhonesFromSettings(settings: unknown): string[] {
  const v = (settings as any)?.codRiderPhones;
  return Array.isArray(v) ? v.filter((p) => typeof p === "string" && p.trim()).map((p) => p.trim()) : [];
}

export interface RiderConfirmOutcome {
  handled: boolean;
  reply?: string;
  result?: ConfirmCollectionResult;
}

/**
 * WhatsApp reply flow for riders: "RIDER_CONFIRM <orderNumber> [amount]".
 * Only registered rider phones (tenant settings.codRiderPhones) are handled;
 * anything else falls through to the normal pipeline. Confirms the FULL
 * remaining balance when no amount is given.
 */
export async function handleRiderConfirm(opts: {
  db: DbHandle;
  tenantId: string;
  waPhoneNumber: string;
  text: string;
  tenantSettings?: unknown;
  sendText?: (tenantId: string, to: string, body: string) => Promise<unknown>;
}): Promise<RiderConfirmOutcome> {
  const m = RIDER_CONFIRM_RE.exec(opts.text ?? "");
  if (!m) return { handled: false };
  let settings = opts.tenantSettings;
  if (settings === undefined) {
    const [t] = await opts.db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, opts.tenantId))
      .limit(1)
      .catch(() => [] as any[]);
    settings = t?.settings ?? null;
  }
  const riders = riderPhonesFromSettings(settings);
  if (!riders.includes(opts.waPhoneNumber)) return { handled: false };

  const send =
    opts.sendText ??
    (async (tenantId: string, to: string, body: string) => {
      const { sendWhatsAppText } = await import("./waSender");
      return sendWhatsAppText(tenantId, to, body);
    });

  const orderNumber = m[1].toUpperCase();
  const [order] = await opts.db
    .select()
    .from(orders)
    .where(and(eq(orders.tenantId, opts.tenantId), eq(orders.orderNumber, orderNumber)))
    .limit(1);
  if (!order) {
    await send(opts.tenantId, opts.waPhoneNumber, `❌ Order ${orderNumber} not found.`);
    return { handled: true };
  }

  const summary = await orderPaymentSummary(opts.db, opts.tenantId, order.id);
  const amount = m[2] ? Number(m[2]) : summary.remaining;
  if (amount <= 0) {
    // Nothing left to collect (fully confirmed already / replayed reply).
    const reply = `ℹ️ ${orderNumber} collection already recorded (no double entry). State: ${order.codState}.`;
    await send(opts.tenantId, opts.waPhoneNumber, reply);
    return { handled: true, reply };
  }
  try {
    const result = await confirmCashCollection(opts.db, {
      tenantId: opts.tenantId,
      orderId: order.id,
      amount,
      actor: `rider:${opts.waPhoneNumber}`,
    });
    const state = result.codState ?? order.codState;
    const reply = result.applied
      ? result.summary.remaining > 0
        ? `✅ Recorded ${amount.toFixed(2)} for ${orderNumber}. Remaining balance: ${result.summary.remaining.toFixed(2)}.`
        : `✅ Cash for ${orderNumber} fully collected (${result.summary.totalPaid.toFixed(2)}). State: ${state}.`
      : `ℹ️ ${orderNumber} collection already recorded (no double entry). State: ${state}.`;
    await send(opts.tenantId, opts.waPhoneNumber, reply);
    return { handled: true, reply, result };
  } catch (e: any) {
    const reply = `❌ Could not confirm ${orderNumber}: ${e?.message ?? e}`;
    await send(opts.tenantId, opts.waPhoneNumber, reply);
    return { handled: true, reply };
  }
}
