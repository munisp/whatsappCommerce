/**
 * Tests for the Medusa/Twenty/Odoo integration layer:
 *  - typed REST clients (URL/headers/body mapping, IntegrationError)
 *  - outbox dispatch: success / retry / dead paths
 *  - inbound webhook signature accept/reject (timingSafeEqual path)
 *  - loop guard (inbound-applied writes never enqueue outbound events)
 *  - integrations router tenant isolation (cross-tenant rejected)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { IntegrationEvent } from "../drizzle/schema";
import {
  IntegrationError,
  MedusaClient,
  OdooClient,
  TwentyClient,
} from "./services/integrations/clients";
import {
  dispatchOutbox,
  enqueueIntegrationEvent,
  MAX_OUTBOX_ATTEMPTS,
  type OutboxDispatcherStore,
} from "./services/integrations/outbox";
import {
  applyInboundEvent,
  handleIntegrationWebhook,
  signForTest,
  verifyIntegrationSignature,
} from "./services/integrations/inbound";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

// ── fetch mocking helpers ────────────────────────────────────────────────────

type FetchCall = { url: string; init: RequestInit };

function stubFetchOnce(payload: unknown, status = 200) {
  const calls: FetchCall[] = [];
  const queue: Array<{ payload: unknown; status: number }> = [{ payload, status }];
  const fn = vi.fn(async (url: any, init: any) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = queue.length > 1 ? queue.shift()! : queue[0];
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      json: async () => next.payload,
      text: async () => JSON.stringify(next.payload),
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", fn);
  return { calls, fn, queue };
}

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

const FAST = { retries: 1, baseDelayMs: 1, timeoutMs: 5000 };

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.unstubAllGlobals());

// ── Client mappers ───────────────────────────────────────────────────────────

describe("MedusaClient", () => {
  const cfg = { url: "https://medusa.example.com/", apiKey: "mk_secret", enabled: true };

  it("upsertProduct (create) posts to /admin/products with Bearer auth and mapped body", async () => {
    const { calls } = stubFetchOnce({ product: { id: "prod_1" } });
    const client = new MedusaClient(cfg);
    const res = await client.upsertProduct(
      { title: "Ankara Dress", sku: "ANK-1", price: 42.5, currency: "NGN", stockQuantity: 7 },
      FAST,
    );
    expect(res.id).toBe("prod_1");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://medusa.example.com/admin/products");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer mk_secret");
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.title).toBe("Ankara Dress");
    expect(body.variants[0].sku).toBe("ANK-1");
    expect(body.variants[0].prices[0]).toEqual({ amount: 42.5, currency_code: "ngn" });
  });

  it("upsertProduct with externalId updates /admin/products/:id", async () => {
    const { calls } = stubFetchOnce({ product: { id: "prod_9" } });
    const client = new MedusaClient(cfg);
    await client.upsertProduct(
      { externalId: "prod_9", title: "T", sku: "S", price: 1, currency: "USD" },
      FAST,
    );
    expect(calls[0].url).toBe("https://medusa.example.com/admin/products/prod_9");
  });

  it("createDraftOrder maps items and metadata", async () => {
    const { calls } = stubFetchOnce({ draft_order: { id: "do_1" } });
    const client = new MedusaClient(cfg);
    const res = await client.createDraftOrder(
      {
        email: "a@b.c",
        currency: "NGN",
        items: [{ title: "Dress", quantity: 2, unitPrice: 10 }],
        metadata: { platformOrderId: "ord_1" },
      },
      FAST,
    );
    expect(res.id).toBe("do_1");
    expect(calls[0].url).toBe("https://medusa.example.com/admin/draft-orders");
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.items[0]).toEqual({ title: "Dress", quantity: 2, unit_price: 10 });
    expect(body.metadata.platformOrderId).toBe("ord_1");
  });

  it("throws IntegrationError on terminal 4xx without retrying", async () => {
    const { calls } = stubFetchOnce({ message: "nope" }, 401);
    const client = new MedusaClient(cfg);
    await expect(client.testConnection({ retries: 3, baseDelayMs: 1 })).rejects.toMatchObject({
      name: "IntegrationError",
      system: "medusa",
      status: 401,
      retriable: false,
    });
    expect(calls).toHaveLength(1); // no retry on 4xx
  });

  it("retries 5xx then throws retriable IntegrationError", async () => {
    const { calls } = stubFetchOnce({ message: "boom" }, 500);
    const client = new MedusaClient(cfg);
    await expect(client.testConnection({ retries: 2, baseDelayMs: 1 })).rejects.toMatchObject({
      name: "IntegrationError",
      status: 500,
      retriable: true,
    });
    expect(calls).toHaveLength(3); // initial + 2 retries
  });
});

describe("TwentyClient", () => {
  const cfg = { url: "https://twenty.example.com", apiKey: "tk", enabled: true };

  it("upsertPerson searches by email then POSTs when not found", async () => {
    const { calls } = stubFetchSequence([
      { payload: { data: [] } }, // email search: no match
      { payload: { data: [] } }, // phone search: no match
      { payload: { data: { id: "person_1" } } }, // create
    ]);
    const client = new TwentyClient(cfg);
    const res = await client.upsertPerson(
      { email: "ada@example.com", phone: "+234801", firstName: "Ada", lastName: "Lovelace" },
      FAST,
    );
    expect(res.id).toBe("person_1");
    expect(calls).toHaveLength(3);
    expect(calls[0].url).toContain("/rest/people?filter=");
    expect(decodeURIComponent(calls[0].url)).toContain("emails.primaryEmail[eq]:ada@example.com");
    expect(decodeURIComponent(calls[1].url)).toContain("phones.primaryPhoneNumber[eq]:+234801");
    expect(calls[2].url).toBe("https://twenty.example.com/rest/people");
    expect((calls[2].init.headers as any)["Authorization"]).toBe("Bearer tk");
    const body = JSON.parse(String(calls[2].init.body));
    expect(body.name).toEqual({ firstName: "Ada", lastName: "Lovelace" });
    expect(body.emails.primaryEmail).toBe("ada@example.com");
    expect(body.phones.primaryPhoneNumber).toBe("+234801");
  });

  it("upsertPerson PATCHes when a match exists", async () => {
    const { calls } = stubFetchSequence([{ payload: { data: [{ id: "p9" }] } }, { payload: {} }]);
    const client = new TwentyClient(cfg);
    const res = await client.upsertPerson({ email: "x@y.z", firstName: "X" }, FAST);
    expect(res.id).toBe("p9");
    expect(calls[1].url).toBe("https://twenty.example.com/rest/people/p9");
    expect(calls[1].init.method).toBe("PATCH");
  });
});

describe("OdooClient", () => {
  const cfg = {
    url: "https://odoo.example.com",
    apiKey: "odoo-key",
    database: "shop",
    username: "admin",
    enabled: true,
  };

  it("upsertPartner authenticates, searches res.partner and creates when missing", async () => {
    const { calls } = stubFetchSequence([
      { payload: { result: 7 } }, // authenticate → uid
      { payload: { result: [] } }, // search → none
      { payload: { result: 42 } }, // create → id
    ]);
    const client = new OdooClient(cfg);
    const res = await client.upsertPartner(
      { name: "Ada", email: "ada@example.com", phone: "+234801", externalRef: "cust_1" },
      FAST,
    );
    expect(res.id).toBe(42);
    expect(calls).toHaveLength(3);
    for (const c of calls) expect(c.url).toBe("https://odoo.example.com/jsonrpc");
    const auth = JSON.parse(String(calls[0].init.body));
    expect(auth.params.service).toBe("common");
    expect(auth.params.method).toBe("authenticate");
    expect(auth.params.args.slice(0, 3)).toEqual(["shop", "admin", "odoo-key"]);
    const search = JSON.parse(String(calls[1].init.body));
    expect(search.params.service).toBe("object");
    expect(search.params.method).toBe("execute_kw");
    expect(search.params.args[3]).toBe("res.partner");
    expect(search.params.args[4]).toBe("search");
    const create = JSON.parse(String(calls[2].init.body));
    expect(create.params.args[4]).toBe("create");
    expect(create.params.args[5][0]).toMatchObject({ name: "Ada", email: "ada@example.com", ref: "cust_1" });
  });

  it("throws IntegrationError on JSON-RPC error payload", async () => {
    stubFetchSequence([
      { payload: { result: 7 } },
      { payload: { error: { message: "odoo exploded", data: { message: "odoo exploded" } } } },
    ]);
    const client = new OdooClient(cfg);
    await expect(
      client.createSaleOrder({ partnerId: 1, lines: [{ name: "x", quantity: 1, unitPrice: 2 }] }, FAST),
    ).rejects.toBeInstanceOf(IntegrationError);
  });
});

// ── Outbox dispatcher ────────────────────────────────────────────────────────

function makeEvent(overrides: Partial<IntegrationEvent> = {}): IntegrationEvent {
  return {
    id: crypto.randomUUID(),
    tenantId: "t1",
    system: "medusa",
    direction: "out",
    entity: "product",
    entityId: "p1",
    payload: { action: "created", origin: "platform", data: {} },
    status: "pending",
    attempts: 0,
    lastError: null,
    createdAt: new Date(),
    processedAt: null,
    ...overrides,
  } as IntegrationEvent;
}

function makeStore(rows: IntegrationEvent[]) {
  const delivered: string[] = [];
  const failures: Array<{ id: string; attempts: number; status: string; lastError: string }> = [];
  const store: OutboxDispatcherStore = {
    fetchPending: async (batch) => rows.slice(0, batch),
    markDelivered: async (id) => {
      delivered.push(id);
    },
    markFailure: async (id, attempts, lastError, status) => {
      failures.push({ id, attempts, lastError, status });
    },
  };
  return { store, delivered, failures };
}

describe("outbox dispatch", () => {
  it("delivers a pending event and marks it delivered", async () => {
    const ev = makeEvent();
    const { store, delivered, failures } = makeStore([ev]);
    const res = await dispatchOutbox(store, async () => {});
    expect(res).toEqual({ picked: 1, delivered: 1, retried: 0, failed: 0, dead: 0 });
    expect(delivered).toEqual([ev.id]);
    expect(failures).toHaveLength(0);
  });

  it("retriable failure increments attempts and keeps status pending", async () => {
    const ev = makeEvent();
    const { store, failures } = makeStore([ev]);
    const res = await dispatchOutbox(store, async () => {
      throw new IntegrationError("medusa", "HTTP 500", { status: 500, retriable: true });
    });
    expect(res.retried).toBe(1);
    expect(failures[0]).toMatchObject({ id: ev.id, attempts: 1, status: "pending", lastError: "HTTP 500" });
  });

  it("marks the event dead once attempts reach the cap", async () => {
    const ev = makeEvent({ attempts: MAX_OUTBOX_ATTEMPTS - 1 });
    const { store, failures } = makeStore([ev]);
    const res = await dispatchOutbox(store, async () => {
      throw new IntegrationError("odoo", "down", { retriable: true });
    });
    expect(res.dead).toBe(1);
    expect(failures[0]).toMatchObject({ attempts: MAX_OUTBOX_ATTEMPTS, status: "dead" });
  });

  it("non-retriable failure (4xx) is marked failed immediately", async () => {
    const ev = makeEvent();
    const { store, failures } = makeStore([ev]);
    const res = await dispatchOutbox(store, async () => {
      throw new IntegrationError("twenty", "HTTP 400", { status: 400, retriable: false });
    });
    expect(res.failed).toBe(1);
    expect(failures[0]).toMatchObject({ attempts: 1, status: "failed" });
  });

  it("honours the batch size", async () => {
    const rows = [makeEvent(), makeEvent(), makeEvent()];
    const { store } = makeStore(rows);
    const res = await dispatchOutbox(store, async () => {}, 2);
    expect(res.picked).toBe(2);
  });
});

// ── Loop guard ───────────────────────────────────────────────────────────────

describe("loop guard", () => {
  it("enqueueIntegrationEvent refuses origin='external' payloads", async () => {
    const insert = vi.fn();
    const db = { insert: () => ({ values: () => ({ returning: insert }) }) };
    const id = await enqueueIntegrationEvent(db, {
      tenantId: "t1",
      system: "medusa",
      entity: "product",
      entityId: "p1",
      action: "updated",
      data: {},
      origin: "external",
    });
    expect(id).toBeNull();
    expect(insert).not.toHaveBeenCalled();
  });

  it("enqueueIntegrationEvent inserts origin='platform' payloads as pending/out", async () => {
    const returning = vi.fn(async () => [{ id: "evt_1" }]);
    const values = vi.fn(() => ({ returning }));
    const db = { insert: vi.fn(() => ({ values })) };
    const id = await enqueueIntegrationEvent(db, {
      tenantId: "t1",
      system: "twenty",
      entity: "customer",
      entityId: "c1",
      action: "created",
      data: { name: "Ada" },
    });
    expect(id).toBe("evt_1");
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "t1",
        system: "twenty",
        direction: "out",
        status: "pending",
        attempts: 0,
        payload: expect.objectContaining({ origin: "platform", action: "created" }),
      }),
    );
  });

  it("inbound applier (twenty person) writes customers without touching integration_events outbox", async () => {
    const inserts: string[] = [];
    const updates: string[] = [];
    // minimal fake drizzle-ish db: select → no existing customer, insert → record
    const db: any = {
      select: () => ({
        from: () => ({ where: () => ({ limit: async () => [] }) }),
      }),
      insert: (table: any) => ({
        values: async (vals: any) => {
          inserts.push(vals.whatsappPhone ? "customers" : "other");
        },
      }),
      update: (table: any) => ({
        set: () => ({ where: async () => updates.push("updated") }),
      }),
    };
    const applied = await applyInboundEvent(db, {
      tenantId: "t1",
      system: "twenty",
      entity: "person",
      action: "updated",
      data: {
        id: "person_1",
        name: { firstName: "Ada", lastName: "L" },
        emails: { primaryEmail: "ada@example.com" },
        phones: { primaryPhoneNumber: "+234801" },
      },
    });
    expect(applied).toBe("created");
    expect(inserts).toEqual(["customers"]); // exactly one insert, into customers — never an outbox row
  });
});

// ── Inbound signature verification ───────────────────────────────────────────

describe("inbound webhook signature", () => {
  const raw = Buffer.from(JSON.stringify({ entity: "product", data: { id: "x" } }));

  it("accepts a valid HMAC-SHA256 hex signature (timingSafeEqual path)", () => {
    const sig = signForTest(raw, "s3cret");
    expect(verifyIntegrationSignature(raw, "s3cret", sig)).toBe(true);
  });

  it("accepts sha256=-prefixed signatures", () => {
    const sig = `sha256=${signForTest(raw, "s3cret")}`;
    expect(verifyIntegrationSignature(raw, "s3cret", sig)).toBe(true);
  });

  it("rejects a wrong secret and missing signature", () => {
    const sig = signForTest(raw, "wrong");
    expect(verifyIntegrationSignature(raw, "s3cret", sig)).toBe(false);
    expect(verifyIntegrationSignature(raw, "s3cret", undefined)).toBe(false);
  });

  it("rejects signatures of different length without throwing (length guard)", () => {
    expect(verifyIntegrationSignature(raw, "s3cret", "abcd")).toBe(false);
  });
});

function makeWebhookDb(config: unknown) {
  const recorded: any[] = [];
  const db: any = {
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => [{ settings: { integrations: { medusa: config } } }] }),
      }),
    }),
    insert: () => ({
      values: async (vals: any) => {
        recorded.push(vals);
      },
    }),
    update: () => ({ set: () => ({ where: () => ({ returning: async () => [] }) }) }),
  };
  return { db, recorded };
}

describe("handleIntegrationWebhook", () => {
  const secret = "whsec_test";
  const body = { entity: "product", action: "updated", data: { id: "mp1", title: "T", price: 5 } };
  const raw = Buffer.from(JSON.stringify(body));

  it("accepts a correctly signed request and records direction='in'", async () => {
    const { db, recorded } = makeWebhookDb({ url: "https://m", webhookSecret: secret });
    const res = await handleIntegrationWebhook("medusa", "t1", raw, signForTest(raw, secret), {
      db,
      isProduction: true,
    });
    expect(res.status).toBe(200);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      tenantId: "t1",
      system: "medusa",
      direction: "in",
      status: "delivered",
    });
    expect(recorded[0].payload.origin).toBe("external");
  });

  it("rejects a wrong signature with 401 when a secret is configured", async () => {
    const { db, recorded } = makeWebhookDb({ url: "https://m", webhookSecret: secret });
    const res = await handleIntegrationWebhook("medusa", "t1", raw, signForTest(raw, "nope"), {
      db,
      isProduction: true,
    });
    expect(res.status).toBe(401);
    expect(recorded).toHaveLength(0);
  });

  it("fails closed (503) in production when no webhookSecret is configured", async () => {
    const { db, recorded } = makeWebhookDb({ url: "https://m" });
    const res = await handleIntegrationWebhook("medusa", "t1", raw, undefined, { db, isProduction: true });
    expect(res.status).toBe(503);
    expect(recorded).toHaveLength(0);
  });

  it("rejects unknown systems and missing tenant", async () => {
    const { db } = makeWebhookDb({});
    expect((await handleIntegrationWebhook("shopify", "t1", raw, null, { db, isProduction: false })).status).toBe(400);
    expect((await handleIntegrationWebhook("medusa", null, raw, null, { db, isProduction: false })).status).toBe(400);
  });
});

// ── Router tenant isolation ──────────────────────────────────────────────────

function makeCtx(role: "admin" | "user", tenantId?: string): TrpcContext {
  return {
    user: {
      id: 1,
      openId: "test-user",
      email: "test@example.com",
      name: "Test User",
      loginMethod: "manus",
      role,
      tenantId: tenantId ?? null,
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSignedIn: new Date(),
    } as TrpcContext["user"],
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: () => {} } as unknown as TrpcContext["res"],
  };
}

describe("integrations router auth", () => {
  it("exposes all required procedures", () => {
    const procs = appRouter._def.procedures;
    for (const p of [
      "integrations.getConfig",
      "integrations.setConfig",
      "integrations.testConnection",
      "integrations.syncStatus",
      "integrations.resync",
      "integrations.listEvents",
    ]) {
      expect(p in procs).toBe(true);
    }
  });

  it("rejects cross-tenant access (FORBIDDEN) before touching the DB", async () => {
    const caller = appRouter.createCaller(makeCtx("user", "tenant-a"));
    await expect(caller.integrations.getConfig({ tenantId: "tenant-b", system: "medusa" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      caller.integrations.syncStatus({ tenantId: "tenant-b" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      caller.integrations.listEvents({ tenantId: "tenant-b" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects unauthenticated callers (UNAUTHORIZED)", async () => {
    const caller = appRouter.createCaller({ ...makeCtx("user", "t1"), user: null });
    await expect(caller.integrations.getConfig({ tenantId: "t1", system: "medusa" })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });
});
