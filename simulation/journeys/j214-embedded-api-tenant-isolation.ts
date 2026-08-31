/**
 * J214 — W33 embedded-api: audit actor + tenant isolation.
 *
 * 1. Every embedded mutation writes audit rows with actorId
 *    `embedded:<clientId>` (and vendor-bill events carry the same actor).
 * 2. No cross-tenant leakage: a client bound to tenant A gets 404 on tenant
 *    B's resources, and its list endpoints never include tenant B rows —
 *    the resource tenant is derived from the CLIENT BINDING, never from
 *    request params (a `tenantId` body field / X-Tenant-Id header naming
 *    tenant B is ignored).
 */
import { and, eq } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { adminCaller, tenantCaller } from "./helpers";

const TA = "j214-tenant-a";
const TB = "j214-tenant-b";
const SCOPES = ["bills:read", "bills:write", "payments:read", "payments:write", "invoices:read", "invoices:write"];

async function api(world: World, key: string, method: string, path: string, body?: Record<string, unknown>, extraHeaders?: Record<string, string>) {
  const res = await fetch(`${world.baseUrl}/api/embedded/v1${path}`, {
    method,
    headers: { "Content-Type": "application/json", "X-API-Key": key, ...(extraHeaders ?? {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

export const journey: Journey = {
  id: "J214",
  name: "embedded API audit actor embedded:<clientId> + strict tenant isolation",
  feature: "W33 embedded-api: audit trail + client-bound tenant context",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    process.env.EMBEDDED_API_ENABLED = "true";

    for (const [tid, uid] of [[TA, "2141"], [TB, "2142"]] as const) {
      await world.db.insert(schema.tenants).values({
        id: tid, name: `J214 ${tid}`, slug: tid, status: "active",
      }).onConflictDoNothing();
      await world.db.insert(schema.tenantMemberships).values({
        tenantId: tid, userId: uid, role: "owner",
      }).onConflictDoNothing();
      await world.db.insert(schema.merchantWallets).values({
        tenantId: tid, custodyMode: "psp", availableBalance: "500.00",
        bankAccountName: "J214 Merchant", bankAccountNumber: "0123456789", bankCode: "058",
      }).onConflictDoNothing();
    }
    const callerB = await tenantCaller(TB, { userId: 2142 });
    const billB = await callerB.vendorBills.create({
      tenantId: TB, vendorName: "Tenant B Vendor", amountCents: 9_000,
    });
    const invB = await callerB.arInvoices.create({ tenantId: TB, customerName: "B Customer", amountCents: 4_000 });

    const admin = await adminCaller();
    const clientA = await admin.embedded.createClient({
      partnerName: "J214 Partner A", tenantId: TA, scopes: SCOPES,
    });
    const key = clientA.apiKey;
    const actor = `embedded:${clientA.clientId}`;

    // ── 1. Mutations carry the embedded actor ──────────────────────────
    const created = await api(world, key, "POST", "/bills", { vendorName: "Tenant A Vendor", amountCents: 3_000 });
    assert(created.status === 201, `bill A created (got ${created.status})`);
    const billAId = created.json.bill.id;
    const paid = await api(world, key, "POST", `/bills/${billAId}/pay`, {});
    assert(paid.status === 200 && paid.json.status === "paid", `bill A paid (${JSON.stringify(paid.json)})`);
    await api(world, key, "POST", "/invoices", { customerName: "A Customer", amountCents: 2_500 });
    await api(world, key, "POST", "/payments/schedule", {
      kind: "adhoc", recipient: { name: "A Vendor" }, amountCents: 1_000,
      executeAt: new Date(Date.now() + 24 * 3600_000).toISOString(), idempotencyKey: "j214-sched-1",
    });

    const audits = await world.db.select().from(schema.auditLogs)
      .where(eq(schema.auditLogs.actorId, actor));
    const actions = audits.map((a: any) => a.action).sort();
    for (const want of ["embedded.bill.create", "embedded.bill.pay", "embedded.invoice.create", "embedded.payment.schedule"]) {
      assert(actions.includes(want), `audit row for ${want} with actor ${actor} (got ${JSON.stringify(actions)})`);
    }
    for (const a of audits) {
      assert(a.tenantId === TA && a.actorRole === "embedded", `audit tenant/role (${a.action}: ${a.tenantId}/${a.actorRole})`);
    }
    const events = await world.db.select().from(schema.vendorBillEvents)
      .where(and(eq(schema.vendorBillEvents.billId, billAId), eq(schema.vendorBillEvents.actor, actor)));
    assert(events.length >= 2, `bill events carry the embedded actor (got ${events.length})`);

    // ── 2. Tenant isolation: tenant B resources are invisible to A ─────
    const getB = await api(world, key, "GET", `/bills/${billB.bill.id}`);
    assert(getB.status === 404, `tenant B bill 404 for tenant A client (got ${getB.status})`);
    const payB = await api(world, key, "POST", `/bills/${billB.bill.id}/pay`, {});
    assert([403, 404].includes(payB.status), `tenant B bill cannot be paid via A's key (got ${payB.status})`);
    const [billBAfter] = await world.db.select().from(schema.vendorBills)
      .where(eq(schema.vendorBills.id, billB.bill.id));
    assert(billBAfter.status === "pending" && billBAfter.paidCents === 0, "tenant B bill untouched");

    const listA = await api(world, key, "GET", "/bills");
    assert(listA.status === 200 && listA.json.bills.every((b: any) => b.tenantId === TA),
      "bill list only contains the bound tenant's rows");
    assert(!listA.json.bills.some((b: any) => b.id === billB.bill.id), "tenant B bill not in A's list");
    const invListA = await api(world, key, "GET", "/invoices");
    assert(!invListA.json.invoices.some((i: any) => i.id === invB.id), "tenant B invoice not in A's list");

    // Tenant derived from the CLIENT BINDING — a tenantId in the body or an
    // X-Tenant-Id header naming tenant B is IGNORED, not honored.
    const forged = await api(world, key, "POST", "/bills",
      { vendorName: "Forged Tenant Vendor", amountCents: 700, tenantId: TB },
      { "X-Tenant-Id": TB });
    assert(forged.status === 201 && forged.json.bill.tenantId === TA,
      `request params/headers never override the client-bound tenant (got ${forged.json?.bill?.tenantId})`);
    const [forgedBill] = await world.db.select().from(schema.vendorBills)
      .where(eq(schema.vendorBills.id, forged.json.bill.id));
    assert(forgedBill.tenantId === TA, "forged bill landed on tenant A (the binding), not B");
  },
};
