/**
 * J212 — W33 embedded-api: full partner flow over /api/embedded/v1.
 *
 * Admin provisions a client (one-time plaintext key) → partner creates a
 * vendor bill via the API → paying ABOVE the tenant approval threshold parks
 * honestly (pending_approval, no money moves — embedded CANNOT bypass the
 * W31 gate) → owner approves in-app → poll the API → bill paid, wallet
 * debited exactly once. A below-threshold bill pays immediately through the
 * same surface (same recordVendorBillPayment money path as in-app).
 */
import { eq } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { adminCaller, tenantCaller } from "./helpers";

const T = "j212-tenant";
const ALL_SCOPES = ["bills:read", "bills:write", "payments:read", "payments:write", "invoices:read", "invoices:write"];

async function api(world: World, key: string, method: string, path: string, body?: Record<string, unknown>) {
  const res = await fetch(`${world.baseUrl}/api/embedded/v1${path}`, {
    method,
    headers: { "Content-Type": "application/json", "X-API-Key": key },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

async function walletCents(world: World): Promise<number> {
  const schema = await import("../../drizzle/schema");
  const [w] = await world.db.select().from(schema.merchantWallets)
    .where(eq(schema.merchantWallets.tenantId, T));
  return Math.round(parseFloat(w.availableBalance) * 100);
}

export const journey: Journey = {
  id: "J212",
  name: "embedded API full flow: bill create → pay parks at approval gate → owner approves → paid",
  feature: "W33 embedded-api: /api/embedded/v1 bills + approval-gate composition",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    process.env.EMBEDDED_API_ENABLED = "true";

    await world.db.insert(schema.tenants).values({
      id: T, name: "J212 Embedded", slug: T, status: "active",
    }).onConflictDoNothing();
    await world.db.insert(schema.tenantMemberships).values({
      tenantId: T, userId: "2121", role: "owner",
    }).onConflictDoNothing();
    const owner = await tenantCaller(T, { userId: 2121 });
    await world.db.insert(schema.merchantWallets).values({
      tenantId: T, custodyMode: "psp", availableBalance: "1000.00",
      bankAccountName: "J212 Merchant", bankAccountNumber: "0123456789", bankCode: "058",
    }).onConflictDoNothing();

    // Approval policy: vendor bill payments >= ₦100 park for owner approval.
    const pol = await owner.approvals.setPolicy({
      tenantId: T, thresholdCents: 10_000, kinds: ["vendor_bill_payment"], approverRole: "owner", expiryHours: 72,
    });
    assert(pol.ok === true && pol.enabled === true, "owner set the approval policy");

    // ── Admin provisions the embedded client (one-time plaintext key) ──
    const admin = await adminCaller();
    const provisioned = await admin.embedded.createClient({
      partnerName: "J212 Partner Platform", tenantId: T, scopes: ALL_SCOPES,
    });
    assert(typeof provisioned.apiKey === "string" && provisioned.apiKey.startsWith("emb_"), "one-time plaintext key returned");
    const key = provisioned.apiKey;
    // Only the digest persists — plaintext is nowhere in the DB row.
    const [row] = await world.db.select().from(schema.embeddedClients)
      .where(eq(schema.embeddedClients.id, provisioned.clientId));
    assert(row.apiKeyHash.length === 64 && !row.apiKeyHash.includes("emb_"), "only sha256 digest stored");
    assert(row.tenantId === T && row.status === "active", "client bound to the tenant");
    const listed = await admin.embedded.listClients({ tenantId: T });
    assert(listed.clients.length === 1 && !("apiKeyHash" in listed.clients[0]), "listClients never exposes digests");

    // ── Create a bill via the embedded API ─────────────────────────────
    const created = await api(world, key, "POST", "/bills", {
      vendorName: "Embedded Supplies Co", billNumber: "EMB-212",
      amountCents: 50_000, dueDate: new Date(Date.now() + 7 * 24 * 3600_000).toISOString(),
    });
    assert(created.status === 201, `bill created (got ${created.status}: ${JSON.stringify(created.json)})`);
    const billId = created.json.bill.id;
    assert(created.json.bill.tenantId === T && created.json.bill.status === "pending", "bill pending on the bound tenant");

    const fetched = await api(world, key, "GET", `/bills/${billId}`);
    assert(fetched.status === 200 && fetched.json.bill.id === billId, "GET /bills/:id returns the bill");

    // ── Pay ABOVE threshold → parks at the SAME approval gate ──────────
    const parked = await api(world, key, "POST", `/bills/${billId}/pay`, {});
    assert(parked.status === 200, `pay call ok (got ${parked.status})`);
    assert(parked.json.approvalRequired === true && parked.json.status === "pending_approval",
      `embedded pay respects the approval gate (${JSON.stringify(parked.json)})`);
    assert(typeof parked.json.approvalId === "string", "parked pay carries approvalId");
    assert((await walletCents(world)) === 100_000, "nothing debited while pending approval");

    // ── Owner approves IN-APP → poll the API → paid ────────────────────
    const approved = await owner.approvals.approve({ tenantId: T, approvalId: parked.json.approvalId });
    assert(approved.ok === true && approved.executed === true, `approval executed (${JSON.stringify(approved.execution)})`);
    const after = await api(world, key, "GET", `/bills/${billId}`);
    assert(after.json.bill.status === "paid", `bill paid after approval (got ${after.json.bill.status})`);
    assert(after.json.bill.paymentRef === `vbill:${billId}`, "same vbill:<billId> idempotency ref as in-app");
    assert((await walletCents(world)) === 50_000, `wallet debited exactly once (got ${await walletCents(world)})`);

    // ── Below-threshold bill pays immediately through the same path ────
    const small = await api(world, key, "POST", "/bills", { vendorName: "Cheap Vendor", amountCents: 5_000 });
    assert(small.status === 201, "small bill created");
    const paid = await api(world, key, "POST", `/bills/${small.json.bill.id}/pay`, {});
    assert(paid.json.status === "paid" && paid.json.chargedCents === 5_000,
      `below-threshold pay executes immediately (${JSON.stringify(paid.json)})`);
    assert((await walletCents(world)) === 45_000, "wallet reflects both payments");

    // Idempotent replay: paying the same bill again → honest 409 conflict.
    const replay = await api(world, key, "POST", `/bills/${billId}/pay`, {});
    assert(replay.status === 409, `re-pay of a paid bill conflicts (got ${replay.status})`);

    // ── AR invoice + scheduled payment pass-throughs ───────────────────
    const inv = await api(world, key, "POST", "/invoices", { customerName: "J212 Customer", amountCents: 12_500 });
    assert(inv.status === 201 && inv.json.invoice.status === "draft" && inv.json.invoice.invoiceNo >= 1,
      `AR invoice created (${JSON.stringify(inv.json)})`);
    const sched = await api(world, key, "POST", "/payments/schedule", {
      kind: "adhoc", recipient: { name: "Later Vendor", account: "9998887776", bankCode: "058" },
      amountCents: 7_500, executeAt: new Date(Date.now() + 24 * 3600_000).toISOString(),
      idempotencyKey: "j212-sched-1",
    });
    assert(sched.status === 201 && sched.json.payment.status === "pending", "scheduled payment created");
    const gotSched = await api(world, key, "GET", `/payments/${sched.json.payment.id}`);
    assert(gotSched.status === 200 && gotSched.json.payment.idempotencyKey === "j212-sched-1", "GET /payments/:id");
    const dup = await api(world, key, "POST", "/payments/schedule", {
      kind: "adhoc", recipient: { name: "Later Vendor" }, amountCents: 7_500,
      executeAt: new Date(Date.now() + 24 * 3600_000).toISOString(), idempotencyKey: "j212-sched-1",
    });
    assert(dup.status === 200 && dup.json.duplicate === true, "idempotency-key replay returns the original");
  },
};
