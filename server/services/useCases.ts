/**
 * useCases.ts — Conversational use-case registry + inbound dispatcher.
 *
 * Implements the five built-in menu use cases (see services/waMenu.ts for the
 * shared settings.waMenu contract):
 *
 *   shop    → hands the conversation to the existing NLP ordering pipeline
 *   track   → lists the caller's recent orders with status + /track/:token links
 *   support → captures a free-text issue (channel_messages) + notifies admin
 *   booking → slot-fills service + datetime into the appointments table
 *   handoff → flags the conversation for a human agent + notifies admin
 *
 * Also owns the two channel orchestrators that drive the menu/session engine:
 *   handleConversationalInbound — WhatsApp text path (consent → menu → use case)
 *   handleUssdRequest           — Africa's Talking USSD path (CON/END)
 */

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "../db";
import {
  appointments,
  channelMessages,
  conversations,
  customers,
  logisticsShipments,
  orders,
  serviceCatalog,
  tenants,
  type Order,
} from "../../drizzle/schema";
import { sendWhatsAppText } from "./waSender";
import { trackingUrlFor } from "./trackingToken";
import {
  isMenuKeyword,
  loadMenuConfig,
  renderUssdMenu,
  renderWhatsAppMenu,
  resolveMenuSelection,
  ussdWrap,
  type MenuEntry,
  type UseCaseId,
  type WaMenuConfig,
} from "./waMenu";
import {
  clearSession,
  getSession,
  newSession,
  saveSession,
  type ChatSession,
} from "./chatSession";
import {
  CONSENT_DENIED_REPLY,
  CONSENT_GRANTED_REPLY,
  CONSENT_PROMPT,
  getConsent,
  parseConsentReply,
  recordConsent,
} from "./consent";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export interface UseCaseContext {
  db: Db;
  tenantId: string;
  phone: string;
  customerName?: string;
  tenantSettings?: Record<string, unknown> | null;
  businessName?: string;
}

export interface UseCaseOutcome {
  reply: string;
  /** Partial session to persist; null ends the flow (session cleared). */
  nextState: Partial<ChatSession> | null;
}

export type UseCaseHandler = (
  ctx: UseCaseContext,
  session: ChatSession,
  input: string,
) => Promise<UseCaseOutcome>;

// ── Shared helpers ───────────────────────────────────────────────────────────

/** Terminal order statuses — anything else counts as an "open" order. */
const CLOSED_ORDER_STATUSES = ["delivered", "cancelled", "refunded"];

function adminPhoneFromSettings(settings: Record<string, unknown> | null | undefined): string | null {
  const s = settings as any;
  const cand = s?.adminPhone ?? s?.whatsapp?.adminPhone ?? s?.notifications?.adminPhone;
  return typeof cand === "string" && cand.trim() ? cand.trim() : null;
}

/** Notify the tenant admin (if an admin phone is configured). Never throws. */
async function notifyTenantAdmin(ctx: UseCaseContext, message: string): Promise<void> {
  const adminPhone = adminPhoneFromSettings(ctx.tenantSettings);
  if (!adminPhone) {
    console.info(`[useCases] no admin phone for tenant ${ctx.tenantId} — admin notification skipped`);
    return;
  }
  await sendWhatsAppText(ctx.tenantId, adminPhone, message, { notifType: "admin_alert" })
    .catch((e: any) => console.warn("[useCases] admin notify failed:", e?.message));
}

async function findCustomerByPhone(db: Db, tenantId: string, phone: string) {
  const [customer] = await db
    .select()
    .from(customers)
    .where(and(eq(customers.tenantId, tenantId), eq(customers.whatsappPhone, phone)))
    .limit(1)
    .catch(() => [] as any[]);
  return customer ?? null;
}

/**
 * Recent orders for a WhatsApp phone. orders.customerId usually references
 * customers.id, but some flows store the raw phone — match both.
 */
async function recentOrdersForPhone(db: Db, tenantId: string, phone: string, limit = 5): Promise<Order[]> {
  const customer = await findCustomerByPhone(db, tenantId, phone);
  const candidates = customer ? [customer.id, phone] : [phone];
  const list = await db
    .select()
    .from(orders)
    .where(and(eq(orders.tenantId, tenantId), inArray(orders.customerId, candidates)))
    .orderBy(desc(orders.createdAt))
    .limit(limit)
    .catch(() => [] as Order[]);
  return list ?? [];
}

/** Count of the caller's not-yet-closed orders (dynamic menu context). */
export async function countOpenOrders(db: Db, tenantId: string, phone: string): Promise<number> {
  const list = await recentOrdersForPhone(db, tenantId, phone, 50);
  return list.filter((o) => !CLOSED_ORDER_STATUSES.includes(o.status)).length;
}

/**
 * One-line status + tracking link for the caller's most recent order.
 * Shared by the emoji-reaction handler and the track use case.
 */
export async function buildLatestOrderStatusReply(
  db: Db,
  tenantId: string,
  phone: string,
): Promise<string | null> {
  const [order] = await recentOrdersForPhone(db, tenantId, phone, 1);
  if (!order) return null;
  const [shipment] = await db
    .select()
    .from(logisticsShipments)
    .where(eq(logisticsShipments.orderId, order.id))
    .orderBy(desc(logisticsShipments.createdAt))
    .limit(1)
    .catch(() => [] as any[]);
  const statusLine = shipment
    ? `Order ${order.orderNumber} is ${order.status} — shipment ${shipment.status}.`
    : `Order ${order.orderNumber} is currently ${order.status}.`;
  return `Thanks for the reaction! 👍\n${statusLine}\nTrack it here: ${trackingUrlFor(order.id)}`;
}

// ── Use-case handlers ────────────────────────────────────────────────────────

/** shop → enter the existing NLP ordering flow. */
const shopHandler: UseCaseHandler = async (ctx, _session, input) => {
  const { appRouter } = await import("../routers");
  const caller = appRouter.createCaller({ user: null } as any);
  const result = await caller.nlp.processMessage({
    tenantId: ctx.tenantId,
    waPhoneNumber: ctx.phone,
    message: input.trim() || "I want to place an order",
    customerName: ctx.customerName,
  });
  return {
    reply: result?.reply ?? "Sure — what would you like to order?",
    // Follow-up messages route straight to the NLP pipeline.
    nextState: { mode: "nlp", activeUseCase: undefined, step: undefined },
  };
};

/** track → recent orders with status + tracking links. */
const trackHandler: UseCaseHandler = async (ctx) => {
  const list = await recentOrdersForPhone(ctx.db, ctx.tenantId, ctx.phone, 5);
  if (list.length === 0) {
    return {
      reply: "I couldn't find any orders for this number yet. Place an order first, then come back to track it here.",
      nextState: null,
    };
  }
  const lines = list.map(
    (o, i) => `${i + 1}. ${o.orderNumber} — ${o.status} (${o.totalAmount} ${o.currency})\n${trackingUrlFor(o.id)}`,
  );
  return { reply: `Here are your recent orders:\n\n${lines.join("\n\n")}`, nextState: null };
};

/** support → capture a free-text issue, then notify the tenant admin. */
const supportHandler: UseCaseHandler = async (ctx, session, input) => {
  if (session.step !== "awaiting_issue") {
    return {
      reply: "Sorry you're having trouble. Please describe your issue in a few words and our team will get back to you.",
      nextState: { mode: "usecase", activeUseCase: "support", step: "awaiting_issue", data: {} },
    };
  }
  const issue = input.trim();
  if (!issue) {
    return {
      reply: "Please type a short description of your issue so we can help.",
      nextState: { mode: "usecase", activeUseCase: "support", step: "awaiting_issue", data: session.data ?? {} },
    };
  }
  await ctx.db
    .insert(channelMessages)
    .values({
      channel: "whatsapp",
      direction: "inbound",
      fromAddress: ctx.phone,
      tenantId: ctx.tenantId,
      body: issue,
      metadata: { type: "support_inquiry", source: "wa_menu" },
      processed: false,
    })
    .catch((e: any) => console.warn("[useCases] support inquiry insert failed:", e?.message));
  await notifyTenantAdmin(
    ctx,
    `🆘 New support inquiry from ${ctx.phone}${ctx.customerName ? ` (${ctx.customerName})` : ""}:\n${issue}`,
  );
  return {
    reply: "Thanks — we've logged your issue and notified the team. Someone will get back to you shortly.",
    nextState: null,
  };
};

interface BookingSlot {
  serviceId?: string;
  serviceName?: string;
  serviceIds?: string[];
  serviceNames?: string[];
  [key: string]: unknown;
}

function parseBookingDateTime(input: string): Date | null {
  const t = input.trim();
  if (!t) return null;
  let d: Date | null = null;
  const m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (m) {
    let hour = parseInt(m[4], 10);
    const minute = m[5] ? parseInt(m[5], 10) : 0;
    const meridiem = m[6]?.toLowerCase();
    if (meridiem === "pm" && hour < 12) hour += 12;
    if (meridiem === "am" && hour === 12) hour = 0;
    d = new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10), hour, minute);
  } else {
    const parsed = Date.parse(t);
    if (!Number.isNaN(parsed)) d = new Date(parsed);
  }
  if (!d || Number.isNaN(d.getTime())) return null;
  if (d.getTime() <= Date.now()) return null; // bookings must be in the future
  return d;
}

const BOOKING_ASK_TIME =
  "When would you like to come in? Reply with a date and time, e.g. 2026-08-12 14:30.";

/** booking → slot-fill service + datetime, then create an appointment. */
const bookingHandler: UseCaseHandler = async (ctx, session, input) => {
  const data = (session.data ?? {}) as BookingSlot;

  if (session.step !== "choose_service" && session.step !== "choose_datetime") {
    const services = await ctx.db
      .select()
      .from(serviceCatalog)
      .where(and(eq(serviceCatalog.tenantId, ctx.tenantId), eq(serviceCatalog.isActive, true)))
      .limit(10)
      .catch(() => [] as any[]);
    if (!services || services.length === 0) {
      return {
        reply: "We don't have any bookable services right now. Please check back later or talk to an agent.",
        nextState: null,
      };
    }
    const lines = services.map((s: any, i: number) => `${i + 1}. ${s.name} — ${s.price} ${s.currency}`);
    return {
      reply: `Which service would you like to book?\n\n${lines.join("\n")}`,
      nextState: {
        mode: "usecase",
        activeUseCase: "booking",
        step: "choose_service",
        data: { serviceIds: services.map((s: any) => s.id), serviceNames: services.map((s: any) => s.name) },
      },
    };
  }

  if (session.step === "choose_service") {
    const idx = /^\d{1,2}$/.test(input.trim()) ? parseInt(input.trim(), 10) - 1 : -1;
    const ids = data.serviceIds ?? [];
    if (idx < 0 || idx >= ids.length) {
      return {
        reply: "Please reply with the number of the service you want to book.",
        nextState: { mode: "usecase", activeUseCase: "booking", step: "choose_service", data },
      };
    }
    return {
      reply: `You chose *${data.serviceNames?.[idx] ?? "service"}*. ${BOOKING_ASK_TIME}`,
      nextState: {
        mode: "usecase",
        activeUseCase: "booking",
        step: "choose_datetime",
        data: { ...data, serviceId: ids[idx], serviceName: data.serviceNames?.[idx] },
      },
    };
  }

  // choose_datetime
  const when = parseBookingDateTime(input);
  if (!when) {
    return {
      reply: `I couldn't understand that date/time. ${BOOKING_ASK_TIME}`,
      nextState: { mode: "usecase", activeUseCase: "booking", step: "choose_datetime", data },
    };
  }
  const serviceId = data.serviceId;
  if (!serviceId) {
    // Session lost the slot data — restart the flow rather than crashing.
    return bookingHandler(ctx, { ...session, step: undefined, data: {} }, "");
  }
  await ctx.db
    .insert(appointments)
    .values({
      serviceId,
      tenantId: ctx.tenantId,
      customerPhone: ctx.phone,
      customerName: ctx.customerName ?? null,
      scheduledAt: when,
      status: "scheduled",
      notes: "Booked via WhatsApp menu",
    })
    .catch((e: any) => console.warn("[useCases] appointment insert failed:", e?.message));
  await notifyTenantAdmin(
    ctx,
    `📅 New booking: ${data.serviceName ?? serviceId} for ${ctx.phone} at ${when.toISOString()}`,
  );
  return {
    reply: `Booked! ✅ ${data.serviceName ?? "Your appointment"} on ${when.toUTCString()}. We'll send a reminder before your slot.`,
    nextState: null,
  };
};

/** handoff → flag the conversation for a human agent + notify admin. */
const handoffHandler: UseCaseHandler = async (ctx) => {
  const customer = await findCustomerByPhone(ctx.db, ctx.tenantId, ctx.phone);
  if (customer) {
    const [conv] = await ctx.db
      .select()
      .from(conversations)
      .where(and(
        eq(conversations.tenantId, ctx.tenantId),
        eq(conversations.customerId, customer.id),
        eq(conversations.status, "open"),
      ))
      .orderBy(desc(conversations.updatedAt))
      .limit(1)
      .catch(() => [] as any[]);
    if (conv) {
      const prevMeta = (conv.metadata as Record<string, unknown> | null) ?? {};
      await ctx.db
        .update(conversations)
        .set({
          aiHandled: false,
          escalatedAt: new Date(),
          status: "pending",
          metadata: { ...prevMeta, handoffRequested: true, handoffAt: new Date().toISOString() },
          updatedAt: new Date(),
        })
        .where(eq(conversations.id, conv.id))
        .catch((e: any) => console.warn("[useCases] handoff flag update failed:", e?.message));
    }
  }
  await notifyTenantAdmin(
    ctx,
    `🙋 Human handoff requested by ${ctx.phone}${ctx.customerName ? ` (${ctx.customerName})` : ""}. Please take over the conversation.`,
  );
  return {
    reply: "Connecting you to a human agent — someone will be with you shortly. 🙏",
    nextState: null,
  };
};

export const useCaseRegistry: Record<UseCaseId, UseCaseHandler> = {
  shop: shopHandler,
  track: trackHandler,
  support: supportHandler,
  booking: bookingHandler,
  handoff: handoffHandler,
};

// ── Dispatcher plumbing ──────────────────────────────────────────────────────

export interface InboundOutcome {
  /** false → the caller should run the existing NLP fallback pipeline. */
  handled: boolean;
  /** Reply text to deliver to the caller (waSender on WhatsApp, CON/END on USSD). */
  reply?: string | null;
}

interface DispatchDeps {
  db: Db;
  tenantId: string;
  phone: string;
  customerName?: string;
  config: WaMenuConfig;
  tenantSettings: Record<string, unknown> | null;
  businessName?: string;
}

/** Persist nextState (returns true when the flow continues) or clear the session. */
async function applyOutcome(
  deps: Pick<DispatchDeps, "tenantId" | "phone">,
  session: ChatSession,
  outcome: UseCaseOutcome,
): Promise<boolean> {
  if (outcome.nextState) {
    await saveSession({
      ...session,
      ...outcome.nextState,
      tenantId: deps.tenantId,
      phone: deps.phone,
      updatedAt: Date.now(),
    });
    return true;
  }
  await clearSession(deps.tenantId, deps.phone);
  return false;
}

async function renderMenuForCaller(deps: DispatchDeps): Promise<string> {
  const openOrders = await countOpenOrders(deps.db, deps.tenantId, deps.phone).catch(() => null);
  return renderWhatsAppMenu(deps.config, { businessName: deps.businessName, openOrdersCount: openOrders });
}

async function showMenu(deps: DispatchDeps): Promise<InboundOutcome> {
  await saveSession({ ...newSession(deps.tenantId, deps.phone), awaitingMenuSelection: true });
  return { handled: true, reply: await renderMenuForCaller(deps) };
}

/** Run a use-case handler and persist the resulting session state. */
async function runUseCase(
  deps: DispatchDeps,
  session: ChatSession,
  id: UseCaseId,
  input: string,
): Promise<InboundOutcome> {
  const handler = useCaseRegistry[id];
  const ctx: UseCaseContext = {
    db: deps.db,
    tenantId: deps.tenantId,
    phone: deps.phone,
    customerName: deps.customerName,
    tenantSettings: deps.tenantSettings,
    businessName: deps.businessName,
  };
  const outcome = await handler(ctx, session, input);
  await applyOutcome(deps, session, outcome);
  return { handled: true, reply: outcome.reply };
}

async function dispatchSelection(
  deps: DispatchDeps,
  session: ChatSession | null,
  selection: MenuEntry,
): Promise<InboundOutcome> {
  if (selection.kind === "custom") {
    const item = deps.config.customItems.find((c) => c.key === selection.id);
    await clearSession(deps.tenantId, deps.phone);
    return { handled: true, reply: item?.response ?? "Thanks!" };
  }
  return runUseCase(deps, session ?? newSession(deps.tenantId, deps.phone), selection.id as UseCaseId, "");
}

// ── WhatsApp orchestrator ────────────────────────────────────────────────────

/**
 * Drive one inbound WhatsApp text message through consent → menu → use cases.
 * Returns { handled: false } when the message should be processed by the
 * existing NLP pipeline (fallback "nlp", or an active shop/NLP session).
 */
export async function handleConversationalInbound(opts: {
  db: Db;
  tenant: { id: string; name?: string | null; settings?: unknown } | null;
  tenantId: string;
  phone: string;
  text: string;
  customerName?: string;
}): Promise<InboundOutcome> {
  const { db, tenantId, phone, text } = opts;
  const deps: DispatchDeps = {
    db,
    tenantId,
    phone,
    customerName: opts.customerName,
    config: loadMenuConfig(opts.tenant),
    tenantSettings: (opts.tenant?.settings ?? null) as Record<string, unknown> | null,
    businessName: opts.tenant?.name ?? undefined,
  };

  // ── 1. NDPR consent gate (first-ever inbound from this phone) ────────────
  const existingConsent = await getConsent(db, tenantId, phone);
  let session = await getSession(tenantId, phone);
  if (!existingConsent) {
    const decision = parseConsentReply(text);
    if (decision === null) {
      // No consent row and no YES/NO yet → (re-)send the opt-in prompt.
      if (!session?.awaitingConsent) {
        await saveSession({ ...newSession(tenantId, phone), awaitingConsent: true });
      }
      return { handled: true, reply: CONSENT_PROMPT };
    }
    await recordConsent(db, { tenantId, phone, granted: decision });
    if (!decision) {
      await clearSession(tenantId, phone);
      return { handled: true, reply: CONSENT_DENIED_REPLY };
    }
    const menu = await renderMenuForCaller(deps);
    await saveSession({ ...newSession(tenantId, phone), awaitingMenuSelection: true });
    return { handled: true, reply: `${CONSENT_GRANTED_REPLY}\n\n${menu}` };
  }

  // ── 2. Menu keyword always re-opens the menu ─────────────────────────────
  if (isMenuKeyword(text)) {
    return showMenu(deps);
  }

  // ── 3. Active use-case flow (slot filling, support intake, …) ────────────
  if (session?.mode === "usecase" && session.activeUseCase && useCaseRegistry[session.activeUseCase]) {
    return runUseCase(deps, session, session.activeUseCase, text);
  }

  // ── 4. Active NLP (shop) session → hand off to the NLP pipeline ──────────
  if (session?.mode === "nlp") {
    return { handled: false };
  }

  // ── 5. Numeric menu selection (stateful or stateless menu) ───────────────
  if (!session || session.mode === "menu") {
    const selection = resolveMenuSelection(deps.config, text);
    if (selection) return dispatchSelection(deps, session, selection);
  }

  // ── 6. Unknown input → configured fallback ───────────────────────────────
  if (deps.config.fallback === "menu") {
    return showMenu(deps);
  }
  return { handled: false }; // "nlp" — existing LLM pipeline
}

// ── Emoji-reaction tracking ──────────────────────────────────────────────────

/**
 * WhatsApp reaction webhook payload (message with a `reaction` field):
 * resolve the sender's latest order/shipment and reply with its current
 * status + tracking link. Returns null when the sender has no orders.
 */
export async function handleReactionInbound(opts: {
  db: Db;
  tenantId: string;
  phone: string;
}): Promise<string | null> {
  return buildLatestOrderStatusReply(opts.db, opts.tenantId, opts.phone);
}

// ── USSD orchestrator (Africa's Talking) ─────────────────────────────────────

/**
 * Drive the SAME menu/session engine over USSD. `text` is the cumulative
 * Africa's Talking buffer ("1*2*…"); only the last segment is new input.
 * Returns the response body including the CON/END prefix.
 */
export async function handleUssdRequest(opts: {
  sessionId: string;
  serviceCode?: string;
  phoneNumber: string;
  text?: string;
}): Promise<string> {
  const db = await getDb();
  if (!db) return ussdWrap("Service temporarily unavailable. Please try again later.", true);

  // Resolve the tenant by the dialled service code (settings.ussd.serviceCode).
  let tenant: any = null;
  if (opts.serviceCode) {
    const rows = await db
      .select()
      .from(tenants)
      .where(sql`${tenants.settings} -> 'ussd' ->> 'serviceCode' = ${opts.serviceCode}`)
      .limit(1)
      .catch(() => [] as any[]);
    tenant = rows?.[0] ?? null;
  }
  const tenantId: string = tenant?.id ?? "default";
  const phone = opts.phoneNumber;
  const deps: DispatchDeps = {
    db,
    tenantId,
    phone,
    config: loadMenuConfig(tenant),
    tenantSettings: (tenant?.settings ?? null) as Record<string, unknown> | null,
    businessName: tenant?.name ?? undefined,
  };

  const parts = (opts.text ?? "").split("*").filter((p) => p.trim().length > 0);
  const lastInput = parts[parts.length - 1]?.trim() ?? "";
  const session = await getSession(tenantId, phone);

  const menuReply = async (end = false): Promise<string> => {
    const openOrders = await countOpenOrders(db, tenantId, phone).catch(() => null);
    return renderUssdMenu(deps.config, { businessName: deps.businessName, openOrdersCount: openOrders }, { end });
  };

  // Initial dial (empty buffer) or explicit "menu" → show the menu, expect input.
  if (lastInput === "" || isMenuKeyword(lastInput)) {
    await saveSession({ ...newSession(tenantId, phone), awaitingMenuSelection: true });
    return menuReply(false);
  }

  // Active use-case flow — CON while the flow continues, END when it completes.
  if (session?.mode === "usecase" && session.activeUseCase && useCaseRegistry[session.activeUseCase]) {
    const outcome = await runUseCase(deps, session, session.activeUseCase, lastInput);
    const continues = !!outcome.reply && (await getSession(tenantId, phone))?.mode === "usecase";
    return ussdWrap(outcome.reply ?? "OK.", !continues);
  }

  // Numeric menu selection.
  if (!session || session.mode === "menu") {
    const selection = resolveMenuSelection(deps.config, lastInput);
    if (selection) {
      const outcome = await dispatchSelection(deps, session, selection);
      const continues = (await getSession(tenantId, phone))?.mode === "usecase";
      return ussdWrap(outcome.reply ?? "OK.", !continues);
    }
  }

  // Unknown input → re-show the menu.
  await saveSession({ ...newSession(tenantId, phone), awaitingMenuSelection: true });
  return menuReply(false);
}
