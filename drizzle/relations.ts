import { relations } from "drizzle-orm";
import {
  users,
  tenants,
  products,
  customers,
  conversations,
  channelMessages,
  orders,
  orderItems,
  paymentIntents,
  paymentTransactions,
  cartSessions,
  cartItems,
  agentEvents,
} from "./schema";

// ─── Tenants ──────────────────────────────────────────────────────────────────
export const tenantsRelations = relations(tenants, ({ many }) => ({
  users: many(users),
  products: many(products),
  customers: many(customers),
  conversations: many(conversations),
  orders: many(orders),
  paymentIntents: many(paymentIntents),
  paymentTransactions: many(paymentTransactions),
  cartSessions: many(cartSessions),
  channelMessages: many(channelMessages),
}));

// ─── Users ────────────────────────────────────────────────────────────────────
export const usersRelations = relations(users, ({ one }) => ({
  tenant: one(tenants, {
    fields: [users.tenantId],
    references: [tenants.id],
  }),
}));

// ─── Products ─────────────────────────────────────────────────────────────────
export const productsRelations = relations(products, ({ one, many }) => ({
  tenant: one(tenants, {
    fields: [products.tenantId],
    references: [tenants.id],
  }),
  orderItems: many(orderItems),
  cartItems: many(cartItems),
}));

// ─── Customers ────────────────────────────────────────────────────────────────
export const customersRelations = relations(customers, ({ one, many }) => ({
  tenant: one(tenants, {
    fields: [customers.tenantId],
    references: [tenants.id],
  }),
  conversations: many(conversations),
  orders: many(orders),
}));

// ─── Conversations & messages ─────────────────────────────────────────────────
export const conversationsRelations = relations(conversations, ({ one, many }) => ({
  tenant: one(tenants, {
    fields: [conversations.tenantId],
    references: [tenants.id],
  }),
  customer: one(customers, {
    fields: [conversations.customerId],
    references: [customers.id],
  }),
  orders: many(orders),
  agentEvents: many(agentEvents),
}));

export const channelMessagesRelations = relations(channelMessages, ({ one }) => ({
  tenant: one(tenants, {
    fields: [channelMessages.tenantId],
    references: [tenants.id],
  }),
}));

export const agentEventsRelations = relations(agentEvents, ({ one }) => ({
  conversation: one(conversations, {
    fields: [agentEvents.conversationId],
    references: [conversations.id],
  }),
}));

// ─── Orders & order items ─────────────────────────────────────────────────────
export const ordersRelations = relations(orders, ({ one, many }) => ({
  tenant: one(tenants, {
    fields: [orders.tenantId],
    references: [tenants.id],
  }),
  customer: one(customers, {
    fields: [orders.customerId],
    references: [customers.id],
  }),
  conversation: one(conversations, {
    fields: [orders.conversationId],
    references: [conversations.id],
  }),
  items: many(orderItems),
  paymentIntents: many(paymentIntents),
  paymentTransactions: many(paymentTransactions),
}));

export const orderItemsRelations = relations(orderItems, ({ one }) => ({
  order: one(orders, {
    fields: [orderItems.orderId],
    references: [orders.id],
  }),
  product: one(products, {
    fields: [orderItems.productId],
    references: [products.id],
  }),
}));

// ─── Payments ─────────────────────────────────────────────────────────────────
export const paymentIntentsRelations = relations(paymentIntents, ({ one }) => ({
  tenant: one(tenants, {
    fields: [paymentIntents.tenantId],
    references: [tenants.id],
  }),
  order: one(orders, {
    fields: [paymentIntents.orderId],
    references: [orders.id],
  }),
  customer: one(customers, {
    fields: [paymentIntents.customerId],
    references: [customers.id],
  }),
}));

export const paymentTransactionsRelations = relations(paymentTransactions, ({ one }) => ({
  tenant: one(tenants, {
    fields: [paymentTransactions.tenantId],
    references: [tenants.id],
  }),
  order: one(orders, {
    fields: [paymentTransactions.orderId],
    references: [orders.id],
  }),
  customer: one(customers, {
    fields: [paymentTransactions.customerId],
    references: [customers.id],
  }),
}));

// ─── Cart ─────────────────────────────────────────────────────────────────────
export const cartSessionsRelations = relations(cartSessions, ({ one, many }) => ({
  tenant: one(tenants, {
    fields: [cartSessions.tenantId],
    references: [tenants.id],
  }),
  items: many(cartItems),
}));

export const cartItemsRelations = relations(cartItems, ({ one }) => ({
  session: one(cartSessions, {
    fields: [cartItems.cartSessionId],
    references: [cartSessions.id],
  }),
  product: one(products, {
    fields: [cartItems.productId],
    references: [products.id],
  }),
}));
