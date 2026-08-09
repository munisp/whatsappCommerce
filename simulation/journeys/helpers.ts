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
