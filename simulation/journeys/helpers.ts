/**
 * journeys/helpers.ts — shared building blocks for the standard NLP chat
 * ordering pipeline (scripted LLM → cart → confirm → fulfillment → order).
 */
import crypto from "crypto";
import {
  ADMIN_PHONE,
  TENANT_ID,
  assert,
  bodyText,
  latestOrderForPhone,
  type World,
} from "../world";

export interface ChatItem {
  product: string;
  quantity: number;
}

export interface ChatOrderOutcome {
  orderId: string;
  orderNumber: string;
  total: number;
  paymentUrl: string | null;
  paymentRef: string | null;
  /** The order-summary text delivered to the buyer. */
  summaryText: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Script the LLM to add items to cart, then send the message. */
export async function nlpAddToCart(world: World, phone: string, text: string, items: ChatItem[]): Promise<void> {
  world.llm.when(text, {
    reply: "Added to your cart!",
    intent: "add_to_cart",
    nextState: "add_to_cart",
    extractedItems: items,
    extractedProduct: null,
    extractedQuantity: null,
    extractedAddress: null,
    confidence: 0.95,
  });
  await world.text(phone, text);
}

/** Script a confirm_order intent and send it (promo codes ride along in text). */
export async function nlpConfirm(world: World, phone: string, text = "confirm my order"): Promise<void> {
  world.llm.when(text, {
    reply: "Let me confirm that.",
    intent: "confirm_order",
    nextState: "checkout_confirm",
    extractedItems: [],
    extractedProduct: null,
    extractedQuantity: null,
    extractedAddress: null,
    confidence: 0.95,
  });
  await world.text(phone, text);
}

/**
 * Full happy-path chat order: add items → confirm → pickup.
 * Returns the created order + payment details. Asserts nothing.
 */
export async function createChatOrderViaNlp(
  world: World,
  phone: string,
  opts: {
    items: ChatItem[];
    addText?: string;
    confirmText?: string;
    fulfillment?: "pickup" | "delivery";
    address?: string;
  },
): Promise<ChatOrderOutcome> {
  const tag = crypto.randomUUID().slice(0, 8);
  await nlpAddToCart(world, phone, `${opts.addText ?? "i want these"} [${tag}]`, opts.items);
  await nlpConfirm(world, phone, `${opts.confirmText ?? "confirm please"} [${tag}]`);
  await sleep(5); // order numbers are Date.now()-based — avoid same-ms collisions

  const fulfillment = opts.fulfillment ?? "pickup";
  await world.text(phone, fulfillment === "pickup" ? "1" : "2");
  if (fulfillment === "delivery" && opts.address) {
    await world.text(phone, opts.address);
  }

  const order = await latestOrderForPhone(world, phone);
  assert(order, `chat order was created for ${phone}`);
  const schema = await import("../../drizzle/schema");
  const { eq, desc } = await import("drizzle-orm");
  const [tx] = await world.db
    .select()
    .from(schema.paymentTransactions)
    .where(eq(schema.paymentTransactions.orderId, order.id))
    .orderBy(desc(schema.paymentTransactions.createdAt))
    .limit(1);
  const summary = bodyText(world.outbound.lastOfType("text", phone));
  return {
    orderId: order.id,
    orderNumber: order.orderNumber,
    total: Number(order.totalAmount),
    paymentUrl: tx?.paymentUrl ?? null,
    paymentRef: tx?.providerRef ?? null,
    summaryText: summary,
  };
}

/** Drive the REAL paystack webhook for a payment reference. */
export async function paystackChargeSuccess(
  world: World,
  opts: { reference: string; amountMajor: number; currency?: string },
): Promise<any> {
  const raw = JSON.stringify({
    event: "charge.success",
    data: {
      reference: opts.reference,
      amount: Math.round(opts.amountMajor * 100),
      currency: opts.currency ?? "NGN",
      status: "success",
    },
  });
  const sig = crypto.createHmac("sha512", process.env.PAYSTACK_WEBHOOK_SECRET ?? "").update(raw).digest("hex");
  const res = await fetch(`${world.baseUrl}/api/webhooks/paystack`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-paystack-signature": sig },
    body: raw,
  });
  const json = await res.json().catch(() => null);
  await world.settle(400);
  return { status: res.status, json };
}

/** Admin-scoped tRPC caller (protectedProcedure routes). */
export async function adminCaller() {
  const { appRouter } = await import("../../server/routers");
  return appRouter.createCaller({
    user: {
      id: 1,
      openId: "sim-admin",
      email: "admin@sim.local",
      name: "Sim Admin",
      loginMethod: "keycloak",
      role: "admin",
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSignedIn: new Date(),
    },
    req: { protocol: "http", headers: {} },
    res: { clearCookie: () => {} },
  } as any);
}

export { ADMIN_PHONE, TENANT_ID };

// ── Wave 8: B2B procurement + trade credit ──────────────────────────────────

import {
  CREDIT_ACCOUNT_ID,
  SUPPLIER_TENANT_ID,
} from "../world";

/** Enable the "Restock / Buy supplies" menu entry; returns the previous waMenu for restore. */
export async function enableProcurementMenu(world: World): Promise<any> {
  const { DEFAULT_WA_MENU } = await import("../../shared/waMenu");
  const before = (await world.tenantSettings()).waMenu ?? null;
  await world.patchTenantSettings({
    waMenu: {
      ...DEFAULT_WA_MENU,
      useCases: DEFAULT_WA_MENU.useCases.map((u) =>
        u.id === "procurement" ? { ...u, enabled: true } : u,
      ),
    },
  });
  return before;
}

/** Restore a waMenu snapshot returned by enableProcurementMenu (full settings replace). */
export async function restoreMenu(world: World, before: any): Promise<void> {
  const schema = await import("../../drizzle/schema");
  const { eq } = await import("drizzle-orm");
  const current = await world.tenantSettings();
  if (before) current.waMenu = before;
  else delete current.waMenu;
  await world.db
    .update(schema.tenants)
    .set({ settings: current, updatedAt: new Date() })
    .where(eq(schema.tenants.id, TENANT_ID));
}

export interface ProcurementPoOutcome {
  poId: string;
  poNumber: string;
  subtotalCents: number;
  paymentMode: "credit" | "paynow";
  termsDays: number | null;
}

/**
 * Parse a rendered wholesale catalog into name → item number (the local
 * catalog has no ORDER BY, so numbering must be read from the reply).
 */
export function catalogItemNumbers(catalogText: string): Map<string, number> {
  const map = new Map<string, number>();
  for (const line of catalogText.split("\n")) {
    const m = /^(\d+)\.\s+(.+?)\s+—\s+₦/.exec(line.trim());
    if (m) map.set(m[2], parseInt(m[1], 10));
  }
  return map;
}

/**
 * Drive the full buyer-side procurement chat against the seeded supplier:
 *   menu → procurement entry → browse suppliers → pick supplier 1 →
 *   add 100× preforms + 10× crates → done → payment choice → CONFIRM.
 * Subtotal: 100×₦40 + 10×₦2,500 = ₦29,000 (2_900_000¢). Asserts the PO row
 * exists with status 'submitted'; returns it.
 */
export async function buildProcurementPoViaChat(
  world: World,
  phone: string,
  opts: { paymentMode: "credit" | "paynow"; termsPick?: number } = { paymentMode: "credit" },
): Promise<ProcurementPoOutcome> {
  await world.text(phone, "menu");
  await world.text(phone, "4"); // procurement menu entry
  await world.text(phone, "1"); // browse suppliers
  await world.text(phone, "1"); // Lagos Plastics Manufacturing
  const catalogText = bodyText(world.outbound.lastOfType("text", phone));
  const numbers = catalogItemNumbers(catalogText);
  const preformsNo = numbers.get("PET Preforms 500ml");
  const cratesNo = numbers.get("Plastic Crates 20L");
  assert(preformsNo && cratesNo, `catalog lists both seeded items (got ${catalogText.slice(0, 200)})`);
  await world.text(phone, `add ${preformsNo} 100`); // 100 × PET Preforms @ ₦40 = ₦4,000
  await world.text(phone, `add ${cratesNo} 10`); // 10 × Plastic Crates @ ₦2,500 = ₦25,000
  await world.text(phone, "done");
  if (opts.paymentMode === "credit") {
    await world.text(phone, "1"); // pay on credit
    await world.text(phone, String(opts.termsPick ?? 2)); // net 14 (termsOffered [7,14,30])
  } else {
    await world.text(phone, "2"); // pay now
  }
  await world.text(phone, "CONFIRM");

  const schema = await import("../../drizzle/schema");
  const { eq, desc } = await import("drizzle-orm");
  const [po] = await world.db
    .select()
    .from(schema.purchaseOrders)
    .where(eq(schema.purchaseOrders.buyerTenantId, TENANT_ID))
    .orderBy(desc(schema.purchaseOrders.createdAt))
    .limit(1);
  assert(po, "procurement PO row was created");
  assert(po.status === "submitted", `PO submitted (got ${po.status})`);
  return {
    poId: po.id,
    poNumber: po.poNumber,
    subtotalCents: Number(po.subtotalCents),
    paymentMode: po.paymentMode,
    termsDays: po.termsDays,
  };
}

/** Fetch the seeded credit account row (supplier ↔ sim tenant). */
export async function creditAccount(world: World) {
  const schema = await import("../../drizzle/schema");
  const { eq } = await import("drizzle-orm");
  const [row] = await world.db
    .select()
    .from(schema.creditAccounts)
    .where(eq(schema.creditAccounts.id, CREDIT_ACCOUNT_ID))
    .limit(1);
  assert(row, "seeded credit account exists");
  return row;
}

/** Ledger rows for the seeded credit account, newest first. */
export async function creditLedgerRows(world: World, kind?: string) {
  const schema = await import("../../drizzle/schema");
  const { eq, and, desc } = await import("drizzle-orm");
  return world.db
    .select()
    .from(schema.creditLedger)
    .where(
      kind
        ? and(eq(schema.creditLedger.creditAccountId, CREDIT_ACCOUNT_ID), eq(schema.creditLedger.kind, kind))
        : eq(schema.creditLedger.creditAccountId, CREDIT_ACCOUNT_ID),
    )
    .orderBy(desc(schema.creditLedger.createdAt));
}

export { SUPPLIER_TENANT_ID, CREDIT_ACCOUNT_ID };

// ── Wave 9: agentic onboarding copilot helpers ───────────────────────────────
// Journeys drive the REAL copilot module (server/services/onboardingCopilot)
// — the LLM is scripted by metaMock's copilot tool-call handler, so the full
// intake → propose → approve → configure → validate → live pipeline executes.

export interface OnboardingProposalRef {
  id: string;
  kind: string;
  status: string;
  summary: string;
  payload: any;
}

/** Active (non-terminal) whatsapp onboarding session for a phone, or null. */
export async function onboardingSessionByPhone(phone: string) {
  const copilot = await import("../../server/services/onboardingCopilot");
  return copilot.findActiveSessionByPhone(phone);
}

/** Load an onboarding session by id (any state, any channel). */
export async function onboardingSessionById(sessionId: string) {
  const copilot = await import("../../server/services/onboardingCopilot");
  return copilot.getSession(sessionId);
}

/**
 * Tap the onb_approve button of every pending proposal (optionally filtered
 * by kind). Reloads the session between taps so config-phase side effects
 * (tenant creation, goLive proposal) are observed by the caller afterwards.
 */
export async function approvePendingViaButtons(world: World, phone: string, kinds?: string[]): Promise<string[]> {
  const session = await onboardingSessionByPhone(phone);
  assert(session, "active onboarding session exists for approval taps");
  const approved: string[] = [];
  for (const p of session!.proposals as OnboardingProposalRef[]) {
    if (p.status !== "pending") continue;
    if (kinds && !kinds.includes(p.kind)) continue;
    await world.onboardingButtonReply(phone, `onb_approve:${p.id}`, "Approve");
    approved.push(p.id);
  }
  return approved;
}

/** Raw tenant row (settings included) for DB-state assertions. */
export async function tenantRowById(world: World, tenantId: string) {
  const schema = await import("../../drizzle/schema");
  const { eq } = await import("drizzle-orm");
  const [row] = await world.db.select().from(schema.tenants).where(eq(schema.tenants.id, tenantId)).limit(1);
  return row ?? null;
}

/** All recorded Graph calls whose URL path ends with the given suffix. */
export function graphCallsTo(world: World, suffix: string) {
  return world.outbound.all().filter((c) => new URL(c.url).pathname.endsWith(suffix));
}
