/**
 * The customer-facing store. Everything is reached through a slug that resolves to exactly one tenant;
 * no procedure takes a tenant id, so a shopper can't ask for another shop's data. Public, rate-limited.
 */
import { randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { orders, paymentTransactions, storeAccountAddresses, storeAccounts, storeNewsletterSubscribers } from "../../drizzle/schema";
import { ENV } from "../_core/env";
import { publicProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import * as accounts from "../services/storefront/accounts";
import { normalizePhone, orderIdForCheckoutKey, placeOrder, quoteCheckout } from "../services/storefront/checkout";
import { categoriesOf, checkoutOptions, loadCatalog, loadStore, publishedReviews, resolveWhatsapp, type Db, type LoadedStore } from "../services/storefront/store";
import { generateTrackingToken, verifyTrackingToken } from "../services/trackingToken";

type Ctx = Parameters<Parameters<typeof publicProcedure.query>[0]>[0]["ctx"];

const slugSchema = z.string().min(1).max(80);
const lineSchema = z.object({ productId: z.string().max(36), variantId: z.string().max(36).nullish(), quantity: z.number().int().min(1).max(500) });
const passwordSchema = z.string().min(8, "Use at least 8 characters").max(200);
const addressSchema = z.object({
  label: z.string().trim().max(60).nullish(), recipient: z.string().trim().min(1).max(255), phone: z.string().trim().min(7).max(30),
  line1: z.string().trim().min(3).max(255), city: z.string().trim().min(1).max(120), state: z.string().trim().max(120).nullish(), isDefault: z.boolean().optional(),
});

async function requireDb(): Promise<Db> {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
  return db;
}

async function limit(ctx: Ctx, bucket: string, max: number, windowSeconds = 60) {
  const { clientIp } = await import("../services/rateLimit");
  const { checkRateLimit } = await import("../_core/rateLimit");
  const ip = ctx.req ? clientIp(ctx.req) : "unknown";
  const decision = await checkRateLimit(`store:${bucket}:${ip}`, max, windowSeconds, ENV.isProduction);
  if (!decision.allowed) throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "Too many attempts. Please wait a moment and try again." });
}

/** Staff of this store may see their own draft and hidden store. Nobody else can. */
async function storeOr404(db: Db, ctx: Ctx, slug: string, preview?: boolean): Promise<LoadedStore> {
  const store = await loadStore(db, slug, { previewTenantId: preview ? ctx.user?.tenantId ?? null : null });
  if (!store) throw new TRPCError({ code: "NOT_FOUND", message: "Store not found" });
  return store;
}

async function requireAccount(db: Db, ctx: Ctx, store: LoadedStore) {
  const account = await accounts.currentAccount(db, ctx.req, store.tenant.id);
  if (!account) throw new TRPCError({ code: "UNAUTHORIZED", message: "Please sign in" });
  return account;
}

const publicAccount = (a: { id: string; email: string; name: string; phone: string | null; marketingOptIn: boolean }) =>
  ({ id: a.id, email: a.email, name: a.name, phone: a.phone, marketingOptIn: a.marketingOptIn });

function storeOrigin(ctx: Ctx): string {
  const proto = (ctx.req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0] ?? ctx.req.protocol ?? "https";
  return `${proto}://${ctx.req.headers.host}`;
}

function orderSummary(o: typeof orders.$inferSelect) {
  const meta = (o.metadata ?? {}) as Record<string, unknown>;
  return {
    token: generateTrackingToken(o.id),
    orderNumber: o.orderNumber,
    status: o.status,
    paymentStatus: o.paymentStatus,
    total: o.totalAmount,
    currency: o.currency,
    createdAt: o.createdAt,
    itemCount: Array.isArray(o.items) ? (o.items as { qty?: number }[]).reduce((n, i) => n + (i.qty ?? 1), 0) : 0,
    paymentMethod: meta.paymentMethod === "cod" ? "cod" : "online",
  };
}

const money = (amount: number, currency: string) => `${currency === "NGN" ? "₦" : `${currency} `}${amount.toLocaleString("en-NG", { minimumFractionDigits: 2 })}`;
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

async function sendOrderEmail(store: LoadedStore, to: string, data: { orderNumber: string; total: number; currency: string; url: string; paymentMethod: "online" | "cod" }) {
  const { sendEmail } = await import("../services/email/resend");
  const name = escapeHtml(store.config.storeName || store.tenant.name);
  await sendEmail({
    to,
    subject: `Your ${store.config.storeName || store.tenant.name} order ${data.orderNumber}`,
    html: `<p>Thanks for your order from <strong>${name}</strong>.</p><p>Order <strong>${escapeHtml(data.orderNumber)}</strong>, total ${escapeHtml(money(data.total, data.currency))}.</p><p>${data.paymentMethod === "cod" ? "You'll pay on delivery." : "We'll confirm once your payment comes through."}</p><p><a href="${escapeHtml(data.url)}">View and track your order</a></p>`,
    text: `Thanks for your order from ${store.config.storeName || store.tenant.name}. Order ${data.orderNumber}, total ${money(data.total, data.currency)}. Track it: ${data.url}`,
  }).catch((e: unknown) => console.warn("[storefront] order email failed (non-blocking):", (e as Error)?.message));
}

export const storefrontShopRouter = router({
  /** Design, categories, contact details and what checkout offers. */
  store: publicProcedure.input(z.object({ slug: slugSchema, preview: z.boolean().optional() })).query(async ({ input, ctx }) => {
    await limit(ctx, "store", 120);
    const db = await requireDb();
    const store = await storeOr404(db, ctx, input.slug, input.preview);
    const catalog = await loadCatalog(db, store);
    const { getSpotlightPromos } = await import("../services/promoSpotlight");
    const [promos, reviews] = await Promise.all([
      getSpotlightPromos(db, store.tenant.id, store.tenant.settings).catch(() => []),
      publishedReviews(db, store.tenant.id),
    ]);
    const options = checkoutOptions(store.tenant.settings);
    const whatsapp = resolveWhatsapp(store.config, store.tenant);
    return {
      slug: store.storefront.slug,
      name: store.config.storeName || store.tenant.name,
      currency: catalog[0]?.currency ?? store.tenant.defaultCurrency ?? "NGN",
      config: store.config,
      isDraft: !!input.preview && ctx.user?.tenantId === store.tenant.id,
      isLive: store.storefront.isVisible,
      whatsapp: whatsapp.number,
      whatsappShopRef: whatsapp.shopRef,
      categories: categoriesOf(catalog),
      catalog,
      promos: promos.map((p) => ({ code: p.code ?? null, title: p.title, discountText: p.discountText })),
      reviews: reviews.slice(0, 12),
      checkout: { ...options, online: !!(ENV.paystackSecretKey || ENV.flwSecretKey) },
    };
  }),

  product: publicProcedure.input(z.object({ slug: slugSchema, productId: z.string().max(36), preview: z.boolean().optional() })).query(async ({ input, ctx }) => {
    await limit(ctx, "product", 120);
    const db = await requireDb();
    const store = await storeOr404(db, ctx, input.slug, input.preview);
    return { reviews: await publishedReviews(db, store.tenant.id, input.productId) };
  }),

  quote: publicProcedure.input(z.object({
    slug: slugSchema, lines: z.array(lineSchema).max(100), fulfillment: z.enum(["delivery", "pickup"]).default("delivery"),
    address: z.string().max(500).nullish(), promoCode: z.string().max(64).nullish(), preview: z.boolean().optional(),
  })).query(async ({ input, ctx }) => {
    await limit(ctx, "quote", 120);
    const db = await requireDb();
    return quoteCheckout(db, await storeOr404(db, ctx, input.slug, input.preview), input);
  }),

  checkout: publicProcedure.input(z.object({
    slug: slugSchema,
    checkoutKey: z.string().uuid(),
    lines: z.array(lineSchema).min(1).max(100),
    contact: z.object({ name: z.string().trim().min(2).max(255), phone: z.string().trim().min(7).max(30), email: z.string().trim().email().max(320).nullish() }),
    fulfillment: z.enum(["delivery", "pickup"]),
    deliveryAddress: z.object({ line1: z.string().trim().min(3).max(255), city: z.string().trim().min(1).max(120), state: z.string().trim().max(120).nullish() }).nullish(),
    paymentMethod: z.enum(["online", "cod"]),
    promoCode: z.string().max(64).nullish(),
    note: z.string().max(500).nullish(),
    ageAttestedAge: z.number().int().min(1).max(120).nullish(),
    saveAddress: z.boolean().optional(),
  })).mutation(async ({ input, ctx }) => {
    await limit(ctx, "checkout", 10);
    const db = await requireDb();
    // Checkout never runs against a draft: a hidden store can't take real orders.
    const store = await storeOr404(db, ctx, input.slug);
    const account = await accounts.currentAccount(db, ctx.req, store.tenant.id);
    const base = `${storeOrigin(ctx)}/shop/${store.storefront.slug}/orders`;
    const result = await placeOrder(db, store, {
      ...input, accountId: account?.id ?? null, orderUrl: (token) => `${base}/${token}`,
    });
    if (!result.ok) throw new TRPCError({ code: result.code === "invalid" ? "BAD_REQUEST" : "CONFLICT", message: result.error });
    if (!result.duplicate) {
      const email = input.contact.email ?? account?.email;
      if (email) void sendOrderEmail(store, email, { orderNumber: result.orderNumber, total: result.total, currency: result.currency, url: `${base}/${result.trackingToken}`, paymentMethod: result.paymentMethod });
      if (account && input.saveAddress && input.deliveryAddress) {
        await db.insert(storeAccountAddresses).values({
          id: randomUUID(), tenantId: store.tenant.id, accountId: account.id, recipient: input.contact.name,
          phone: normalizePhone(input.contact.phone) ?? input.contact.phone, line1: input.deliveryAddress.line1, city: input.deliveryAddress.city, state: input.deliveryAddress.state ?? null,
        }).catch(() => undefined);
      }
    }
    return result;
  }),

  /**
   * An order by tracking link, or by the key a payment provider returns the buyer with. Real statuses from
   * the order system; an order from another shop looks the same as no order at all.
   */
  order: publicProcedure.input(z.object({ slug: slugSchema, token: z.string().min(10).max(160) })).query(async ({ input, ctx }) => {
    await limit(ctx, "order", 120);
    const db = await requireDb();
    const [{ storefronts }] = [await import("../../drizzle/schema")];
    const [sf] = await db.select({ tenantId: storefronts.tenantId, slug: storefronts.slug }).from(storefronts).where(eq(storefronts.slug, input.slug.toLowerCase())).limit(1);
    if (!sf) throw new TRPCError({ code: "NOT_FOUND", message: "Order not found" });
    const orderId = input.token.startsWith("key-")
      ? await orderIdForCheckoutKey(db, sf.tenantId, input.token.slice(4))
      : verifyTrackingToken(input.token);
    if (!orderId) throw new TRPCError({ code: "NOT_FOUND", message: "Order not found" });
    const [order] = await db.select().from(orders).where(and(eq(orders.id, orderId), eq(orders.tenantId, sf.tenantId))).limit(1);
    if (!order) throw new TRPCError({ code: "NOT_FOUND", message: "Order not found" });
    const token = generateTrackingToken(order.id);
    const { trackingRouter } = await import("./tracking");
    const tracking = await trackingRouter.createCaller(ctx).getByToken({ token });
    const meta = (order.metadata ?? {}) as Record<string, unknown>;
    const unpaid = order.paymentStatus !== "completed" && meta.paymentMethod !== "cod" && order.status !== "cancelled";
    let paymentUrl: string | null = null;
    if (unpaid) {
      const [tx] = await db.select({ url: paymentTransactions.paymentUrl }).from(paymentTransactions)
        .where(eq(paymentTransactions.orderId, order.id)).orderBy(desc(paymentTransactions.createdAt)).limit(1);
      paymentUrl = tx?.url ?? null;
    }
    const address = order.shippingAddress as { raw?: string; line1?: string; city?: string; state?: string } | null;
    return {
      ...orderSummary(order),
      token,
      items: (Array.isArray(order.items) ? order.items : []) as { productId: string; name: string; qty: number; price: string }[],
      subtotal: String(meta.subtotal ?? order.totalAmount),
      deliveryFee: String(meta.deliveryFee ?? "0"),
      discount: (meta.promo as { discount?: string } | undefined)?.discount ?? null,
      fulfillment: meta.fulfillment === "pickup" ? "pickup" : "delivery",
      address: address?.raw ?? null,
      paymentUrl,
      shipment: tracking.shipment ?? null,
      history: (tracking as { shipmentHistory?: { status: string; at: string | null }[] }).shipmentHistory ?? [],
      etaMinutes: (tracking as { etaMinutes?: number | null }).etaMinutes ?? null,
    };
  }),

  /** Finds a guest's order from its number and the phone it was placed with. */
  lookupOrder: publicProcedure.input(z.object({ slug: slugSchema, orderNumber: z.string().trim().min(3).max(50), phone: z.string().trim().min(7).max(30) })).mutation(async ({ input, ctx }) => {
    await limit(ctx, "lookup", 10);
    const db = await requireDb();
    const store = await storeOr404(db, ctx, input.slug);
    const phone = normalizePhone(input.phone);
    const [order] = phone ? await db.select({ id: orders.id }).from(orders).where(and(
      eq(orders.tenantId, store.tenant.id), eq(orders.orderNumber, input.orderNumber.toUpperCase()), eq(orders.customerId, phone),
    )).limit(1) : [];
    if (!order) throw new TRPCError({ code: "NOT_FOUND", message: "We couldn't find an order with those details." });
    return { token: generateTrackingToken(order.id) };
  }),

  subscribe: publicProcedure.input(z.object({ slug: slugSchema, email: z.string().trim().email().max(320) })).mutation(async ({ input, ctx }) => {
    await limit(ctx, "subscribe", 5);
    const db = await requireDb();
    const store = await storeOr404(db, ctx, input.slug);
    await db.insert(storeNewsletterSubscribers).values({ id: randomUUID(), tenantId: store.tenant.id, email: input.email.toLowerCase() }).onConflictDoNothing();
    return { ok: true };
  }),

  account: router({
    me: publicProcedure.input(z.object({ slug: slugSchema, preview: z.boolean().optional() })).query(async ({ input, ctx }) => {
      const db = await requireDb();
      const store = await storeOr404(db, ctx, input.slug, input.preview);
      const account = await accounts.currentAccount(db, ctx.req, store.tenant.id);
      return account ? publicAccount(account) : null;
    }),

    register: publicProcedure.input(z.object({
      slug: slugSchema, name: z.string().trim().min(2).max(255), email: z.string().trim().email().max(320),
      phone: z.string().trim().max(30).nullish(), password: passwordSchema, marketingOptIn: z.boolean().optional(),
    })).mutation(async ({ input, ctx }) => {
      await limit(ctx, "register", 5);
      const db = await requireDb();
      const store = await storeOr404(db, ctx, input.slug);
      if (await accounts.findByEmail(db, store.tenant.id, input.email)) {
        throw new TRPCError({ code: "CONFLICT", message: "There's already an account with that email. Try signing in." });
      }
      const id = await accounts.createAccount(db, store.tenant.id, input);
      await accounts.issueSession(ctx.res, ctx.req, store.tenant.id, id);
      return { ok: true };
    }),

    login: publicProcedure.input(z.object({ slug: slugSchema, email: z.string().trim().email().max(320), password: z.string().max(200) })).mutation(async ({ input, ctx }) => {
      await limit(ctx, "login", 10);
      const db = await requireDb();
      const store = await storeOr404(db, ctx, input.slug);
      const account = await accounts.authenticate(db, store.tenant.id, input.email, input.password);
      if (!account) throw new TRPCError({ code: "UNAUTHORIZED", message: "That email and password don't match." });
      await accounts.issueSession(ctx.res, ctx.req, store.tenant.id, account.id);
      return { ok: true };
    }),

    logout: publicProcedure.input(z.object({ slug: slugSchema })).mutation(async ({ input, ctx }) => {
      const db = await requireDb();
      accounts.clearSession(ctx.res, ctx.req, (await storeOr404(db, ctx, input.slug)).tenant.id);
      return { ok: true };
    }),

    /** Always answers the same, so this can't be used to find out who has an account. */
    forgotPassword: publicProcedure.input(z.object({ slug: slugSchema, email: z.string().trim().email().max(320) })).mutation(async ({ input, ctx }) => {
      await limit(ctx, "forgot", 5, 300);
      const db = await requireDb();
      const store = await storeOr404(db, ctx, input.slug);
      const account = await accounts.findByEmail(db, store.tenant.id, input.email);
      if (account) {
        const token = await accounts.createPasswordReset(db, store.tenant.id, account.id);
        const url = `${storeOrigin(ctx)}/shop/${store.storefront.slug}/account/reset?token=${encodeURIComponent(token)}`;
        const name = store.config.storeName || store.tenant.name;
        const { sendEmail } = await import("../services/email/resend");
        void sendEmail({
          to: account.email, subject: `Reset your ${name} password`,
          html: `<p>Someone asked to reset the password for your ${escapeHtml(name)} account.</p><p><a href="${escapeHtml(url)}">Choose a new password</a>. This link works once and expires in an hour.</p><p>If this wasn't you, you can ignore this email.</p>`,
          text: `Reset your ${name} password: ${url} (works once, expires in an hour)`,
        }).catch((e: unknown) => console.warn("[storefront] reset email failed:", (e as Error)?.message));
      }
      return { ok: true };
    }),

    resetPassword: publicProcedure.input(z.object({ slug: slugSchema, token: z.string().min(20).max(200), password: passwordSchema })).mutation(async ({ input, ctx }) => {
      await limit(ctx, "reset", 10);
      const db = await requireDb();
      const store = await storeOr404(db, ctx, input.slug);
      if (!(await accounts.consumePasswordReset(db, store.tenant.id, input.token, input.password))) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "This reset link has expired or already been used." });
      }
      return { ok: true };
    }),

    updateProfile: publicProcedure.input(z.object({
      slug: slugSchema, name: z.string().trim().min(2).max(255), phone: z.string().trim().max(30).nullish(), marketingOptIn: z.boolean().optional(),
    })).mutation(async ({ input, ctx }) => {
      const db = await requireDb();
      const store = await storeOr404(db, ctx, input.slug);
      const account = await requireAccount(db, ctx, store);
      await db.update(storeAccounts).set({ name: input.name, phone: input.phone || null, marketingOptIn: input.marketingOptIn ?? account.marketingOptIn, updatedAt: new Date() })
        .where(and(eq(storeAccounts.id, account.id), eq(storeAccounts.tenantId, store.tenant.id)));
      return { ok: true };
    }),

    changePassword: publicProcedure.input(z.object({ slug: slugSchema, current: z.string().max(200), next: passwordSchema })).mutation(async ({ input, ctx }) => {
      await limit(ctx, "password", 10);
      const db = await requireDb();
      const store = await storeOr404(db, ctx, input.slug);
      const account = await requireAccount(db, ctx, store);
      if (!(await accounts.verifyPassword(input.current, account.passwordHash))) throw new TRPCError({ code: "BAD_REQUEST", message: "Your current password isn't right." });
      await db.update(storeAccounts).set({ passwordHash: await accounts.hashPassword(input.next), updatedAt: new Date() })
        .where(and(eq(storeAccounts.id, account.id), eq(storeAccounts.tenantId, store.tenant.id)));
      return { ok: true };
    }),

    addresses: publicProcedure.input(z.object({ slug: slugSchema })).query(async ({ input, ctx }) => {
      const db = await requireDb();
      const store = await storeOr404(db, ctx, input.slug);
      const account = await accounts.currentAccount(db, ctx.req, store.tenant.id);
      if (!account) return [];
      return db.select().from(storeAccountAddresses)
        .where(and(eq(storeAccountAddresses.tenantId, store.tenant.id), eq(storeAccountAddresses.accountId, account.id)))
        .orderBy(desc(storeAccountAddresses.isDefault), desc(storeAccountAddresses.createdAt));
    }),

    saveAddress: publicProcedure.input(addressSchema.extend({ slug: slugSchema, id: z.string().max(36).nullish() })).mutation(async ({ input, ctx }) => {
      const db = await requireDb();
      const store = await storeOr404(db, ctx, input.slug);
      const account = await requireAccount(db, ctx, store);
      const scope = and(eq(storeAccountAddresses.tenantId, store.tenant.id), eq(storeAccountAddresses.accountId, account.id));
      const values = { label: input.label ?? null, recipient: input.recipient, phone: input.phone, line1: input.line1, city: input.city, state: input.state ?? null, isDefault: input.isDefault === true };
      const id = input.id ?? randomUUID();
      if (input.isDefault) await db.update(storeAccountAddresses).set({ isDefault: false }).where(scope);
      if (input.id) await db.update(storeAccountAddresses).set(values).where(and(scope, eq(storeAccountAddresses.id, input.id)));
      else await db.insert(storeAccountAddresses).values({ id, tenantId: store.tenant.id, accountId: account.id, ...values });
      return { id };
    }),

    deleteAddress: publicProcedure.input(z.object({ slug: slugSchema, id: z.string().max(36) })).mutation(async ({ input, ctx }) => {
      const db = await requireDb();
      const store = await storeOr404(db, ctx, input.slug);
      const account = await requireAccount(db, ctx, store);
      await db.delete(storeAccountAddresses).where(and(
        eq(storeAccountAddresses.id, input.id), eq(storeAccountAddresses.tenantId, store.tenant.id), eq(storeAccountAddresses.accountId, account.id),
      ));
      return { ok: true };
    }),

    /**
     * Only orders placed while signed in to this account. Deliberately not matched by phone or email:
     * those are typed in unverified, and matching them would show a stranger someone else's orders.
     */
    orders: publicProcedure.input(z.object({ slug: slugSchema })).query(async ({ input, ctx }) => {
      const db = await requireDb();
      const store = await storeOr404(db, ctx, input.slug);
      const account = await accounts.currentAccount(db, ctx.req, store.tenant.id);
      if (!account) return [];
      const rows = await db.select().from(orders).where(and(
        eq(orders.tenantId, store.tenant.id), sql`${orders.metadata}->>'storeAccountId' = ${account.id}`,
      )).orderBy(desc(orders.createdAt)).limit(100);
      return rows.map(orderSummary);
    }),
  }),
});

