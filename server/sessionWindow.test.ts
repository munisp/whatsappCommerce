/**
 * Session-window manager tests: record/get boundaries, last-inbound map,
 * pending-payment expiry nudge (dedupe, text vs template path, admin flag).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./db", () => ({ getDb: vi.fn() }));
vi.mock("./redis", () => ({ getRedis: vi.fn().mockResolvedValue(null) }));
vi.mock("./services/waSender", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./services/waSender")>();
  return { ...orig, sendWhatsAppText: vi.fn(), sendWhatsAppTemplate: vi.fn() };
});

import { sendWhatsAppText, sendWhatsAppTemplate } from "./services/waSender";
import {
  getLastInboundMap,
  getWindow,
  recordInbound,
  runWindowExpiryCheck,
  WA_WINDOW_MS,
  __resetSessionWindowStoreForTests,
  __resetWindowFlagLedgerForTests,
} from "./services/sessionWindow";

function makeDb(opts: { executeRows?: any[]; selectQueues?: any[][] } = {}) {
  const execRows = [...(opts.executeRows ?? [])];
  const queues = (opts.selectQueues ?? []).map((q) => [...q]);
  const chain: any = {
    from: vi.fn(),
    where: vi.fn(),
    limit: vi.fn(() => {
      const q = queues.find((x) => x.length > 0);
      return Promise.resolve(q ? [q.shift()] : []);
    }),
    catch: vi.fn(() => Promise.resolve([])),
    then: (resolve: any, reject: any) =>
      Promise.resolve(queues.length > 0 ? queues.shift() : []).then(resolve, reject),
  };
  chain.from.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  const db: any = {
    select: vi.fn(() => chain),
    execute: vi.fn(() => Promise.resolve(execRows.shift() ?? { rows: [] })),
  };
  return db;
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetSessionWindowStoreForTests();
  __resetWindowFlagLedgerForTests();
  vi.mocked(sendWhatsAppText).mockResolvedValue({ sent: true, simulated: false, wamids: ["w1"], chunks: 1 });
  vi.mocked(sendWhatsAppTemplate).mockResolvedValue({ sent: true, simulated: false, wamid: "w2" });
});

describe("recordInbound + getWindow (in-memory fallback)", () => {
  it("opens a window on inbound and closes it after 24h", async () => {
    const db = makeDb();
    const t0 = new Date("2025-01-01T00:00:00Z");
    await recordInbound("t1", "+234 801 234 5678", t0);

    const open = await getWindow(db, "t1", "2348012345678", new Date(t0.getTime() + 60_000));
    expect(open.open).toBe(true);
    expect(open.source).toBe("memory");
    expect(open.closesAt?.getTime()).toBe(t0.getTime() + WA_WINDOW_MS);

    const closed = await getWindow(db, "t1", "2348012345678", new Date(t0.getTime() + WA_WINDOW_MS));
    expect(closed.open).toBe(false);
    expect(closed.closesAt).not.toBeNull();
  });

  it("boundary: 23h59m open, 24h00m closed", async () => {
    const db = makeDb();
    const t0 = new Date("2025-01-01T00:00:00Z");
    await recordInbound("t1", "111", t0);
    expect((await getWindow(db, "t1", "111", new Date(t0.getTime() + WA_WINDOW_MS - 60_000))).open).toBe(true);
    expect((await getWindow(db, "t1", "111", new Date(t0.getTime() + WA_WINDOW_MS))).open).toBe(false);
  });

  it("falls back to whatsapp_customer_replies when no marker exists", async () => {
    const lastAt = new Date(Date.now() - 60_000);
    const db = makeDb({ executeRows: [{ rows: [{ last_at: lastAt }] }] });
    const win = await getWindow(db, "t1", "999");
    expect(win.open).toBe(true);
    expect(win.source).toBe("replies");
    expect(win.closesAt?.getTime()).toBe(lastAt.getTime() + WA_WINDOW_MS);
  });

  it("returns closed/none when nothing was ever recorded", async () => {
    const db = makeDb({ executeRows: [{ rows: [] }] });
    const win = await getWindow(db, "t1", "999");
    expect(win).toEqual({ open: false, closesAt: null, lastInboundAt: null, source: "none" });
  });

  it("normalizes phones so formatting differences resolve to one window", async () => {
    const db = makeDb();
    await recordInbound("t1", "+1 (555) 010-0000", new Date());
    const win = await getWindow(db, "t1", "15550100000");
    expect(win.open).toBe(true);
  });
});

describe("getLastInboundMap", () => {
  it("builds a normalized phone → last-inbound map from the replies table", async () => {
    const db = makeDb({
      executeRows: [{ rows: [{ phone: "+234 801", last_at: "2025-01-01T00:00:00Z" }, { phone: "bad", last_at: null }] }],
    });
    const map = await getLastInboundMap(db, "t1");
    expect(map.get("234801")?.toISOString()).toBe("2025-01-01T00:00:00.000Z");
    expect(map.size).toBe(1);
  });

  it("returns an empty map when the table is missing (template sends)", async () => {
    const db: any = { execute: vi.fn().mockRejectedValue(new Error("relation does not exist")) };
    const map = await getLastInboundMap(db, "t1");
    expect(map.size).toBe(0);
  });
});

describe("runWindowExpiryCheck", () => {
  const oldOrder = {
    id: "o1",
    tenantId: "t1",
    customerId: "c1",
    orderNumber: "WAC-1",
    totalAmount: "100.00",
    currency: "USD",
    paymentStatus: "unpaid",
    createdAt: new Date(Date.now() - 21 * 3600_000),
  };
  const customer = { id: "c1", tenantId: "t1", whatsappPhone: "234801", name: "Ada", tags: null };

  /** db whose select queue serves: due orders → customer → tenant settings. */
  function expiryDb(settings: any, ordersRows: any[] = [oldOrder], customerRow: any = customer) {
    const selects: any[][] = [ordersRows, [customerRow], [{ settings }], [{ settings }]];
    const chain: any = {};
    const db: any = {
      select: vi.fn(() => {
        const rows = selects.shift() ?? [];
        const c: any = {
          from: vi.fn(),
          where: vi.fn(),
          limit: vi.fn(() => Promise.resolve(rows)),
          catch: vi.fn(() => Promise.resolve(rows)),
          then: (resolve: any) => Promise.resolve(rows).then(resolve),
        };
        c.from.mockReturnValue(c);
        c.where.mockReturnValue(c);
        return c;
      }),
      execute: vi.fn(() => Promise.resolve({ rows: [] })),
    };
    return db;
  }

  it("nudges via free-form text when the window is open but closing <4h, flags admin once", async () => {
    // Window opened 21h ago → closes in 3h (< 4h horizon).
    await recordInbound("t1", "234801", new Date(Date.now() - 21 * 3600_000));
    const settings = { adminPhone: "234900", broadcast: { templateName: "wac_broadcast" } };
    const db = expiryDb(settings);
    const res = await runWindowExpiryCheck(db);
    expect(res).toEqual({ scanned: 1, nudged: 1, flagged: 1 });
    expect(sendWhatsAppText).toHaveBeenCalledWith("t1", "234801", expect.stringContaining("WAC-1"), expect.objectContaining({ notifType: "window_expiry_nudge" }));
    expect(sendWhatsAppText).toHaveBeenCalledWith("t1", "234900", expect.stringContaining("unpaid"), expect.objectContaining({ notifType: "window_expiry_flag" }));
    expect(sendWhatsAppTemplate).not.toHaveBeenCalled();
  });

  it("nudges via template when the window is already closed", async () => {
    // No inbound recorded and replies fallback empty → closed window.
    const settings = { adminPhone: "234900", broadcast: { templateName: "wac_pay", languageCode: "en_US" } };
    const db = expiryDb(settings);
    const res = await runWindowExpiryCheck(db);
    expect(res.nudged).toBe(1);
    expect(sendWhatsAppTemplate).toHaveBeenCalledWith(
      "t1", "234801", "wac_pay", "en_US", expect.any(Array),
      expect.objectContaining({ notifType: "window_expiry_nudge" }),
    );
  });

  it("does not nudge when the window is comfortably open (>4h to close)", async () => {
    await recordInbound("t1", "234801", new Date(Date.now() - 2 * 3600_000)); // closes in 22h
    const db = expiryDb({ adminPhone: "234900" });
    const res = await runWindowExpiryCheck(db);
    expect(res).toEqual({ scanned: 1, nudged: 0, flagged: 0 });
    expect(sendWhatsAppText).not.toHaveBeenCalled();
    expect(sendWhatsAppTemplate).not.toHaveBeenCalled();
  });

  it("dedupes: a second run neither re-nudges nor re-flags", async () => {
    await recordInbound("t1", "234801", new Date(Date.now() - 21 * 3600_000));
    const settings = { adminPhone: "234900" };
    await runWindowExpiryCheck(expiryDb(settings));
    const res2 = await runWindowExpiryCheck(expiryDb(settings));
    expect(res2).toEqual({ scanned: 1, nudged: 0, flagged: 0 });
    expect(vi.mocked(sendWhatsAppText).mock.calls).toHaveLength(2); // first run only
  });

  it("skips orders without a customer phone", async () => {
    const db = expiryDb({ adminPhone: "234900" }, [oldOrder], null as any);
    // customer select returns []
    const res = await runWindowExpiryCheck(db);
    expect(res.nudged).toBe(0);
  });
});
