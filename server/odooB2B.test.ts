/**
 * odooB2B.test.ts — wave-8 B2B integration tests:
 *  - new Odoo/Twenty client methods (purchase.order, vendor bill, payment, opportunity)
 *  - b2b outbox enqueue mapping (odoo + twenty, buyer mirror)
 *  - dispatch mapping per event kind; retry / failed / DLQ via the dispatcher
 *  - inbound stock.picking done → PO fulfilled exactly-once (+ buyer notify)
 *  - /health/ready odoo b2b outbox-lag probe
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SQL } from "drizzle-orm";
import type { IntegrationEvent } from "../drizzle/schema";
import { OdooClient, TwentyClient, IntegrationError } from "./services/integrations/clients";
import {
  dispatchOutbox,
  deliverOutboxEvent,
  MAX_OUTBOX_ATTEMPTS,
  type OutboxDispatcherStore,
} from "./services/integrations/outbox";
import {
  enqueueB2BSync,
  applyOdooPickingDone,
  poStatusToTwentyStage,
  METRIC_ODOO_B2B_EVENTS,
} from "./services/integrations/odooB2B";

// ── Module mocks ─────────────────────────────────────────────────────────────
const recordUsageSpy = vi.hoisted(() => vi.fn(async () => 1));
vi.mock("./services/metering", async (importOriginal) => {
  const mod = await importOriginal<any>();
  return { ...mod, recordUsage: recordUsageSpy };
});

const sendWhatsAppTextSpy = vi.hoisted(() =>
  vi.fn(async () => ({ sent: true, simulated: false, wamids: ["wamid.1"], chunks: 1 })),
);
vi.mock("./services/waSender", async (importOriginal) => {
  const mod = await importOriginal<any>();
  return { ...mod, sendWhatsAppText: sendWhatsAppTextSpy };
});

const dbHolder = vi.hoisted(() => ({ db: null as any }));
vi.mock("./db", async (importOriginal) => {
  const mod = await importOriginal<any>();
  return { ...mod, getDb: vi.fn(async () => dbHolder.db) };
});

// ── Fetch stub helpers (mirrors integrations.test.ts) ────────────────────────
type FetchCall = { url: string; init: RequestInit };
function stubFetchSequence(responses: Array<{ payload: unknown; status?: number }>) {
  const calls: FetchCall[] = [];
  let i = 0;
  const fn = vi.fn(async (url: any, init: any) => {
    calls.push({ url: String(url), init: init ?? {} });
    const r = responses[Math.min(i++, responses.length - 1)];
    const status = r.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => r.payload,
      text: async () => JSON.stringify(r.payload),
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", fn);
  return { calls, fn };
}
const rpcBodies = (calls: FetchCall[]) => calls.map((c) => JSON.parse(String(c.init.body)));
const FAST = { retries: 1, baseDelayMs: 1, timeoutMs: 5000 };

beforeEach(() => {
  vi.restoreAllMocks();
  recordUsageSpy.mockClear();
  sendWhatsAppTextSpy.mockClear();
  dbHolder.db = null;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ── drizzle SQL inspection helper (for raw-SQL db mocks) ─────────────────────
function sqlInfo(q: any): { text: string; params: any[] } {
  const chunks = (q as any)?.queryChunks ?? [];
  let text = "";
  const params: any[] = [];
  for (const c of chunks) {
    if (Array.isArray(c?.value)) text += c.value.join("");
    else if (c instanceof SQL) {
      const sub = sqlInfo(c);
      text += sub.text;
      params.push(...sub.params);
    } else {
      // Raw bound parameter (drizzle stores primitives directly in queryChunks).
      text += "?";
      params.push(c);
    }
  }
  return { text, params };
}

/** db whose select() always yields the given tenant settings rows in order. */
function makeConfigDb(settingsQueue: any[], extra: Partial<Record<string, any>> = {}) {
  return {
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => (settingsQueue.length ? [{ settings: settingsQueue.shift() }] : []) }),
      }),
    }),
    insert: (table: any) => ({
      values: (v: any) => {
        extra.inserted?.push({ table, v });
        return {
          returning: async () => [{ id: `evt-${extra.inserted?.length ?? 0}` }],
          onConflictDoUpdate: () => ({ returning: async () => [{ count: 1 }] }),
          then: (res: any) => res([]),
        };
      },
    }),
    execute: extra.execute ?? (async () => []),
  };
}

const ODOO_CFG = {
  url: "https://odoo.supplier.example",
  apiKey: "odoo_key",
  database: "erp",
  username: "bot",
  enabled: true,
};
const TWENTY_CFG = { url: "https://twenty.supplier.example", apiKey: "tw_key", enabled: true };

function makeEvent(over: Partial<IntegrationEvent> & { system: string; entity: string; action: string; data: any }): IntegrationEvent {
  return {
    id: over.id ?? "evt-1",
    tenantId: over.tenantId ?? "supplier-t",
    system: over.system,
    direction: "out",
    entity: over.entity,
    entityId: over.entityId ?? "po-uuid-1",
    payload: { action: over.action, origin: "platform", data: over.data },
    status: "pending",
    attempts: over.attempts ?? 0,
    lastError: null,
    createdAt: new Date(),
    processedAt: null,
  } as IntegrationEvent;
}

function makeStore(events: IntegrationEvent[]) {
  const failures: Array<{ id: string; attempts: number; status: string; lastError: string }> = [];
  const delivered: string[] = [];
  const store: OutboxDispatcherStore = {
    fetchPending: async () => events,
    markDelivered: async (id) => {
      delivered.push(id);
    },
    markFailure: async (id, attempts, lastError, status) => {
      failures.push({ id, attempts, lastError, status });
    },
  };
  return { store, failures, delivered };
}

const PO_DATA = {
  poNumber: "PO-00042",
  buyerTenantId: "buyer-t",
  buyerName: "Buyer Stores Ltd",
  supplierTenantId: "supplier-t",
  supplierName: "Supplier Co",
  status: "invoiced",
  subtotalCents: 250_000,
  currency: "NGN",
  dueDate: "2030-01-15T00:00:00.000Z",
  items: [
    { productRef: "SKU-1", name: "Rice 50kg", qty: 10, unitPriceCents: 20_000 },
    { productRef: "SKU-2", name: "Beans 25kg", qty: 5, unitPriceCents: 10_000 },
  ],
};

// ── New client methods ───────────────────────────────────────────────────────
describe("OdooClient B2B methods", () => {
  const cfg = { url: "https://odoo.x/", apiKey: "k", database: "db", username: "u" };

  it("createPurchaseOrder posts purchase.order create with origin + order lines", async () => {
    const { calls } = stubFetchSequence([{ payload: { result: 7 } }, { payload: { result: 21 } }]);
    const c = new OdooClient(cfg);
    const res = await c.createPurchaseOrder(
      {
        partnerId: 11,
        origin: "PO-00042",
        lines: [{ productRef: "SKU-1", name: "Rice 50kg", quantity: 10, unitPrice: 200 }],
      },
      FAST,
    );
    expect(res.id).toBe(21);
    const body = JSON.parse(String(calls[1].init.body));
    expect(body.params.args[3]).toBe("purchase.order");
    expect(body.params.args[4]).toBe("create");
    const values = body.params.args[5][0];
    expect(values.partner_id).toBe(11);
    expect(values.origin).toBe("PO-00042");
    expect(values.order_line[0][2]).toMatchObject({ name: "[SKU-1] Rice 50kg", product_qty: 10, price_unit: 200 });
  });

  it("confirmPurchaseOrder calls button_confirm on the PO", async () => {
    const { calls } = stubFetchSequence([{ payload: { result: 7 } }, { payload: { result: true } }]);
    const c = new OdooClient(cfg);
    const res = await c.confirmPurchaseOrder(21, FAST);
    expect(res.confirmed).toBe(true);
    const body = JSON.parse(String(calls[1].init.body));
    expect(body.params.args[3]).toBe("purchase.order");
    expect(body.params.args[4]).toBe("button_confirm");
    expect(body.params.args[5][0]).toEqual([21]);
  });

  it("createVendorBill creates an in_invoice account.move with invoice_date_due", async () => {
    const { calls } = stubFetchSequence([{ payload: { result: 7 } }, { payload: { result: 31 } }]);
    const c = new OdooClient(cfg);
    const res = await c.createVendorBill(
      {
        partnerId: 11,
        ref: "PO-00042",
        dueDate: "2030-01-15",
        lines: [{ name: "Rice 50kg", quantity: 10, unitPrice: 200 }],
      },
      FAST,
    );
    expect(res.id).toBe(31);
    const values = JSON.parse(String(calls[1].init.body)).params.args[5][0];
    expect(values.move_type).toBe("in_invoice");
    expect(values.ref).toBe("PO-00042");
    expect(values.invoice_date_due).toBe("2030-01-15");
    expect(values.invoice_line_ids[0][2]).toMatchObject({ name: "Rice 50kg", quantity: 10, price_unit: 200 });
  });

  it("registerBillPayment matches the bill by ref and posts the payment", async () => {
    const { calls } = stubFetchSequence([
      { payload: { result: 7 } }, // auth
      { payload: { result: [31] } }, // findVendorBillByRef
      { payload: { result: 41 } }, // account.payment create
      { payload: { result: true } }, // action_post
    ]);
    const c = new OdooClient(cfg);
    const res = await c.registerBillPayment({ ref: "PO-00042", amount: 2500 }, FAST);
    expect(res.id).toBe(41);
    const createBody = JSON.parse(String(calls[2].init.body)).params.args;
    expect(createBody[3]).toBe("account.payment");
    expect(createBody[5][0]).toMatchObject({
      payment_type: "outbound",
      amount: 2500,
      ref: "PO-00042",
      reconciled_invoice_ids: [[6, 0, [31]]],
    });
    expect(JSON.parse(String(calls[3].init.body)).params.args[4]).toBe("action_post");
  });

  it("registerBillPayment throws a RETRIABLE error when the bill is not synced yet", async () => {
    stubFetchSequence([{ payload: { result: 7 } }, { payload: { result: [] } }]);
    const c = new OdooClient(cfg);
    await expect(c.registerBillPayment({ ref: "PO-X", amount: 1 }, FAST)).rejects.toMatchObject({
      name: "IntegrationError",
      retriable: true,
    });
  });
});

describe("TwentyClient opportunities", () => {
  const cfg = { url: "https://twenty.x/", apiKey: "tk" };

  it("upsertOpportunity creates with company, micros amount and stage", async () => {
    const { calls } = stubFetchSequence([
      { payload: { data: [] } }, // find by name
      { payload: { data: { id: "opp-1" } } }, // create
    ]);
    const c = new TwentyClient(cfg);
    const res = await c.upsertOpportunity(
      { name: "PO PO-00042", companyId: "co-1", amountMicros: 2_500_000_000, currencyCode: "NGN", stage: "PROPOSAL" },
      FAST,
    );
    expect(res.id).toBe("opp-1");
    expect(calls[1].url).toBe("https://twenty.x/rest/opportunities");
    const body = JSON.parse(String(calls[1].init.body));
    expect(body).toMatchObject({
      name: "PO PO-00042",
      companyId: "co-1",
      amount: { amountMicros: 2_500_000_000, currencyCode: "NGN" },
      stage: "PROPOSAL",
    });
  });

  it("upsertOpportunity patches the existing deal matched by name", async () => {
    const { calls } = stubFetchSequence([
      { payload: { data: [{ id: "opp-9" }] } },
      { payload: { data: { id: "opp-9" } } },
    ]);
    const c = new TwentyClient(cfg);
    const res = await c.upsertOpportunity({ name: "PO PO-00042", stage: "CUSTOMER" }, FAST);
    expect(res.id).toBe("opp-9");
    expect(calls[1].url).toBe("https://twenty.x/rest/opportunities/opp-9");
    expect(calls[1].init.method).toBe("PATCH");
  });
});

describe("poStatusToTwentyStage", () => {
  it("maps every PO status to a pipeline stage", () => {
    expect(poStatusToTwentyStage("submitted")).toBe("NEW");
    expect(poStatusToTwentyStage("approved")).toBe("MEETING");
    expect(poStatusToTwentyStage("invoiced")).toBe("PROPOSAL");
    expect(poStatusToTwentyStage("fulfilled")).toBe("CUSTOMER");
    expect(poStatusToTwentyStage("paid")).toBe("CUSTOMER");
    expect(poStatusToTwentyStage("whatever")).toBe("NEW");
  });
});

// ── Enqueue mapping ──────────────────────────────────────────────────────────
describe("enqueueB2BSync", () => {
  it("enqueues one outbox row per enabled system and meters the odoo b2b event", async () => {
    const inserted: any[] = [];
    const db = makeConfigDb([{ integrations: { odoo: ODOO_CFG, twenty: TWENTY_CFG } }], { inserted });
    const ids = await enqueueB2BSync(db, {
      tenantId: "supplier-t",
      entity: "purchase_order",
      entityId: "po-uuid-1",
      action: "po.submitted",
      data: PO_DATA,
    });
    expect(ids).toHaveLength(2);
    expect(inserted.map((i) => i.v.system).sort()).toEqual(["odoo", "twenty"]);
    expect(inserted[0].v.payload).toMatchObject({ action: "po.submitted", origin: "platform" });
    expect(recordUsageSpy).toHaveBeenCalledWith(db, "supplier-t", METRIC_ODOO_B2B_EVENTS);
  });

  it("skips disabled/unconfigured systems", async () => {
    const inserted: any[] = [];
    const db = makeConfigDb([{ integrations: { odoo: { ...ODOO_CFG, enabled: false } } }], { inserted });
    const ids = await enqueueB2BSync(db, {
      tenantId: "supplier-t",
      entity: "purchase_order",
      entityId: "po-1",
      action: "po.submitted",
      data: PO_DATA,
    });
    expect(ids).toEqual([]);
    expect(inserted).toHaveLength(0);
  });

  it("po.invoiced mirrors a customer invoice into the BUYER's odoo when b2bMirror is on", async () => {
    const inserted: any[] = [];
    const db = makeConfigDb(
      [
        { integrations: { odoo: ODOO_CFG } }, // supplier
        { integrations: { odoo: { ...ODOO_CFG, b2bMirror: true } } }, // buyer
      ],
      { inserted },
    );
    const ids = await enqueueB2BSync(db, {
      tenantId: "supplier-t",
      buyerTenantId: "buyer-t",
      entity: "purchase_order",
      entityId: "po-uuid-1",
      action: "po.invoiced",
      data: PO_DATA,
    });
    expect(ids).toHaveLength(2);
    const mirror = inserted.find((i) => i.v.tenantId === "buyer-t");
    expect(mirror?.v.payload.action).toBe("po.buyer_invoice");
  });
});

// ── Dispatch mapping per event kind ──────────────────────────────────────────
describe("b2b outbox dispatch", () => {
  const settings = { integrations: { odoo: ODOO_CFG, twenty: TWENTY_CFG } };

  it("po.submitted → partner upsert + purchase.order draft with po_items lines", async () => {
    const { calls } = stubFetchSequence([
      { payload: { result: 7 } }, // auth
      { payload: { result: [] } }, // partner search
      { payload: { result: 11 } }, // partner create
      { payload: { result: 21 } }, // purchase.order create
    ]);
    const db = makeConfigDb([settings]);
    const event = makeEvent({ system: "odoo", entity: "purchase_order", action: "po.submitted", data: PO_DATA });
    const { store, delivered, failures } = makeStore([event]);
    const res = await dispatchOutbox(store, (e) => deliverOutboxEvent(db, e));
    expect(res.delivered).toBe(1);
    expect(delivered).toEqual(["evt-1"]);
    expect(failures).toHaveLength(0);
    const bodies = rpcBodies(calls);
    const create = bodies.find((b) => b.params?.args?.[3] === "purchase.order" && b.params?.args?.[4] === "create");
    expect(create.params.args[5][0].origin).toBe("PO-00042");
    expect(create.params.args[5][0].order_line).toHaveLength(2);
    expect(create.params.args[5][0].order_line[0][2]).toMatchObject({ product_qty: 10, price_unit: 200 });
  });

  it("po.invoiced → confirm PO + vendor bill carrying the credit due date", async () => {
    const { calls } = stubFetchSequence([
      { payload: { result: 7 } },
      { payload: { result: [11] } }, // partner found
      { payload: { result: true } }, // partner write
      { payload: { result: [21] } }, // findPurchaseOrderByOrigin
      { payload: { result: true } }, // button_confirm
      { payload: { result: 31 } }, // account.move create
    ]);
    const db = makeConfigDb([settings]);
    const event = makeEvent({ system: "odoo", entity: "purchase_order", action: "po.invoiced", data: PO_DATA });
    const { store } = makeStore([event]);
    const res = await dispatchOutbox(store, (e) => deliverOutboxEvent(db, e));
    expect(res.delivered).toBe(1);
    const bodies = rpcBodies(calls);
    const confirm = bodies.find((b) => b.params?.args?.[4] === "button_confirm");
    expect(confirm.params.args[5][0]).toEqual([21]);
    const bill = bodies.find((b) => b.params?.args?.[3] === "account.move" && b.params?.args?.[4] === "create");
    expect(bill.params.args[5][0]).toMatchObject({ move_type: "in_invoice", ref: "PO-00042", invoice_date_due: "2030-01-15" });
  });

  it("repayment.posted → account.payment matched to the vendor bill", async () => {
    const { calls } = stubFetchSequence([
      { payload: { result: 7 } },
      { payload: { result: [31] } }, // findVendorBillByRef
      { payload: { result: 41 } }, // payment create
      { payload: { result: true } }, // action_post
    ]);
    const db = makeConfigDb([settings]);
    const event = makeEvent({
      system: "odoo",
      entity: "credit_repayment",
      action: "repayment.posted",
      data: { poNumber: "PO-00042", amountCents: 250_000 },
    });
    const { store } = makeStore([event]);
    const res = await dispatchOutbox(store, (e) => deliverOutboxEvent(db, e));
    expect(res.delivered).toBe(1);
    const bodies = rpcBodies(calls);
    const pay = bodies.find((b) => b.params?.args?.[3] === "account.payment" && b.params?.args?.[4] === "create");
    expect(pay.params.args[5][0]).toMatchObject({ amount: 2500, ref: "PO-00042" });
  });

  it("twenty PO event → supplier company upsert + opportunity in mapped stage", async () => {
    const { calls } = stubFetchSequence([
      { payload: { data: [{ id: "co-1" }] } }, // company found
      { payload: { data: { id: "co-1" } } }, // company patch
      { payload: { data: [] } }, // opportunity find
      { payload: { data: { id: "opp-1" } } }, // opportunity create
    ]);
    const db = makeConfigDb([settings]);
    const event = makeEvent({ system: "twenty", entity: "purchase_order", action: "po.invoiced", data: PO_DATA });
    const { store } = makeStore([event]);
    const res = await dispatchOutbox(store, (e) => deliverOutboxEvent(db, e));
    expect(res.delivered).toBe(1);
    const oppCreate = calls.find((c) => c.url.endsWith("/rest/opportunities") && c.init.method === "POST");
    expect(oppCreate).toBeTruthy();
    expect(JSON.parse(String(oppCreate!.init.body))).toMatchObject({
      name: "PO PO-00042",
      companyId: "co-1",
      stage: "PROPOSAL",
      amount: { amountMicros: 2_500_000_000, currencyCode: "NGN" },
    });
  });

  it("odoo 5xx → retriable: event stays pending with attempts++ (no crash)", async () => {
    vi.useFakeTimers();
    stubFetchSequence([{ payload: { message: "boom" }, status: 500 }]);
    const db = makeConfigDb([settings]);
    const event = makeEvent({ system: "odoo", entity: "purchase_order", action: "po.submitted", data: PO_DATA });
    const { store, failures } = makeStore([event]);
    const p = dispatchOutbox(store, (e) => deliverOutboxEvent(db, e));
    await vi.runAllTimersAsync();
    const res = await p;
    expect(res.retried).toBe(1);
    expect(failures[0]).toMatchObject({ id: "evt-1", attempts: 1, status: "pending" });
  });

  it("odoo 4xx → non-retriable: event marked failed (no retry loop)", async () => {
    stubFetchSequence([{ payload: { message: "unauthorized" }, status: 401 }]);
    const db = makeConfigDb([settings]);
    const event = makeEvent({ system: "odoo", entity: "purchase_order", action: "po.submitted", data: PO_DATA });
    const { store, failures } = makeStore([event]);
    const res = await dispatchOutbox(store, (e) => deliverOutboxEvent(db, e));
    expect(res.failed).toBe(1);
    expect(failures[0]).toMatchObject({ status: "failed", attempts: 1 });
  });

  it("last attempt → event goes to the DLQ (dead)", async () => {
    vi.useFakeTimers();
    stubFetchSequence([{ payload: { message: "boom" }, status: 500 }]);
    const db = makeConfigDb([settings]);
    const event = makeEvent({
      system: "odoo",
      entity: "purchase_order",
      action: "po.submitted",
      data: PO_DATA,
      attempts: MAX_OUTBOX_ATTEMPTS - 1,
    });
    const { store, failures } = makeStore([event]);
    const p = dispatchOutbox(store, (e) => deliverOutboxEvent(db, e));
    await vi.runAllTimersAsync();
    const res = await p;
    expect(res.dead).toBe(1);
    expect(failures[0]).toMatchObject({ status: "dead", attempts: MAX_OUTBOX_ATTEMPTS });
  });
});

// ── Inbound: stock.picking done → PO fulfilled exactly-once ──────────────────
describe("applyOdooPickingDone", () => {
  function makePickingDb(poStore: any[], buyerSettings: any) {
    const executeCalls: Array<{ text: string; params: any[] }> = [];
    const db = {
      execute: async (q: any) => {
        const { text, params } = sqlInfo(q);
        executeCalls.push({ text, params });
        if (text.includes("UPDATE purchase_orders")) {
          const [, tenantId, poId, , poNumber] = params;
          const row = poStore.find(
            (p) =>
              p.supplier_tenant_id === tenantId &&
              ((poId && p.id === poId) || (poNumber && p.po_number === poNumber)),
          );
          if (row && (row.status === "approved" || row.status === "invoiced")) {
            row.status = "fulfilled";
            return [{ id: row.id, po_number: row.po_number, buyer_tenant_id: row.buyer_tenant_id }];
          }
          return [];
        }
        return [];
      },
      select: () => ({
        from: () => ({ where: () => ({ limit: async () => [{ settings: buyerSettings }] }) }),
      }),
      executeCalls,
    };
    return db;
  }

  it("flips an approved PO to fulfilled and notifies the buyer once", async () => {
    const poStore = [
      { id: "po-1", po_number: "PO-00042", supplier_tenant_id: "supplier-t", buyer_tenant_id: "buyer-t", status: "approved" },
    ];
    const db = makePickingDb(poStore, { adminPhone: "+2348000000000" });
    const r1 = await applyOdooPickingDone(db, "supplier-t", "done", { origin: "PO-00042", state: "done" });
    expect(r1).toBe("updated");
    expect(poStore[0].status).toBe("fulfilled");
    expect(sendWhatsAppTextSpy).toHaveBeenCalledTimes(1);
    expect(sendWhatsAppTextSpy.mock.calls[0][0]).toBe("buyer-t");
    expect(sendWhatsAppTextSpy.mock.calls[0][2]).toContain("PO-00042");

    // Replay: guarded UPDATE matches nothing → no second update, no re-notify.
    const r2 = await applyOdooPickingDone(db, "supplier-t", "done", { origin: "PO-00042", state: "done" });
    expect(r2).toBe("ignored");
    expect(sendWhatsAppTextSpy).toHaveBeenCalledTimes(1);
  });

  it("ignores pickings for POs not in approved/invoiced (draft stays draft)", async () => {
    const poStore = [
      { id: "po-2", po_number: "PO-00099", supplier_tenant_id: "supplier-t", buyer_tenant_id: "buyer-t", status: "submitted" },
    ];
    const db = makePickingDb(poStore, { adminPhone: "+2348000000000" });
    const res = await applyOdooPickingDone(db, "supplier-t", "done", { origin: "PO-00099", state: "done" });
    expect(res).toBe("ignored");
    expect(poStore[0].status).toBe("submitted");
    expect(sendWhatsAppTextSpy).not.toHaveBeenCalled();
  });

  it("ignores non-done pickings and cross-tenant POs", async () => {
    const poStore = [
      { id: "po-3", po_number: "PO-1", supplier_tenant_id: "other-t", buyer_tenant_id: "buyer-t", status: "approved" },
    ];
    const db = makePickingDb(poStore, {});
    expect(await applyOdooPickingDone(db, "supplier-t", "assigned", { origin: "PO-1", state: "assigned" })).toBe("ignored");
    expect(await applyOdooPickingDone(db, "supplier-t", "done", { origin: "PO-1", state: "done" })).toBe("ignored");
    expect(poStore[0].status).toBe("approved");
  });
});

// ── /health/ready odoo b2b outbox lag ────────────────────────────────────────
describe("health/ready odooB2bOutbox probe", () => {
  it("reports pending count and lag seconds for b2b event kinds", async () => {
    const queries: string[] = [];
    dbHolder.db = {
      execute: async (q: any) => {
        const { text } = sqlInfo(q);
        queries.push(text);
        if (text.includes("integration_events")) return [{ pending: 3, lag_seconds: 42.5 }];
        return [];
      },
    };
    // keycloak / tigerbeetle probes fail fast with no network.
    stubFetchSequence([{ payload: {}, status: 503 }]);
    const { checkReadiness } = await import("./services/healthReady");
    const report = await checkReadiness();
    const probe = report.components.odooB2bOutbox;
    expect(probe.ok).toBe(true);
    expect(probe.pending).toBe(3);
    expect(probe.lagSeconds).toBe(42.5);
    const q = queries.find((t) => t.includes("integration_events"))!;
    expect(q).toContain("'purchase_order'");
    expect(q).toContain("'credit_repayment'");
    expect(q).toContain("'odoo'");
  });
});
