/**
 * W14 F4 — lender-facing servicing tables (migration 0051, owned by W14-C1).
 *
 * These pgTable objects mirror the FROZEN 0051 schema so the servicing
 * services compile and run before C1's drizzle/schema.ts change lands:
 *   - credit_facilities          (new)
 *   - bureau_report_log          (new)
 *   - credit_accounts EXTENDED   (bureau_consent_at / bureau_consent_ref /
 *                                 facility_id added by 0051)
 * Once 0051's schema.ts definitions are merged these local objects keep
 * working unchanged — drizzle resolves columns by (table, name), not object
 * identity, and both describe the same physical tables.
 */
import { bigint, integer, jsonb, pgTable, timestamp, uuid, varchar } from "drizzle-orm/pg-core";

export const creditFacilities = pgTable("credit_facilities", {
  id: uuid("id").primaryKey().defaultRandom(),
  lenderName: varchar("lender_name", { length: 255 }).notNull(),
  facilityRef: varchar("facility_ref", { length: 64 }).notNull().unique(),
  commitmentCents: bigint("commitment_cents", { mode: "number" }).notNull(),
  currency: varchar("currency", { length: 3 }).notNull().default("NGN"),
  advanceRateBps: integer("advance_rate_bps").notNull().default(8000),
  covenants: jsonb("covenants"),
  status: varchar("status", { length: 20 }).notNull().default("active"), // 'active' | 'suspended' | 'closed'
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
export type CreditFacility = typeof creditFacilities.$inferSelect;
export type NewCreditFacility = typeof creditFacilities.$inferInsert;

export const bureauReportLog = pgTable("bureau_report_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: varchar("account_id", { length: 36 }).notNull(),
  eventType: varchar("event_type", { length: 30 }).notNull(),
  bureau: varchar("bureau", { length: 20 }).notNull(),
  status: varchar("status", { length: 20 }).notNull().default("pending"),
  payload: jsonb("payload"),
  response: jsonb("response"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
export type BureauReportLogEntry = typeof bureauReportLog.$inferSelect;

/**
 * credit_accounts as extended by migration 0051. Column-for-column identical
 * to the pre-0051 table plus the three new lender-servicing columns, so
 * queries built against this object hit the same physical table.
 */
export const creditAccountsExt = pgTable("credit_accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  supplierTenantId: varchar("supplier_tenant_id", { length: 36 }).notNull(),
  buyerTenantId: varchar("buyer_tenant_id", { length: 36 }).notNull(),
  limitCents: bigint("limit_cents", { mode: "number" }).notNull().default(0),
  outstandingCents: bigint("outstanding_cents", { mode: "number" }).notNull().default(0),
  status: varchar("status", { length: 20 }).notNull().default("active"),
  score: integer("score"),
  mandateId: varchar("mandate_id", { length: 36 }),
  bureauConsentAt: timestamp("bureau_consent_at"),
  bureauConsentRef: varchar("bureau_consent_ref", { length: 64 }),
  facilityId: varchar("facility_id", { length: 36 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
export type CreditAccountExt = typeof creditAccountsExt.$inferSelect;
