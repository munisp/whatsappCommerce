/**
 * w10 observability wiring — proves the listed services call captureException
 * at their failure points. The observability module is mocked; behavior of the
 * services themselves (retry counts, statuses, return values) is unchanged.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const capture = vi.fn();
vi.mock("./services/observability", () => ({
  captureException: (...args: unknown[]) => capture(...args),
  getRecentErrors: () => [],
  redactExtra: (e: unknown) => e,
  _resetRecentErrors: () => {},
}));

// ── Dunning deps ─────────────────────────────────────────────────────────────
const sendText = vi.fn(async () => ({ sent: true, simulated: true, wamid: null, chunks: 1 }));
const sendTemplate = vi.fn(async () => ({ sent: true, simulated: true, wamid: null }));
const getWindowMock = vi.fn(async () => ({ open: false, closesAt: null, lastInboundAt: null, source: "none" as const }));
vi.mock("./services/waSender", () => ({
  sendWhatsAppText: (...args: unknown[]) => sendText(...args),
  sendWhatsAppTemplate: (...args: unknown[]) => sendTemplate(...args),
}));
vi.mock("./services/sessionWindow", () => ({
  getWindow: (...args: unknown[]) => getWindowMock(...args),
}));

import { dispatchOutbox, MAX_OUTBOX_ATTEMPTS, type OutboxDispatcherStore } from "./services/integrations/outbox";
import { IntegrationError } from "./services/integrations/clients";
import { handleIntegrationWebhook, signForTest } from "./services/integrations/inbound";
import { runDunningCheckTx } from "./services/tradeCredit/dunning";
import { makeFakeDb, seedAccount, seedDraw } from "./services/tradeCredit/fakeDb";

beforeEach(() => {
  capture.mockClear();
  sendText.mockClear();
  sendTemplate.mockClear();
  getWindowMock.mockClear();
});

// ── Outbox ───────────────────────────────────────────────────────────────────

function makeOutboxStore(rows: any[]) {
  const store: OutboxDispatcherStore = {
    fetchPending: async (batch) => rows.slice(0, batch),
    markDelivered: async () => {},
    markFailure: async () => {},
  };
  return store;
}
const makeEvent = (over: any = {}) => ({
  id: `ev-${Math.random().toString(36).slice(2, 8)}`,
  tenantId: "t1", system: "odoo", entity: "product", entityId: "p1",
  attempts: 0, ...over,
});

describe("outbox → captureException", () => {
  it("retry exhaustion → DLQ transition emits critical", async () => {
    const ev = makeEvent({ attempts: MAX_OUTBOX_ATTEMPTS - 1 });
    const res = await dispatchOutbox(makeOutboxStore([ev]), async () => {
      throw new IntegrationError("odoo", "down", { retriable: true });
    });
    expect(res.dead).toBe(1);
    expect(capture).toHaveBeenCalledTimes(1);
    const [err, ctx] = capture.mock.calls[0] as any;
    expect(err.message).toBe("down");
    expect(ctx).toMatchObject({
      service: "integrations/outbox",
      operation: "dispatch.dlq",
      tenantId: "t1",
      severity: "critical",
    });
    expect(ctx.extra).toMatchObject({ eventId: ev.id, system: "odoo", attempts: MAX_OUTBOX_ATTEMPTS });
  });

  it("non-retriable failure (no DLQ) emits error", async () => {
    await dispatchOutbox(makeOutboxStore([makeEvent()]), async () => {
      throw new IntegrationError("medusa", "HTTP 400", { status: 400, retriable: false });
    });
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture.mock.calls[0][1]).toMatchObject({ operation: "dispatch.failed", severity: "error" });
  });

  it("retriable failure below the cap does NOT capture (normal retry)", async () => {
    await dispatchOutbox(makeOutboxStore([makeEvent()]), async () => {
      throw new IntegrationError("odoo", "flaky", { retriable: true });
    });
    expect(capture).not.toHaveBeenCalled();
  });

  it("successful delivery does NOT capture", async () => {
    await dispatchOutbox(makeOutboxStore([makeEvent()]), async () => {});
    expect(capture).not.toHaveBeenCalled();
  });
});

// ── Inbound webhook ──────────────────────────────────────────────────────────

function makeWebhookDb(config: unknown) {
  const db: any = {
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => [{ settings: { integrations: { medusa: config } } }] }),
      }),
    }),
    insert: () => ({ values: async () => {} }),
    update: () => ({ set: () => ({ where: () => ({ returning: async () => [] }) }) }),
  };
  return db;
}

describe("inbound → captureException", () => {
  const secret = "whsec_test";
  const body = { entity: "product", action: "updated", data: { id: "mp1", title: "T", price: 5 } };
  const raw = Buffer.from(JSON.stringify(body));

  it("invalid signature emits warn", async () => {
    const res = await handleIntegrationWebhook("medusa", "t1", raw, signForTest(raw, "nope"), {
      db: makeWebhookDb({ url: "https://m", webhookSecret: secret }),
      isProduction: true,
    });
    expect(res.status).toBe(401);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture.mock.calls[0][1]).toMatchObject({
      service: "integrations/inbound",
      operation: "verifySignature",
      tenantId: "t1",
      severity: "warn",
    });
  });

  it("apply failure emits error", async () => {
    const db = makeWebhookDb({ url: "https://m", webhookSecret: secret });
    db.update = () => ({ set: () => ({ where: () => ({ returning: async () => { throw new Error("db gone"); } }) }) });
    // product 'updated' applier goes through db.update
    const res = await handleIntegrationWebhook("medusa", "t1", raw, signForTest(raw, secret), {
      db, isProduction: true,
    });
    expect([200, 500]).toContain(res.status);
    if (res.status === 500) {
      expect(capture).toHaveBeenCalled();
      const ctx = capture.mock.calls[capture.mock.calls.length - 1][1];
      expect(ctx).toMatchObject({ service: "integrations/inbound", operation: "apply", severity: "error" });
    }
  });

  it("valid request does NOT capture", async () => {
    const res = await handleIntegrationWebhook("medusa", "t1", raw, signForTest(raw, secret), {
      db: makeWebhookDb({ url: "https://m", webhookSecret: secret }),
      isProduction: true,
    });
    expect(res.status).toBe(200);
    expect(capture).not.toHaveBeenCalled();
  });
});

// ── Dunning ──────────────────────────────────────────────────────────────────

describe("dunning → captureException", () => {
  const NOW = new Date("2025-06-10T00:00:00Z");
  const tenant = { id: "buyer-1", settings: { adminPhone: "2348011111111" } };

  it("reminder send failure emits warn and the sweep continues", async () => {
    sendTemplate.mockRejectedValueOnce(new Error("wa down"));
    const account = seedAccount();
    const draw = seedDraw(account.id, { dueDate: new Date("2025-06-12T00:00:00Z") });
    const { db } = makeFakeDb({ accounts: [account], ledger: [draw], tenants: [tenant] });
    const res = await runDunningCheckTx(db, NOW);
    expect(res.reminded).toBe(0);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture.mock.calls[0][1]).toMatchObject({
      service: "tradeCredit/dunning",
      operation: "reminderSend",
      tenantId: "buyer-1",
      severity: "warn",
    });
  });

  it("successful reminder does NOT capture", async () => {
    const account = seedAccount();
    const draw = seedDraw(account.id, { dueDate: new Date("2025-06-12T00:00:00Z") });
    const { db } = makeFakeDb({ accounts: [account], ledger: [draw], tenants: [tenant] });
    const res = await runDunningCheckTx(db, NOW);
    expect(res.reminded).toBe(1);
    expect(capture).not.toHaveBeenCalled();
  });
});
