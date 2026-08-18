/**
 * J118 — O2 stakeholder journey (data-protection officer): access review
 * lists the tenant's users + sessions → retention policy upsert → purge
 * preview counts expired rows → LEGAL HOLD blocks the purge → hold lifted →
 * purge executes exactly the expired rows → customer data export contains
 * the customer's orders, messages and credit lines (and the export itself
 * lands on the audit chain as a sensitive event).
 *
 * Exercises: compliance.accessReview, upsertRetentionPolicy / purgePreview /
 * purgeExecute (services/retention.ts), compliance.exportCustomerData,
 * auditChain appends.
 */
import { and, eq } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { adminCaller, expectTrpcError, tenantCaller } from "./helpers";

const DAY_MS = 24 * 60 * 60 * 1000;

export const journey: Journey = {
  id: "J118",
  name: "access review → retention policy → legal hold → purge → export",
  feature: "O2 retention + portability lifecycle end-to-end",
  async run(world) {
    const schema = await import("../../drizzle/schema");
    const admin = await adminCaller();

    const tenant = (await admin.onboarding.start({ name: "J118 DPO Tenant" })).tenantId;
    const dpo = await tenantCaller(tenant, { userId: 1180 });
    const intruderTenant = (await admin.onboarding.start({ name: "J118 Intruder" })).tenantId;
    const intruder = await tenantCaller(intruderTenant, { userId: 1181 });

    // ── Seed: a customer with old + fresh orders and messages ────────────
    const customerId = "j118-customer";
    const phone = "+2349000001180";
    await world.db.insert(schema.customers).values({
      id: customerId, tenantId: tenant, whatsappPhone: phone, name: "J118 Customer",
    });
    const old = new Date(Date.now() - 40 * DAY_MS);
    await world.db.insert(schema.orders).values([
      { id: "j118-order-old", tenantId: tenant, customerId, orderNumber: "J118-OLD", totalAmount: "120.00", createdAt: old, updatedAt: old },
      { id: "j118-order-new", tenantId: tenant, customerId, orderNumber: "J118-NEW", totalAmount: "80.00" },
    ]);
    await world.db.insert(schema.channelMessages).values([
      { tenantId: tenant, channel: "whatsapp", direction: "inbound", fromAddress: phone, body: "j118 old message", createdAt: old },
      { tenantId: tenant, channel: "whatsapp", direction: "inbound", fromAddress: phone, body: "j118 fresh message" },
    ]);
    await world.db.insert(schema.creditAccounts).values({
      supplierTenantId: "j118-supplier", buyerTenantId: tenant,
      limitCents: 250000, outstandingCents: 75000,
    });
    // A second staff user for the access review.
    await world.db.insert(schema.users).values({
      openId: "j118-staff", name: "J118 Staff", phone: "+2349000001181",
      role: "user", tenantId: tenant, lastSignedIn: new Date(),
    });

    // ── 1. Access review: users + sessions, tenant-guarded ───────────────
    const review = await dpo.compliance.accessReview({ tenantId: tenant });
    const staff = review.find((r: any) => r.name === "J118 Staff");
    assert(staff, "access review lists the tenant user");
    assert(staff.role === "user" && staff.activeSessions === 1 && typeof staff.lastLoginAt === "string",
      `review row carries role/session/lastLogin (got ${JSON.stringify(staff)})`);
    await expectTrpcError(
      intruder.compliance.accessReview({ tenantId: tenant }),
      "FORBIDDEN", "cross-tenant access review rejected",
    );

    // ── 2. Retention policy upsert (orders + messages, 30 days) ──────────
    await expectTrpcError(
      intruder.compliance.upsertRetentionPolicy({ tenantId: tenant, entity: "orders", retentionDays: 30 }),
      "FORBIDDEN", "cross-tenant policy upsert rejected",
    );
    await dpo.compliance.upsertRetentionPolicy({ tenantId: tenant, entity: "orders", retentionDays: 30, legalHold: false });
    await dpo.compliance.upsertRetentionPolicy({ tenantId: tenant, entity: "messages", retentionDays: 30, legalHold: false });
    const policies = await dpo.compliance.retentionPolicies({ tenantId: tenant });
    assert(policies.length === 2, `two policies listed (got ${policies.length})`);

    // ── 3. Purge preview counts the expired rows ─────────────────────────
    const preview = await dpo.compliance.purgePreview({ tenantId: tenant });
    const prevOrders = preview.find((p: any) => p.entity === "orders")!;
    const prevMsgs = preview.find((p: any) => p.entity === "messages")!;
    assert(prevOrders.candidateRows === 1 && prevOrders.skipped === false, "preview counts the expired order");
    assert(prevMsgs.candidateRows === 1 && prevMsgs.skipped === false, "preview counts the expired message");

    // ── 4. Legal hold BLOCKS the purge ───────────────────────────────────
    await dpo.compliance.upsertRetentionPolicy({ tenantId: tenant, entity: "orders", retentionDays: 30, legalHold: true });
    const heldPreview = await dpo.compliance.purgePreview({ tenantId: tenant, entity: "orders" });
    assert(heldPreview[0].legalHold === true && heldPreview[0].candidateRows === 0 && heldPreview[0].skipped === true,
      "legal hold suppresses purge candidates");
    const heldExec = await dpo.compliance.purgeExecute({ tenantId: tenant, entity: "orders" });
    assert(heldExec[0].deleted === 0, "no rows deleted under legal hold");
    const [stillThere] = await world.db.select({ id: schema.orders.id }).from(schema.orders)
      .where(eq(schema.orders.id, "j118-order-old")).limit(1);
    assert(stillThere, "expired order survives under legal hold");

    // ── 5. Hold lifted → purge executes exactly the expired rows ─────────
    await dpo.compliance.upsertRetentionPolicy({ tenantId: tenant, entity: "orders", retentionDays: 30, legalHold: false });
    const exec = await dpo.compliance.purgeExecute({ tenantId: tenant });
    const execOrders = exec.find((r: any) => r.entity === "orders")!;
    const execMsgs = exec.find((r: any) => r.entity === "messages")!;
    assert(execOrders.deleted === 1 && execMsgs.deleted === 1,
      `purge deletes exactly the expired rows (got orders=${execOrders.deleted}, messages=${execMsgs.deleted})`);
    const remainingOrders = await world.db.select({ id: schema.orders.id }).from(schema.orders)
      .where(eq(schema.orders.tenantId, tenant));
    const remainingIds = remainingOrders.map((r: any) => r.id);
    assert(!remainingIds.includes("j118-order-old") && remainingIds.includes("j118-order-new"),
      "expired order purged, fresh order retained");
    const remainingMsgs = await world.db.select({ body: schema.channelMessages.body }).from(schema.channelMessages)
      .where(and(eq(schema.channelMessages.tenantId, tenant), eq(schema.channelMessages.fromAddress, phone)));
    const bodies = remainingMsgs.map((m: any) => m.body);
    assert(!bodies.includes("j118 old message") && bodies.includes("j118 fresh message"),
      "expired message purged, fresh message retained");

    // Purge executions appended to the audit chain; chain verifies.
    const chainOk = await dpo.compliance.verifyAuditChain({ tenantId: tenant });
    assert(chainOk.ok === true, `audit chain intact after retention lifecycle (got ${JSON.stringify(chainOk)})`);

    // ── 6. Customer data export: orders + messages + credit ──────────────
    await expectTrpcError(
      intruder.compliance.exportCustomerData({ tenantId: tenant, customerId }),
      "FORBIDDEN", "cross-tenant export rejected",
    );
    const exported = await dpo.compliance.exportCustomerData({ tenantId: tenant, customerId });
    assert(exported.customer?.id === customerId, "export returns the customer");
    assert(exported.orders.length === 1 && exported.orders[0].id === "j118-order-new",
      "export contains the retained order");
    assert(exported.messages.length === 1 && /fresh message/.test(exported.messages[0].body ?? ""),
      "export contains the retained message");
    assert(exported.credit.length === 1 && Number(exported.credit[0].outstandingCents) === 75000,
      `export contains the credit line (got ${JSON.stringify(exported.credit)})`);
    assert(typeof exported.exportedAt === "string", "export stamped");

    // The export itself is a sensitive audit-chain event (feeds W20 anomaly detection).
    const chainRows = await world.db.select().from(schema.auditChain).where(eq(schema.auditChain.tenantId, tenant));
    const kinds = chainRows.map((r: any) => r.eventType);
    assert(kinds.includes("retention_policy_upsert") && kinds.includes("retention_purge") && kinds.includes("customer_data_export"),
      `policy/purge/export events on the chain (got ${kinds.join(",")})`);
  },
};
