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
  nlpSessions,
  orderItems,
  orders,
  paymentTransactions,
  serviceCatalog,
  tenants,
  type Order,
} from "../../drizzle/schema";
import {
  sendWhatsAppMedia,
  sendWhatsAppText,
  type SendInteractiveInput,
} from "./waSender";
import { trackingUrlFor } from "./trackingToken";
import {
  buildMenuEntries,
  isMenuKeyword,
  loadMenuConfig,
  parseMenuEntryReplyId,
  renderUssdMenu,
  renderWhatsAppInteractive,
  renderWhatsAppMenu,
  resolveMenuSelection,
  ussdWrap,
  type MenuDynamicCtx,
  type MenuEntry,
  type UseCaseId,
  type WaMenuConfig,
} from "./waMenu";
import {
  clearSession,
  getSession,
  newSession,
  saveSession,
  saveSessionCas,
  type ChatSession,
} from "./chatSession";
import {
  getConsent,
  parseConsentReply,
  recordConsent,
} from "./consent";
import {
  buildLanguageMenu,
  isLanguageMenuRequest,
  localizeMenuConfig,
  LOCALE_NAMES,
  matchLocalizedIntent,
  parseLanguageChoice,
  resolveLocale,
  setStickyLocale,
  t27,
  tr,
  type Locale,
} from "./i18n";
import { matchFaq, parseFaqSettings } from "./faq";
import { raiseChatDispute, buildDisputeReply } from "./chatDispute";
import {
  handlePoAction,
  handleProcurementChat,
  parsePoActionReplyId,
} from "./procurement/poFlow";

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
  // Dispute-flavoured support issues (not received / wrong item / damaged / …)
  // also become dispute records via the shared dispute service.
  if (/dispute|complain|refund|not received|never arrived|wrong item|wrong order|damaged|broken|missing item|incomplete/i.test(issue)) {
    const dispute = await raiseChatDispute({
      db: ctx.db,
      tenantId: ctx.tenantId,
      phone: ctx.phone,
      complaintText: issue,
      customerName: ctx.customerName,
    }).catch((e: any) => {
      console.warn("[useCases] support→dispute escalation failed:", e?.message);
      return null;
    });
    if (dispute && dispute.status !== "no_order") {
      return { reply: buildDisputeReply(dispute), nextState: null };
    }
  }
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

/**
 * procurement → B2B restock flow: browse suppliers, build a wholesale PO,
 * pick credit/pay-now, submit → supplier gets an Approve/Reject action card.
 * Also handles the supplier-side follow-ups (reject-reason prompt) and the
 * buyer-side credit-failure fallback. Full state machine: services/procurement/poFlow.ts.
 * NOTE: the "procurement" id joins WaUseCaseId via S4's shared/waMenu.ts
 * edit this wave; until that merges the registry is extended structurally.
 */
const procurementHandler: UseCaseHandler = (ctx, session, input) =>
  handleProcurementChat(ctx, session, input);

export type ExtendedUseCaseId = UseCaseId | "procurement";

export const useCaseRegistry: Record<UseCaseId, UseCaseHandler> &
  Record<"procurement", UseCaseHandler> = {
  shop: shopHandler,
  track: trackHandler,
  support: supportHandler,
  booking: bookingHandler,
  handoff: handoffHandler,
  procurement: procurementHandler,
};

// ── Dispatcher plumbing ──────────────────────────────────────────────────────

export interface InboundOutcome {
  /** false → the caller should run the existing NLP fallback pipeline. */
  handled: boolean;
  /** Reply text to deliver to the caller (waSender on WhatsApp, CON/END on USSD). */
  reply?: string | null;
  /**
   * Interactive (button/list) rendering of the reply, when available. The
   * WhatsApp webhook prefers this over `reply`; `reply` remains the plain
   * text fallback (and is what USSD/tests see).
   */
  interactive?: SendInteractiveInput;
}

interface DispatchDeps {
  db: Db;
  tenantId: string;
  phone: string;
  customerName?: string;
  config: WaMenuConfig;
  tenantSettings: Record<string, unknown> | null;
  businessName?: string;
  /** Resolved caller locale (sticky → detected → tenant default). */
  locale?: Locale;
}

/** Persist nextState (returns true when the flow continues) or clear the session. */
async function applyOutcome(
  deps: Pick<DispatchDeps, "tenantId" | "phone">,
  session: ChatSession,
  outcome: UseCaseOutcome,
): Promise<boolean> {
  if (outcome.nextState) {
    // Optimistic concurrency: the session was read before the use case ran —
    // a racing webhook delivery for the same phone must not be overwritten
    // silently. CAS on casVersion; on conflict reload the freshest session,
    // re-apply the outcome onto it, and retry once.
    const buildNext = (base: ChatSession): ChatSession => ({
      ...base,
      ...outcome.nextState,
      tenantId: deps.tenantId,
      phone: deps.phone,
      updatedAt: Date.now(),
    });
    const expected = session.casVersion ?? 0;
    if (await saveSessionCas(buildNext(session), expected)) return true;
    const fresh = await getSession(deps.tenantId, deps.phone);
    if (fresh && (await saveSessionCas(buildNext(fresh), fresh.casVersion ?? 0))) return true;
    console.error(
      `[useCases] session CAS conflict for ${deps.tenantId}/${deps.phone} — ` +
      "concurrent update won twice; dropping this transition (flow reply already sent).",
    );
    return true;
  }
  await clearSession(deps.tenantId, deps.phone);
  return false;
}

/** Dynamic menu context for one caller (open-order count annotation). */
async function menuCtxForCaller(deps: DispatchDeps): Promise<MenuDynamicCtx> {
  const openOrders = await countOpenOrders(deps.db, deps.tenantId, deps.phone).catch(() => null);
  return {
    businessName: deps.businessName,
    // Only annotate when there is something to report — "(0 open)" is noise.
    openOrdersCount: openOrders != null && openOrders > 0 ? openOrders : undefined,
  };
}

/** Menu config with localization applied; tenant-customized text is preserved. */
function localizedMenuConfig(deps: DispatchDeps): WaMenuConfig {
  return deps.locale ? localizeMenuConfig(deps.config, deps.locale) : deps.config;
}

async function renderMenuForCaller(deps: DispatchDeps): Promise<string> {
  return renderWhatsAppMenu(localizedMenuConfig(deps), await menuCtxForCaller(deps));
}

/** Tenant-configured PDF menu/catalog (settings.menuDocUrl), if any. */
function menuDocUrlFromSettings(settings: Record<string, unknown> | null | undefined): string | null {
  const cand = (settings as any)?.menuDocUrl;
  return typeof cand === "string" && /^https?:\/\/\S+$/.test(cand) ? cand : null;
}

/**
 * Auto-push the tenant's PDF menu/catalog as a WhatsApp document alongside
 * the (interactive) menu. Best-effort: failures are logged, never thrown.
 */
async function pushMenuDoc(deps: DispatchDeps): Promise<void> {
  const url = menuDocUrlFromSettings(deps.tenantSettings);
  if (!url) return;
  await sendWhatsAppMedia(
    deps.tenantId,
    deps.phone,
    {
      type: "document",
      link: url,
      caption: `${deps.businessName ?? "Our"} menu/catalog`,
      filename: "menu.pdf",
    },
    { notifType: "menu_doc" },
  ).catch((e: any) => console.warn("[useCases] menuDocUrl push failed:", e?.message));
}

async function showMenu(deps: DispatchDeps, opts: { sendMenuDoc?: boolean } = {}): Promise<InboundOutcome> {
  const ctx = await menuCtxForCaller(deps);
  const config = localizedMenuConfig(deps);
  await saveSession({ ...newSession(deps.tenantId, deps.phone), awaitingMenuSelection: true });
  if (opts.sendMenuDoc) await pushMenuDoc(deps);
  return {
    handled: true,
    reply: renderWhatsAppMenu(config, ctx),
    // WhatsApp prefers the interactive rendering; USSD never calls showMenu.
    interactive: renderWhatsAppInteractive(config, ctx) ?? undefined,
  };
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
  const tenantSettings = (opts.tenant?.settings ?? null) as Record<string, unknown> | null;
  const locale = await resolveLocale({ tenantId, phone, text, tenantSettings })
    .catch(() => "en" as Locale);
  const deps: DispatchDeps = {
    db,
    tenantId,
    phone,
    customerName: opts.customerName,
    config: loadMenuConfig(opts.tenant),
    tenantSettings,
    businessName: opts.tenant?.name ?? undefined,
    locale,
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
      return { handled: true, reply: tr(locale, "consentPrompt") };
    }
    await recordConsent(db, { tenantId, phone, granted: decision });
    if (!decision) {
      await clearSession(tenantId, phone);
      return { handled: true, reply: tr(locale, "consentDenied") };
    }
    const menu = await renderMenuForCaller(deps);
    await saveSession({ ...newSession(tenantId, phone), awaitingMenuSelection: true });
    return { handled: true, reply: `${tr(locale, "consentGranted")}\n\n${menu}` };
  }

  // ── 1b. W27 language selection: explicit request opens the picker; while
  //        awaitingLanguageChoice, a valid choice switches the sticky locale
  //        and re-renders the menu in the new language. ────────────────────
  if (isLanguageMenuRequest(text)) {
    await saveSession({
      ...(session ?? newSession(tenantId, phone)),
      awaitingLanguageChoice: true,
    });
    return { handled: true, reply: buildLanguageMenu(locale) };
  }
  if (session?.awaitingLanguageChoice) {
    const choice = parseLanguageChoice(text);
    if (choice) {
      await setStickyLocale(tenantId, phone, choice).catch(() => {});
      const localized = localizeMenuConfig(deps.config, choice);
      const menu = renderWhatsAppMenu(localized, await menuCtxForCaller(deps));
      await saveSession({ ...newSession(tenantId, phone), awaitingMenuSelection: true });
      return {
        handled: true,
        reply: `${t27(choice, "languageSetConfirm", { language: LOCALE_NAMES[choice] })}\n\n${menu}`,
      };
    }
    return {
      handled: true,
      reply: `${t27(locale, "invalidSelection")}\n\n${buildLanguageMenu(locale)}`,
    };
  }

  // ── 2. Menu keyword always re-opens the menu (and pushes the PDF menu
  //        when the tenant has settings.menuDocUrl configured) ──────────────
  if (isMenuKeyword(text)) {
    return showMenu(deps, { sendMenuDoc: true });
  }

  // ── 2b. W27 locale-aware intent keywords: localized "shop"/"track"/… map
  //        to the existing use-case ids so menu navigation works in every
  //        supported language (English list always included as fallback). ──
  const localizedIntent = matchLocalizedIntent(text, locale);
  if (localizedIntent === "menu") {
    return showMenu(deps, { sendMenuDoc: true });
  }
  if (localizedIntent && localizedIntent in useCaseRegistry) {
    const useCase = deps.config.useCases.find((u) => u.id === localizedIntent && u.enabled);
    if (useCase) {
      return runUseCase(deps, session ?? newSession(tenantId, phone), useCase.id as UseCaseId, text);
    }
  }

  // === W27 savings-insurance-vouchers (Coder G) ===
  // Stokvel / insurance / voucher keyword flows. A miss falls through to the
  // existing use-case / menu / NLP pipeline unchanged.
  try {
    const { handleSavingsInbound } = await import("./savingsWa");
    const savingsOutcome = await handleSavingsInbound({ db, tenantId, phone, text });
    if (savingsOutcome) return savingsOutcome;
  } catch (e: any) {
    console.warn("[useCases] savings inbound handler failed:", e?.message ?? e);
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
  // …but never while the NLP checkout is awaiting a structured answer
  // (fulfillment choice / delivery address): a bare "1"/"2" there belongs to
  // the checkout step, not to the menu — intercepting it would re-ask the
  // checkout question forever.
  const nlpAwaitingCheckoutStep = await (async () => {
    try {
      const [nlpSession] = await db
        .select({ context: nlpSessions.context })
        .from(nlpSessions)
        .where(and(eq(nlpSessions.tenantId, tenantId), eq(nlpSessions.waPhoneNumber, phone)))
        .limit(1);
      const ctx = (nlpSession?.context ?? null) as Record<string, unknown> | null;
      return ctx?.awaitingFulfillment === true || ctx?.awaitingAddress === true;
    } catch (e: any) {
      // Session-context read failed — fall back to menu dispatch, but never
      // swallow the error silently (it usually means DB trouble).
      console.warn("[useCases] nlp session context read failed:", e?.message ?? e);
      return false;
    }
  })();
  if (!nlpAwaitingCheckoutStep && (!session || session.mode === "menu")) {
    const selection = resolveMenuSelection(deps.config, text);
    if (selection) return dispatchSelection(deps, session, selection);
  }

  // ── 5b. FAQ knowledge base — answer directly before the NLP/handoff
  // fallback. A miss falls through to the existing pipeline. ────────────────
  const faqs = parseFaqSettings(deps.tenantSettings);
  if (faqs.length > 0) {
    const hit = matchFaq(faqs, text);
    if (hit) {
      await clearSession(deps.tenantId, deps.phone);
      return { handled: true, reply: hit.entry.a };
    }
  }

  // ── 6. Unknown input → configured fallback ───────────────────────────────
  if (deps.config.fallback === "menu") {
    return showMenu(deps);
  }
  return { handled: false }; // "nlp" — existing LLM pipeline
}

// ── Order action cards (Track / Pay / Cancel) ───────────────────────────────

export type OrderCardAction = "track" | "pay" | "cancel";

/** Interactive reply id for an order action button: `order_<action>:<orderId>`. */
export function orderActionReplyId(action: OrderCardAction, orderId: string): string {
  return `order_${action}:${orderId}`;
}

/** Parse an interactive reply id back into an order action (or null). */
export function parseOrderActionReplyId(id: string): { action: OrderCardAction; orderId: string } | null {
  const m = /^order_(track|pay|cancel):(\S+)$/.exec(id.trim());
  return m ? { action: m[1] as OrderCardAction, orderId: m[2] } : null;
}

/**
 * The interactive button card sent right after a confirm_order payment
 * summary: [Track Order] [Pay Now] [Cancel Order].
 */
export function buildOrderActionCard(opts: { orderId: string; orderNumber: string }): SendInteractiveInput {
  return {
    bodyText: `Order ${opts.orderNumber} — manage it here:`,
    footerText: "Or just reply with what you need.",
    action: {
      type: "button",
      buttons: [
        { id: orderActionReplyId("track", opts.orderId), title: "Track Order" },
        { id: orderActionReplyId("pay", opts.orderId), title: "Pay Now" },
        { id: orderActionReplyId("cancel", opts.orderId), title: "Cancel Order" },
      ],
    },
  };
}

/**
 * Load an order ONLY when it belongs to this WhatsApp phone — the same
 * ownership rule as the track use case (orders.customerId matches the
 * customer row id or the raw phone). Returns null for unknown OR foreign
 * orders so ownership probes learn nothing.
 */
async function findOwnedOrder(db: Db, tenantId: string, phone: string, orderId: string): Promise<Order | null> {
  const [order] = await db
    .select()
    .from(orders)
    .where(and(eq(orders.id, orderId), eq(orders.tenantId, tenantId)))
    .limit(1)
    .catch(() => [] as Order[]);
  if (!order) return null;
  const customer = await findCustomerByPhone(db, tenantId, phone);
  const candidates = customer ? [customer.id, phone] : [phone];
  return candidates.includes(order.customerId) ? order : null;
}

/**
 * Execute an order action-card button for the caller. Ownership is enforced
 * for every action; cancel additionally requires a still-pending order.
 */
export async function handleOrderAction(opts: {
  db: Db;
  tenantId: string;
  phone: string;
  action: OrderCardAction;
  orderId: string;
}): Promise<string> {
  const { db, tenantId, phone, action, orderId } = opts;
  const order = await findOwnedOrder(db, tenantId, phone, orderId);
  if (!order) {
    return "Sorry, I couldn't find that order for this number.";
  }

  if (action === "track") {
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
    return `${statusLine}\nTrack it here: ${trackingUrlFor(order.id)}`;
  }

  if (action === "pay") {
    // Never resurrect a checkout for a cancelled order — the buyer must not
    // be able to pay for something that will never ship.
    if (order.status === "cancelled") {
      return `Order ${order.orderNumber} was cancelled — no payment is due. Type "menu" to start a new order.`;
    }
    if (order.paymentStatus === "completed") {
      return `Order ${order.orderNumber} is already paid. ✅`;
    }
    const [tx] = await db
      .select()
      .from(paymentTransactions)
      .where(and(eq(paymentTransactions.orderId, order.id), eq(paymentTransactions.tenantId, tenantId)))
      .orderBy(desc(paymentTransactions.createdAt))
      .limit(1)
      .catch(() => [] as any[]);
    if (!tx?.paymentUrl) {
      return `I couldn't find a payment link for order ${order.orderNumber}. Please type "menu" and reach support — we'll sort it out.`;
    }
    return `💳 Complete payment for order ${order.orderNumber} (${order.totalAmount} ${order.currency}):\n${tx.paymentUrl}`;
  }

  // cancel — buyer-side mirror of orderCrud.cancel: pending orders only,
  // reserved stock released back (claim-first, idempotent).
  if (order.status !== "pending") {
    return `Order ${order.orderNumber} is ${order.status} and can no longer be cancelled here. Type "menu" → support if you need help.`;
  }
  const items = await db
    .select()
    .from(orderItems)
    .where(eq(orderItems.orderId, order.id))
    .catch(() => [] as any[]);
  for (const item of items) {
    await db.execute(sql`
      UPDATE inventory_snapshots
      SET "reservedQty" = GREATEST(0, CAST("reservedQty" AS NUMERIC) - ${item.quantity}),
          "availableQty" = CAST("availableQty" AS NUMERIC) + ${item.quantity}
      WHERE "productId" = ${item.productId}
    `).catch((e: any) => console.warn("[useCases] cancel stock release failed:", e?.message));
  }
  await db.update(orders).set({
    status: "cancelled",
    notes: "Cancelled by buyer via WhatsApp",
    updatedAt: new Date(),
  }).where(eq(orders.id, order.id));
  const { releaseReservations } = await import("./inventory");
  await releaseReservations(db, order.id)
    .catch((e: any) => console.warn("[useCases] reservation release error:", e?.message));
  return `✅ Order ${order.orderNumber} has been cancelled. Any reserved items are back in stock.`;
}

// ── Interactive replies (button_reply / list_reply) ─────────────────────────

/**
 * Drive one inbound WhatsApp *interactive* reply through the SAME dispatch
 * logic as text: order-card buttons route to handleOrderAction; menu
 * button/list replies (`menu_<n>` ids, or a title match) resolve through
 * resolveMenuSelection exactly like a numeric text reply.
 */
export async function handleInteractiveInbound(opts: {
  db: Db;
  tenant: { id: string; name?: string | null; settings?: unknown } | null;
  tenantId: string;
  phone: string;
  replyId?: string;
  replyTitle?: string;
  customerName?: string;
}): Promise<InboundOutcome> {
  const { db, tenantId, phone } = opts;
  const id = (opts.replyId ?? "").trim();

  // 0. Supplier PO action cards (Approve/Reject) — arrive on the supplier
  //    tenant's channel; ownership (po.supplierTenantId === tenantId) is
  //    enforced inside handlePoAction.
  const poAction = id ? parsePoActionReplyId(id) : null;
  if (poAction) {
    const result = await handlePoAction({ db, tenantId, phone, ...poAction });
    if (result.reasonPrompt) {
      await saveSession({
        ...newSession(tenantId, phone),
        mode: "usecase",
        activeUseCase: "procurement" as UseCaseId,
        step: "po_reject_reason",
        data: { poId: result.reasonPrompt.poId },
      });
    } else {
      await clearSession(tenantId, phone);
    }
    return { handled: true, reply: result.reply };
  }

  // 1. Order action card buttons.
  const orderAction = id ? parseOrderActionReplyId(id) : null;
  if (orderAction) {
    const reply = await handleOrderAction({ db, tenantId, phone, ...orderAction });
    await clearSession(tenantId, phone);
    return { handled: true, reply };
  }

  // 2. Menu button/list replies → numeric selection through the text path.
  const config = loadMenuConfig(opts.tenant);
  let n = id ? parseMenuEntryReplyId(id) : null;
  if (n == null && opts.replyTitle?.trim()) {
    const title = opts.replyTitle.trim().toLowerCase();
    const entry = buildMenuEntries(config).find((e) => e.label.trim().toLowerCase() === title);
    if (entry) n = entry.n;
  }
  if (n != null) {
    return handleConversationalInbound({
      db,
      tenant: opts.tenant,
      tenantId,
      phone,
      text: String(n),
      customerName: opts.customerName,
    });
  }

  // 3. Unknown interactive reply → treat the title as free text (NLP fallback).
  if (opts.replyTitle?.trim()) {
    return handleConversationalInbound({
      db,
      tenant: opts.tenant,
      tenantId,
      phone,
      text: opts.replyTitle,
      customerName: opts.customerName,
    });
  }
  return { handled: false };
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
  const ussdTenantSettings = (tenant?.settings ?? null) as Record<string, unknown> | null;
  const ussdLocale = await resolveLocale({ tenantId, phone, tenantSettings: ussdTenantSettings })
    .catch(() => "en" as Locale);
  const deps: DispatchDeps = {
    db,
    tenantId,
    phone,
    config: loadMenuConfig(tenant),
    tenantSettings: ussdTenantSettings,
    businessName: tenant?.name ?? undefined,
    locale: ussdLocale,
  };

  const parts = (opts.text ?? "").split("*").filter((p) => p.trim().length > 0);
  const lastInput = parts[parts.length - 1]?.trim() ?? "";
  const session = await getSession(tenantId, phone);

  const menuReply = async (end = false): Promise<string> => {
    return renderUssdMenu(localizedMenuConfig(deps), await menuCtxForCaller(deps), { end });
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
