// === W65 conversational ===
/**
 * commandBar.ts — R7 universal natural-language command bar.
 *
 * Maps natural language ("create invoice for Musa ₦45,000 due Friday") to a
 * DRAFT of an existing tRPC mutation, returns a one-shot confirmToken, and —
 * only after the user confirms — executes the REAL mutation server-side via
 * appRouter.createCaller (never reimplements business logic).
 *
 * Design rules:
 * - Parsing is deterministic regex/keyword first, invokeLLM (Ollama-first
 *   gateway; sim mocks llm.sim.local) second, "unknown" last. Never throws
 *   for parse reasons (fail-open telemetry); execution failures propagate as
 *   tRPC errors from the real procedure (fail-closed money).
 * - Confirm tokens live in Redis (putJson/takeJson, production fail-closed,
 *   dev in-memory) and are one-shot: execute consumes the token so a double
 *   confirm cannot run a mutation twice.
 * - Admin-only intents are enforced BOTH at parse (listed but flagged) and at
 *   execute (role re-checked against the registry) — the token is not a
 *   capability.
 */
import { randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { invokeLLM } from "../_core/llm";
import { captureException } from "./observability";
import { putJson, takeJson } from "./persistedState";

export const COMMAND_BAR_DRAFT_TTL_MS = 10 * 60_000;

// ─── Intent registry ─────────────────────────────────────────────────────────

export interface CommandParams {
  [k: string]: unknown;
}

interface IntentDef {
  intent: CommandIntent;
  /** Admin-only intents are gated by role at execute time. */
  adminOnly?: boolean;
  /** Human summary template + LLM prompt hints. */
  hint: string;
  /** Param keys that MUST be present before execution is allowed. */
  required: string[];
  /** Build the real mutation input; may do read-only lookups. */
  toInput(params: CommandParams, ctxUser: CallerUser): Promise<{ path: string; input: Record<string, unknown> }>;
  /** Short human summary of the drafted action (card title). */
  describe(params: CommandParams): string;
}

export const COMMAND_INTENTS = [
  "create_invoice",
  "create_product",
  "restock_po",
  "wallet_balance",
  "payout_withdraw",
  "suspend_merchant",
  "unsuspend_merchant",
  "retry_dlq",
  "order_status",
  "dispute_open",
  "statement_request",
  "unknown",
] as const;
export type CommandIntent = (typeof COMMAND_INTENTS)[number];

export interface CallerUser {
  id: number | string;
  role: string;
  tenantId?: string | null;
}

/** Parse "₦45,000" / "45000 naira" / "45k" → major-unit number. */
export function parseAmount(text: string): number | null {
  const m = /(?:₦|NGN|naira|N)?\s*(\d[\d,]*(?:\.\d+)?)\s*(k|m)?\b/i.exec(text);
  if (!m) return null;
  let v = Number(m[1].replace(/,/g, ""));
  if (!Number.isFinite(v) || v <= 0) return null;
  const suffix = (m[2] ?? "").toLowerCase();
  if (suffix === "k") v *= 1_000;
  if (suffix === "m") v *= 1_000_000;
  return v;
}

/** First quoted "…" or '…' span, else "for NAME" / "called NAME" tail. */
export function parseName(text: string): string | null {
  const q = /["'`]([^"'`]{2,120})["'`]/.exec(text);
  if (q) return q[1].trim();
  const f = /\b(?:for|called|named|to)\s+([A-Z][A-Za-z0-9'& .-]{1,80}?)(?:\s+(?:₦|NGN|\d|due|on|for)\b|[,.!]|$)/.exec(text);
  return f ? f[1].trim() : null;
}

/** Order id / number tokens: SIM-1234, #1234, ORD-…, o-… */
export function parseOrderRef(text: string): string | null {
  const m = /\b(?:order\s*)?(#?[A-Za-z]{0,4}-?[0-9][A-Za-z0-9-]{2,})\b/i.exec(text);
  return m ? m[1].replace(/^#/, "") : null;
}

function asStr(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}
/** Effective tenant for tenant-scoped intents: the caller's own tenant, or an
 * explicit tenantId param (platform admins are tenant-less by design). The
 * target procedure re-asserts access either way. */
function tenantOf(p: CommandParams, user: CallerUser): string {
  const tid = user.tenantId ?? asStr(p.tenantId);
  if (!tid) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "No tenant context for this command" });
  }
  return tid;
}

function asNum(v: unknown): number | undefined {
  const n = typeof v === "string" ? Number(v.replace(/[,₦\s]/g, "")) : Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

const REGISTRY: Record<Exclude<CommandIntent, "unknown">, IntentDef> = {
  create_invoice: {
    intent: "create_invoice",
    hint: "Create an AR invoice for a customer (name, amount, optional due date).",
    required: ["amount"],
    describe: (p) => `Create invoice${p.customerName ? ` for ${p.customerName}` : ""} — ${p.amount} ${p.currency ?? "NGN"}`,
    toInput: async (p, user) => ({
      path: "arInvoices.create",
      input: {
        tenantId: tenantOf(p, user),
        customerName: asStr(p.customerName),
        description: asStr(p.description),
        amountCents: Math.round(asNum(p.amount)! * 100),
        currency: asStr(p.currency) ?? "NGN",
      },
    }),
  },
  create_product: {
    intent: "create_product",
    hint: "Add a product to the catalog (name, optional price, stock).",
    required: ["name"],
    describe: (p) => `Create product "${p.name}"${p.price ? ` — ${p.price} ${p.currency ?? "NGN"}` : ""}`,
    toInput: async (p, user) => ({
      path: "product.create",
      input: {
        tenantId: tenantOf(p, user),
        sku: asStr(p.sku) ?? `CMD-${randomUUID().slice(0, 8).toUpperCase()}`,
        name: asStr(p.name)!,
        description: asStr(p.description),
        price: String(asNum(p.price) ?? 0),
        currency: asStr(p.currency) ?? "NGN",
        stockQuantity: Number.isFinite(Number(p.stock)) ? Math.max(0, Math.floor(Number(p.stock))) : 0,
      },
    }),
  },
  restock_po: {
    intent: "restock_po",
    hint: "Draft a restock purchase order to a supplier (supplierTenantId, product, quantity).",
    required: ["supplierTenantId", "product", "quantity"],
    describe: (p) => `Draft PO to supplier ${p.supplierTenantId}: ${p.quantity}× ${p.product}`,
    toInput: async (p, user) => ({
      path: "procurement.createPo",
      input: {
        buyerTenantId: tenantOf(p, user),
        supplierTenantId: asStr(p.supplierTenantId)!,
        paymentMode: "paynow",
        notes: asStr(p.notes) ?? "Drafted via command bar",
        lines: [{
          name: asStr(p.product)!,
          qty: Math.max(1, Math.floor(asNum(p.quantity)!)),
          unitPriceCents: Math.round((asNum(p.unitPrice) ?? 0) * 100),
        }],
      },
    }),
  },
  wallet_balance: {
    intent: "wallet_balance",
    hint: "Show the merchant wallet balance.",
    required: [],
    describe: () => "Show wallet balance",
    toInput: async (_p, user) => ({ path: "wallet.getBalance", input: { tenantId: tenantOf(_p, user) } }),
  },
  payout_withdraw: {
    intent: "payout_withdraw",
    hint: "Withdraw wallet funds to the primary payout account (amount).",
    required: ["amount"],
    describe: (p) => `Withdraw ${p.amount} ${p.currency ?? "NGN"} to your payout account`,
    toInput: async (p, user) => ({
      path: "wallet.requestWithdrawal",
      input: {
        tenantId: tenantOf(p, user),
        amount: asNum(p.amount)!,
        // Idempotency: the command-bar confirm token doubles as the withdrawal
        // reference so a retried confirm replays into the existing row.
        reference: asStr(p.reference),
        payoutAccountId: asStr(p.payoutAccountId),
      },
    }),
  },
  suspend_merchant: {
    intent: "suspend_merchant",
    adminOnly: true,
    hint: "Suspend a merchant tenant (admin; tenant id).",
    required: ["merchantId"],
    describe: (p) => `Suspend merchant ${p.merchantId}`,
    toInput: async (p) => ({ path: "tenant.update", input: { id: asStr(p.merchantId)!, status: "suspended" } }),
  },
  unsuspend_merchant: {
    intent: "unsuspend_merchant",
    adminOnly: true,
    hint: "Reactivate a suspended merchant tenant (admin; tenant id).",
    required: ["merchantId"],
    describe: (p) => `Reactivate merchant ${p.merchantId}`,
    toInput: async (p) => ({ path: "tenant.update", input: { id: asStr(p.merchantId)!, status: "active" } }),
  },
  retry_dlq: {
    intent: "retry_dlq",
    adminOnly: true,
    hint: "Retry a dead-lettered webhook event (admin; event id).",
    required: ["eventId"],
    describe: (p) => `Retry dead-letter event ${p.eventId}`,
    toInput: async (p) => ({ path: "webhookDlq.retryEvent", input: { id: asStr(p.eventId)! } }),
  },
  order_status: {
    intent: "order_status",
    hint: "Look up an order's status (order id).",
    required: ["orderId"],
    describe: (p) => `Look up order ${p.orderId}`,
    toInput: async (p) => ({ path: "orderCrud.get", input: { orderId: asStr(p.orderId)! } }),
  },
  dispute_open: {
    intent: "dispute_open",
    hint: "Open a dispute on an order (order id, reason).",
    required: ["orderId"],
    describe: (p) => `Open dispute on order ${p.orderId}${p.reason ? ` (${p.reason})` : ""}`,
    toInput: async (p, user) => {
      // Resolve the escrow transaction for this order (read-only) so the REAL
      // escrowDispute.raise mutation can be called with its required input.
      const { getDb } = await import("../db");
      const { escrowTransactions } = await import("../../drizzle/schema");
      const { eq, and, desc } = await import("drizzle-orm");
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const [escrow] = await db
        .select({ id: escrowTransactions.id })
        .from(escrowTransactions)
        .where(and(eq(escrowTransactions.orderId, asStr(p.orderId)!), eq(escrowTransactions.tenantId, tenantOf(p, user))))
        .orderBy(desc(escrowTransactions.createdAt))
        .limit(1)
        .catch(() => [] as any[]);
      if (!escrow) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "No escrow transaction found for that order" });
      }
      const reason = asStr(p.reason);
      return {
        path: "escrowDispute.raise",
        input: {
          escrowTxId: escrow.id,
          orderId: asStr(p.orderId)!,
          tenantId: tenantOf(p, user),
          raisedBy: "merchant",
          reason: (["not_received", "wrong_item", "damaged", "partial_delivery", "other"].includes(reason ?? "")
            ? reason : "other") as "other",
          description: asStr(p.description) ?? "Opened via command bar",
        },
      };
    },
  },
  statement_request: {
    intent: "statement_request",
    hint: "Generate a wallet statement for a month (YYYY-MM).",
    required: [],
    describe: (p) => `Generate wallet statement${p.month ? ` for ${p.month}` : ""}`,
    toInput: async (p, user) => ({
      path: "walletStatements.generateStatement",
      input: { tenantId: tenantOf(p, user), month: asStr(p.month) },
    }),
  },
};

// ─── Deterministic parse ─────────────────────────────────────────────────────

interface KeywordRule {
  intent: Exclude<CommandIntent, "unknown">;
  re: RegExp;
  extract?: (text: string, params: CommandParams) => void;
}

const RULES: KeywordRule[] = [
  { intent: "create_invoice", re: /\b(invoice|bill)\b/i, extract: (t, p) => {
    p.amount = parseAmount(t) ?? undefined;
    p.customerName = parseName(t) ?? undefined;
    const month = /\b(20\d{2}-\d{2})\b/.exec(t); if (month) p.dueMonth = month[1];
  } },
  { intent: "create_product", re: /\b(create|add|new)\s+(a\s+)?product\b/i, extract: (t, p) => {
    p.name = parseName(t) ?? undefined;
    p.price = parseAmount(t) ?? undefined;
    const stock = /\b(\d+)\s*(?:units?|in stock|pcs)\b/i.exec(t); if (stock) p.stock = Number(stock[1]);
  } },
  { intent: "restock_po", re: /\b(restock|purchase order|\bPO\b|reorder stock)\b/i, extract: (t, p) => {
    p.product = parseName(t) ?? undefined;
    const qty = /\b(\d+)\s*(?:units?|pcs|x)\b/i.exec(t); if (qty) p.quantity = Number(qty[1]);
    const sup = /\bsupplier\s+([A-Za-z0-9-]{4,})/i.exec(t); if (sup) p.supplierTenantId = sup[1];
  } },
  { intent: "wallet_balance", re: /\b(wallet|balance)\b/i },
  { intent: "payout_withdraw", re: /\b(withdraw|payout|cash out)\b/i, extract: (t, p) => {
    p.amount = parseAmount(t) ?? undefined;
  } },
  { intent: "suspend_merchant", re: /\bsuspend\b.*\b(merchant|tenant)\b|\bsuspend\b\s+[A-Za-z0-9-]{6,}/i, extract: (t, p) => {
    const m = /\b(?:merchant|tenant)\s+([A-Za-z0-9][A-Za-z0-9-]{4,})/i.exec(t)
      ?? /\bsuspend\s+(?:the\s+)?([A-Za-z0-9][A-Za-z0-9-]{4,})/i.exec(t);
    if (m) p.merchantId = m[1];
  } },
  { intent: "unsuspend_merchant", re: /\b(unsuspend|reactivate|reinstate)\b/i, extract: (t, p) => {
    const m = /\b(?:merchant|tenant)\s+([A-Za-z0-9][A-Za-z0-9-]{4,})/i.exec(t)
      ?? /\b(?:unsuspend|reactivate|reinstate)\s+(?:the\s+)?([A-Za-z0-9][A-Za-z0-9-]{4,})/i.exec(t);
    if (m) p.merchantId = m[1];
  } },
  { intent: "retry_dlq", re: /\b(retry|drain|reprocess)\b.*\b(dlq|dead.?letter)\b|\bdlq\b/i, extract: (t, p) => {
    const m = /\bevent\s+([A-Za-z0-9][A-Za-z0-9-]{4,})/i.exec(t)
      ?? /\b(?:dlq|retry|dead.?letter)\s+([A-Za-z0-9][A-Za-z0-9-]{4,})/i.exec(t);
    if (m) p.eventId = m[1];
  } },
  { intent: "order_status", re: /\border\s*(status)?\b.*(#?[A-Za-z0-9-]{4,})|\bstatus of\b/i, extract: (t, p) => {
    p.orderId = parseOrderRef(t) ?? undefined;
  } },
  { intent: "dispute_open", re: /\b(dispute|complaint|report)\b/i, extract: (t, p) => {
    p.orderId = parseOrderRef(t) ?? undefined;
    p.reason = /\bnot received|never arrived\b/i.test(t) ? "not_received"
      : /\bwrong item\b/i.test(t) ? "wrong_item"
      : /\bdamaged\b/i.test(t) ? "damaged"
      : /\bpartial\b/i.test(t) ? "partial_delivery" : undefined;
  } },
  { intent: "statement_request", re: /\b(statement|account statement)\b/i, extract: (t, p) => {
    const month = /\b(20\d{2}-\d{2})\b/.exec(t); if (month) p.month = month[1];
  } },
];

// ─── LLM-assisted parse (fallback) ──────────────────────────────────────────

const PARSE_PROMPT = `You map a merchant/admin command to ONE intent with JSON params.
Intents:
- create_invoice {customerName?, amount, currency?}
- create_product {name, price?, currency?, stock?}
- restock_po {supplierTenantId, product, quantity, unitPrice?}
- wallet_balance {}
- payout_withdraw {amount, currency?}
- suspend_merchant {merchantId} (admin)
- unsuspend_merchant {merchantId} (admin)
- retry_dlq {eventId} (admin)
- order_status {orderId}
- dispute_open {orderId, reason?}
- statement_request {month? YYYY-MM}
- unknown {}
Reply with ONLY a JSON object: {"intent": "...", "params": {...}}. Amounts in major units as numbers.`;

async function llmParse(text: string): Promise<{ intent: CommandIntent; params: CommandParams } | null> {
  try {
    const res = await invokeLLM({
      messages: [
        { role: "system", content: PARSE_PROMPT },
        { role: "user", content: text },
      ],
    });
    const raw = res?.choices?.[0]?.message?.content;
    const content = typeof raw === "string" ? raw : "";
    const m = /\{[\s\S]*\}/.exec(content);
    if (!m) return null;
    const parsed = JSON.parse(m[0]) as { intent?: string; params?: CommandParams };
    if (!parsed.intent || !(COMMAND_INTENTS as readonly string[]).includes(parsed.intent)) return null;
    if (parsed.intent === "unknown") return { intent: "unknown", params: {} };
    return { intent: parsed.intent as CommandIntent, params: parsed.params ?? {} };
  } catch (e) {
    // Fail-open telemetry: LLM outages degrade the bar to keyword matching.
    captureException(e, { service: "commandBar", operation: "llmParse" });
    return null;
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

export interface ParsedCommand {
  intent: CommandIntent;
  params: CommandParams;
  missingFields: string[];
  summary: string;
  adminOnly: boolean;
  confirmToken: string | null;
}

export async function parseCommand(text: string, user: CallerUser): Promise<ParsedCommand> {
  const trimmed = text.trim().slice(0, 1000);
  let intent: CommandIntent = "unknown";
  let params: CommandParams = {};

  for (const rule of RULES) {
    if (!rule.re.test(trimmed)) continue;
    intent = rule.intent;
    rule.extract?.(trimmed, params);
    break;
  }
  if (intent === "unknown") {
    const llm = await llmParse(trimmed);
    if (llm) {
      intent = llm.intent;
      params = llm.params ?? {};
    }
  }
  if (intent === "unknown") {
    return { intent, params: {}, missingFields: [], summary: "I couldn't map that to a command.", adminOnly: false, confirmToken: null };
  }

  const def = REGISTRY[intent];
  // Strip undefined values so missing-field detection is honest.
  for (const k of Object.keys(params)) if (params[k] === undefined || params[k] === null || params[k] === "") delete params[k];
  const missingFields = def.required.filter((k) => params[k] === undefined);
  const summary = def.describe(params);

  // Drafts with missing fields still get a token so the UI can collect the
  // fields and confirm; execute re-checks required fields.
  const confirmToken = randomUUID();
  await putJson(`cmdbar:draft:${confirmToken}`, {
    intent, params, userId: String(user.id), tenantId: user.tenantId ?? null,
  }, COMMAND_BAR_DRAFT_TTL_MS, { label: "commandBar.draft" });

  return { intent, params, missingFields, summary, adminOnly: !!def.adminOnly, confirmToken };
}

export interface ExecutedCommand {
  intent: CommandIntent;
  summary: string;
  result: unknown;
}

/**
 * Consume a one-shot confirm token and run the REAL tRPC mutation as the
 * confirming user. The token only carries the DRAFT; all authz (tenant
 * access, role, step-up, KYB) is enforced again by the target procedure.
 */
export async function executeCommand(
  confirmToken: string,
  extraParams: CommandParams | undefined,
  ctx: Record<string, unknown> & { user: CallerUser },
): Promise<ExecutedCommand> {
  const draft = await takeJson<{
    intent: Exclude<CommandIntent, "unknown">;
    params: CommandParams;
    userId: string;
    tenantId: string | null;
  }>(`cmdbar:draft:${confirmToken}`, { label: "commandBar.execute" });
  if (!draft) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Command draft expired or already executed" });
  }
  // Token is bound to the drafter — a stolen token must not execute as them.
  if (draft.userId !== String(ctx.user.id)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "This command draft belongs to another user" });
  }
  const def = REGISTRY[draft.intent];
  if (def.adminOnly && ctx.user.role !== "admin") {
    throw new TRPCError({ code: "FORBIDDEN", message: "Admin access required" });
  }
  const params = { ...draft.params, ...(extraParams ?? {}) };
  const missingFields = def.required.filter((k) => params[k] === undefined || params[k] === null || params[k] === "");
  if (missingFields.length > 0) {
    // Restore the draft so the UI can collect the fields and retry — the
    // token is only consumed by a real execution attempt.
    await putJson(`cmdbar:draft:${confirmToken}`, draft, COMMAND_BAR_DRAFT_TTL_MS, { label: "commandBar.draft" });
    throw new TRPCError({ code: "BAD_REQUEST", message: `Missing required fields: ${missingFields.join(", ")}` });
  }
  const { path, input } = await def.toInput(params, ctx.user);
  const { appRouter } = await import("../routers");
  const caller = appRouter.createCaller(ctx as any);
  const [routerName, proc] = path.split(".");
  const target = (caller as any)?.[routerName]?.[proc];
  if (typeof target !== "function") {
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Command target ${path} unavailable` });
  }
  const result = await target(input);
  return { intent: draft.intent, summary: def.describe(params), result };
}

/** Registry introspection for the UI hint list + tests. */
export function listCommandIntents(): { intent: CommandIntent; adminOnly: boolean; hint: string; required: string[] }[] {
  return Object.values(REGISTRY).map((d) => ({
    intent: d.intent, adminOnly: !!d.adminOnly, hint: d.hint, required: d.required,
  }));
}
