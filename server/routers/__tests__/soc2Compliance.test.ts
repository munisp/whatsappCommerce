/**
 * W19 SOC2 — compliance router: tenant-guard coverage and happy paths for
 * verifyAuditChain, accessReview, retentionPolicies/upsert, purgePreview/
 * purgeExecute, exportCustomerData, incidents CRUD, incidentStatus.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../db", () => ({ getDb: vi.fn() }));

import { getDb } from "../../db";
import { complianceRouter } from "../compliance";
import {
  auditChain, channelMessages, conversations, creditAccounts, customers,
  incidents, orders, retentionPolicies, sessionRevocations, tenantMemberships, users,
} from "../../../drizzle/schema";
import { makeSoc2FakeDb } from "../../services/testUtils/soc2FakeDb";

const T1 = "tenant-1";
const T2 = "tenant-2";

let store: Map<any, any[]>;
function seed() {
  store = new Map<any, any[]>([
    [auditChain, []],
    [retentionPolicies, []],
    [incidents, []],
    [orders, []],
    [customers, []],
    [users, []],
    [tenantMemberships, []],
    [sessionRevocations, []],
    [conversations, []],
    [channelMessages, []],
    [creditAccounts, []],
  ]);
  (getDb as any).mockResolvedValue(makeSoc2FakeDb(store));
}

function callerFor(tenantId: string | null, role = "user") {
  return complianceRouter.createCaller({
    user: { id: 5, openId: "u5", role, tenantId, name: "U5", email: null, loginMethod: null, createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
    req: { headers: {} },
    res: {},
  } as any);
}
const anon = () => complianceRouter.createCaller({ user: null, req: { headers: {} }, res: {} } as any);

beforeEach(() => { vi.clearAllMocks(); seed(); });

describe("tenant guards", () => {
  it("rejects cross-tenant callers on every SOC2 procedure", async () => {
    const c = callerFor(T2);
    await expect(c.verifyAuditChain({ tenantId: T1 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(c.accessReview({ tenantId: T1 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(c.retentionPolicies({ tenantId: T1 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(c.upsertRetentionPolicy({ tenantId: T1, entity: "orders", retentionDays: 30, legalHold: false })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(c.purgePreview({ tenantId: T1 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(c.purgeExecute({ tenantId: T1 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(c.exportCustomerData({ tenantId: T1, customerId: "x" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(c.listIncidents({ tenantId: T1, limit: 50 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(c.createIncident({ tenantId: T1, title: "t", severity: "low" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(c.incidentStatus({ tenantId: T1 })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects anonymous callers", async () => {
    await expect(anon().incidentStatus({ tenantId: T1 })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(anon().verifyAuditChain({ tenantId: T1 })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("updateIncident guards via the incident's tenant (id-keyed)", async () => {
    const own = callerFor(T1);
    const inc = await own.createIncident({ tenantId: T1, title: "guarded", severity: "low" });
    await expect(callerFor(T2).updateIncident({ incidentId: inc.id, status: "resolved" }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(callerFor(T1).updateIncident({ incidentId: "missing", status: "resolved" }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("incidents lifecycle + audit chain", () => {
  it("create → investigate → resolve; rollup counts; chain verifies; tamper breaks", async () => {
    const c = callerFor(T1);
    const inc = await c.createIncident({ tenantId: T1, title: "outage", severity: "high", description: "d" });
    expect(inc.status).toBe("open");
    await c.updateIncident({ incidentId: inc.id, status: "investigating" });
    await c.updateIncident({ incidentId: inc.id, status: "resolved" });

    const listed = await c.listIncidents({ tenantId: T1, status: "resolved", limit: 50 });
    expect(listed.length).toBe(1);
    expect(listed[0].resolvedAt).toBeTruthy();

    const rollup = await c.incidentStatus({ tenantId: T1 });
    expect(rollup).toMatchObject({ open: 0, investigating: 0, mitigated: 0, resolved: 1 });
    expect(rollup.recent[0]).toMatchObject({ id: inc.id, title: "outage", severity: "high", status: "resolved" });
    expect(typeof rollup.recent[0].openedAt).toBe("string");

    // 3 mutations → 3 chained audit events
    const v = await c.verifyAuditChain({ tenantId: T1 });
    expect(v).toEqual({ ok: true, rowsChecked: 3, firstBrokenId: null });

    // tamper with the first event's payload
    store.get(auditChain)![0].payload = { evil: true };
    const broken = await c.verifyAuditChain({ tenantId: T1 });
    expect(broken.ok).toBe(false);
    expect(broken.rowsChecked).toBe(0);
    expect(broken.firstBrokenId).toBe(store.get(auditChain)![0].id);
  });
});

describe("retention + purge via router", () => {
  it("upsert → list → preview → execute honors legal hold", async () => {
    const c = callerFor(T1);
    const up = await c.upsertRetentionPolicy({ tenantId: T1, entity: "orders", retentionDays: 30, legalHold: false });
    expect(up.ok).toBe(true);
    const policies = await c.retentionPolicies({ tenantId: T1 });
    expect(policies).toMatchObject([{ entity: "orders", retentionDays: 30, legalHold: false }]);
    expect(typeof policies[0].updatedAt).toBe("string");

    store.get(orders)!.push(
      { id: "o-old", tenantId: T1, createdAt: new Date(Date.now() - 40 * 86400000) },
      { id: "o-new", tenantId: T1, createdAt: new Date() },
    );
    const preview = await c.purgePreview({ tenantId: T1 });
    expect(preview.find((p: any) => p.entity === "orders")).toMatchObject({ candidateRows: 1, skipped: false });

    await c.upsertRetentionPolicy({ tenantId: T1, entity: "orders", retentionDays: 30, legalHold: true });
    const held = await c.purgeExecute({ tenantId: T1 });
    expect(held.find((r: any) => r.entity === "orders")).toMatchObject({ deleted: 0, skipped: true });
    expect(store.get(orders)!.length).toBe(2);

    await c.upsertRetentionPolicy({ tenantId: T1, entity: "orders", retentionDays: 30, legalHold: false });
    const exec = await c.purgeExecute({ tenantId: T1 });
    expect(exec.find((r: any) => r.entity === "orders")).toMatchObject({ deleted: 1 });
    expect(store.get(orders)!.map((r) => r.id)).toEqual(["o-new"]);
  });

  it("rejects unknown entities with BAD_REQUEST", async () => {
    const c = callerFor(T1);
    await expect(c.upsertRetentionPolicy({ tenantId: T1, entity: "bogus", retentionDays: 30, legalHold: false }))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(c.purgePreview({ tenantId: T1, entity: "bogus" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("accessReview", () => {
  it("returns per-tenant users with role, lastLoginAt, activeSessions", async () => {
    store.get(users)!.push(
      { id: 11, tenantId: T1, name: "Active Alice", phone: "+1", role: "user", lastSignedIn: new Date() },
      { id: 12, tenantId: T1, name: "Stale Bob", phone: null, role: "admin", lastSignedIn: new Date(Date.now() - 48 * 3600000) },
      { id: 13, tenantId: T2, name: "Other Tenant", phone: null, role: "user", lastSignedIn: new Date() },
    );
    store.get(tenantMemberships)!.push({ tenantId: T1, userId: "11", role: "owner" });
    const c = callerFor(T1);
    const review = await c.accessReview({ tenantId: T1 });
    const alice = review.find((r) => r.userId === "11")!;
    expect(alice).toMatchObject({ name: "Active Alice", phone: "+1", role: "owner", activeSessions: 1 });
    expect(typeof alice.lastLoginAt).toBe("string");
    const bob = review.find((r) => r.userId === "12")!;
    expect(bob.activeSessions).toBe(0); // outside the 12h session window
    expect(review.find((r) => r.userId === "13")).toBeUndefined(); // other tenant excluded
  });

  it("revoke-all marker zeroes activeSessions", async () => {
    store.get(users)!.push({ id: 21, tenantId: T1, name: "Revoked", phone: null, role: "user", lastSignedIn: new Date() });
    store.get(sessionRevocations)!.push({ jti: "user:21", userId: "21", expiresAt: new Date(Date.now() + 3600000) });
    const review = await callerFor(T1).accessReview({ tenantId: T1 });
    expect(review.find((r) => r.userId === "21")!.activeSessions).toBe(0);
  });
});

describe("exportCustomerData", () => {
  it("assembles customer, orders, conversations, messages, credit as JSON", async () => {
    store.get(customers)!.push({ id: "cust1", tenantId: T1, whatsappPhone: "+2341", name: "C1" });
    store.get(orders)!.push({ id: "o1", tenantId: T1, customerId: "cust1" });
    store.get(conversations)!.push({ id: "cv1", tenantId: T1, customerId: "cust1" });
    store.get(channelMessages)!.push(
      { id: "m1", tenantId: T1, fromAddress: "+2341", toAddress: "biz", body: "hi" },
      { id: "m2", tenantId: T1, fromAddress: "+9999", toAddress: "biz", body: "other" },
    );
    store.get(creditAccounts)!.push({ id: "ca1", buyerTenantId: T1, supplierTenantId: "sup", limitCents: 100 });
    const out = await callerFor(T1).exportCustomerData({ tenantId: T1, customerId: "cust1" });
    expect(out.customer).toMatchObject({ id: "cust1", name: "C1" });
    expect(out.orders.map((o: any) => o.id)).toEqual(["o1"]);
    expect(out.conversations.map((x: any) => x.id)).toEqual(["cv1"]);
    expect(out.messages.map((m: any) => m.id)).toEqual(["m1"]); // only the customer's phone
    expect(out.credit.map((x: any) => x.id)).toEqual(["ca1"]);
    expect(typeof out.exportedAt).toBe("string");
  });

  it("404s for a customer outside the tenant", async () => {
    store.get(customers)!.push({ id: "cust2", tenantId: T2, whatsappPhone: "+1" });
    await expect(callerFor(T1).exportCustomerData({ tenantId: T1, customerId: "cust2" }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
