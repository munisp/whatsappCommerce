/**
 * waSender reliability — unit tests
 * Delivery/read status pipeline, send retry + dead-letter, read receipts,
 * location request sender, wamid persistence.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("./db", () => ({ getDb: vi.fn() }));
vi.mock("./services/metering", () => ({ recordUsage: vi.fn().mockResolvedValue(1) }));
vi.mock("./services/consent", () => ({ hasConsent: vi.fn().mockResolvedValue(true) }));

import { getDb } from "./db";
import { hasConsent } from "./services/consent";
import { tenants } from "../drizzle/schema";
import {
  applyWaDeliveryStatus,
  classifyWaSendError,
  retryBackoffMs,
  runWaSendRetries,
  markMessageRead,
  sendWhatsAppLocationRequest,
  sendWhatsAppText,
  WA_RETRY_BACKOFF_MS,
  WA_RETRY_MAX_ATTEMPTS,
} from "./services/waSender";

const TENANT_ROW = {
  phoneNumberId: "pn-1",
  settings: { whatsapp: { accessToken: "tok" }, adminPhone: "23480999000" },
};

function okFetch(wamid = "wamid.new") {
  return { ok: true, status: 200, json: async () => ({ messages: [{ id: wamid }] }), text: async () => "" };
}
function errFetch(status: number, body = '{"error":{"title":"boom"}}') {
  return { ok: false, status, json: async () => ({}), text: async () => body };
}

interface FakeDbOpts {
  tenantRow?: unknown | null;
  /** rows returned by the retry due-select */
  logRows?: any[];
  /** what update().returning() resolves to (status pipeline) */
  updateReturning?: any[];
}

function makeDb(opts: FakeDbOpts = {}) {
  const inserts: any[] = [];
  const updates: Array<{ set: any; returning?: any[] }> = [];
  const db: any = {
    select: () => ({
      from: (table: unknown) => ({
        where: () => {
          const isTenants = table === tenants;
          const rows = isTenants ? (opts.tenantRow ? [opts.tenantRow] : []) : (opts.logRows ?? []);
          const p: any = Promise.resolve(rows);
          p.limit = (n: number) => Promise.resolve(rows.slice(0, n));
          return p;
        },
      }),
    }),
    insert: () => ({
      values: (v: any) => {
        inserts.push(v);
        return Promise.resolve([]);
      },
    }),
    update: () => ({
      set: (s: any) => ({
        where: () => {
          const entry = { set: s, returning: opts.updateReturning ?? [] };
          updates.push(entry);
          const p: any = Promise.resolve([]);
          p.returning = () => Promise.resolve(entry.returning);
          return p;
        },
      }),
    }),
  };
  (getDb as any).mockResolvedValue(db);
  return { db, inserts, updates };
}

describe("classifyWaSendError / retryBackoffMs", () => {
  it("classifies 5xx and 429 as retriable", () => {
    expect(classifyWaSendError(500)).toBe("retriable");
    expect(classifyWaSendError(503)).toBe("retriable");
    expect(classifyWaSendError(429)).toBe("retriable");
  });
  it("classifies network errors (no status) as retriable", () => {
    expect(classifyWaSendError(null, new Error("socket hangup"))).toBe("retriable");
    expect(classifyWaSendError(undefined)).toBe("retriable");
  });
  it("classifies 4xx template/recipient errors as permanent", () => {
    expect(classifyWaSendError(400)).toBe("permanent");
    expect(classifyWaSendError(401)).toBe("permanent");
    expect(classifyWaSendError(404)).toBe("permanent");
  });
  it("backoff schedule is 1m, 5m, 15m, 1h", () => {
    expect([...WA_RETRY_BACKOFF_MS]).toEqual([60_000, 300_000, 900_000, 3_600_000]);
    expect(retryBackoffMs(1)).toBe(60_000);
    expect(retryBackoffMs(2)).toBe(300_000);
    expect(retryBackoffMs(3)).toBe(900_000);
    expect(retryBackoffMs(4)).toBe(3_600_000);
    expect(WA_RETRY_MAX_ATTEMPTS).toBe(4);
  });
});

describe("applyWaDeliveryStatus (status pipeline)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("applies sent → delivered → read transitions by wamid", async () => {
    for (const status of ["sent", "delivered", "read"] as const) {
      const { updates } = makeDb({ updateReturning: [{ id: "log-1" }] });
      const db = await (getDb as any)();
      const matched = await applyWaDeliveryStatus(db, "t1", {
        id: "wamid.1",
        status,
        timestamp: "1786600000",
      });
      expect(matched).toBe(true);
      const set = updates[0].set;
      expect(set.status).toBe(status);
      const tsCol = status === "sent" ? set.sentAt : status === "delivered" ? set.deliveredAt : set.readAt;
      expect(tsCol).toEqual(new Date(1786600000 * 1000));
    }
  });

  it("records the full error payload on failed deliveries", async () => {
    const { updates } = makeDb({ updateReturning: [{ id: "log-1" }] });
    const db = await (getDb as any)();
    const matched = await applyWaDeliveryStatus(db, "t1", {
      id: "wamid.1",
      status: "failed",
      timestamp: "1786600000",
      errors: [{ code: 131047, title: "Re-engagement required" }],
    });
    expect(matched).toBe(true);
    const set = updates[0].set;
    expect(set.status).toBe("failed");
    expect(set.failedAt).toEqual(new Date(1786600000 * 1000));
    expect(set.failReason).toBe("Re-engagement required");
    expect(set.errorText).toContain("131047");
    expect(set.errorText).toContain("Re-engagement required");
  });

  it("ignores unknown wamids quietly", async () => {
    makeDb({ updateReturning: [] });
    const db = await (getDb as any)();
    const matched = await applyWaDeliveryStatus(db, "t1", { id: "wamid.unknown", status: "delivered", timestamp: "1786600000" });
    expect(matched).toBe(false);
  });

  it("ignores malformed entries", async () => {
    makeDb({ updateReturning: [{ id: "log-1" }] });
    const db = await (getDb as any)();
    expect(await applyWaDeliveryStatus(db, "t1", { id: "", status: "read" })).toBe(false);
    expect(await applyWaDeliveryStatus(db, "t1", { id: "wamid.1", status: "bogus" })).toBe(false);
  });
});

describe("runWaSendRetries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (hasConsent as any).mockResolvedValue(true);
  });
  afterEach(() => vi.unstubAllGlobals());

  const dueRow = (over: Record<string, unknown> = {}) => ({
    id: "log-1",
    tenantId: "t1",
    phone: "23480123456",
    notifType: "template_message",
    orderId: null,
    userId: null,
    status: "failed",
    attempts: 1,
    nextRetryAt: new Date(Date.now() - 1000),
    payload: { type: "text", text: { preview_url: true, body: "hello" } },
    wamid: null,
    ...over,
  });

  it("re-sends due retriable rows and marks them sent with the new wamid", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okFetch("wamid.retried")));
    const { updates } = makeDb({ tenantRow: TENANT_ROW, logRows: [dueRow()] });
    const res = await runWaSendRetries();
    expect(res).toMatchObject({ due: 1, resent: 1, retried: 0, dead: 0, skipped: 0 });
    expect(updates[0].set.status).toBe("sent");
    expect(updates[0].set.wamid).toBe("wamid.retried");
    expect(updates[0].set.nextRetryAt).toBeNull();
    expect(updates[0].set.attempts).toBe(2);
  });

  it("schedules the next backoff on continued retriable failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(errFetch(500)));
    const now = new Date("2030-01-01T00:00:00Z");
    const { updates } = makeDb({ tenantRow: TENANT_ROW, logRows: [dueRow({ attempts: 1 })] });
    const res = await runWaSendRetries({ now });
    expect(res.retried).toBe(1);
    expect(updates[0].set.status).toBe("failed");
    expect(updates[0].set.attempts).toBe(2);
    expect(updates[0].set.nextRetryAt).toEqual(new Date(now.getTime() + 300_000)); // 5m
  });

  it("dead-letters after the 4th attempt and alerts the tenant admin", async () => {
    const fetchMock = vi.fn().mockResolvedValue(errFetch(500, "internal error"));
    vi.stubGlobal("fetch", fetchMock);
    const { updates } = makeDb({ tenantRow: TENANT_ROW, logRows: [dueRow({ attempts: 3 })] });
    const res = await runWaSendRetries();
    expect(res.dead).toBe(1);
    expect(updates[0].set.status).toBe("dead");
    expect(updates[0].set.nextRetryAt).toBeNull();
    // Admin alert: a second Graph call to settings.adminPhone mentioning recipient + error
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const alertBody = JSON.parse((fetchMock.mock.calls[1] as any)[1].body);
    expect(alertBody.to).toBe("23480999000");
    expect(alertBody.text.body).toContain("23480123456");
    expect(alertBody.text.body).toContain("internal error");
  });

  it("dead-letters permanent (4xx) failures immediately without more retries", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(errFetch(400, "template rejected")));
    const { updates } = makeDb({ tenantRow: TENANT_ROW, logRows: [dueRow({ attempts: 1 })] });
    const res = await runWaSendRetries();
    expect(res.dead).toBe(1);
    expect(res.retried).toBe(0);
    expect(updates[0].set.status).toBe("dead");
  });

  it("never retries consent-blocked recipients", async () => {
    (hasConsent as any).mockResolvedValue(false);
    const fetchMock = vi.fn().mockResolvedValue(okFetch());
    vi.stubGlobal("fetch", fetchMock);
    const { updates } = makeDb({ tenantRow: TENANT_ROW, logRows: [dueRow()] });
    const res = await runWaSendRetries();
    expect(res.skipped).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(updates[0].set.nextRetryAt).toBeNull();
  });

  it("clears the schedule for rows without a replayable payload", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { updates } = makeDb({ tenantRow: TENANT_ROW, logRows: [dueRow({ payload: null })] });
    const res = await runWaSendRetries();
    expect(res.skipped).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(updates[0].set.nextRetryAt).toBeNull();
  });

  it("returns zeros when the DB is unavailable", async () => {
    (getDb as any).mockResolvedValue(null);
    const res = await runWaSendRetries();
    expect(res).toEqual({ due: 0, retried: 0, resent: 0, dead: 0, skipped: 0 });
  });
});

describe("markMessageRead", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it("POSTs the read receipt payload with tenant creds", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okFetch());
    vi.stubGlobal("fetch", fetchMock);
    makeDb({ tenantRow: TENANT_ROW });
    const ok = await markMessageRead("t1", "wamid.inbound.1");
    expect(ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as any;
    expect(url).toBe("https://graph.facebook.com/v21.0/pn-1/messages");
    expect(init.headers.Authorization).toBe("Bearer tok");
    expect(JSON.parse(init.body)).toEqual({
      messaging_product: "whatsapp",
      status: "read",
      message_id: "wamid.inbound.1",
    });
  });

  it("never throws on network failure, API failure, or missing creds", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("boom")));
    makeDb({ tenantRow: TENANT_ROW });
    await expect(markMessageRead("t1", "wamid.x")).resolves.toBe(false);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(errFetch(400)));
    await expect(markMessageRead("t1", "wamid.x")).resolves.toBe(false);

    makeDb({ tenantRow: null });
    await expect(markMessageRead("t1", "wamid.x")).resolves.toBe(false);
    await expect(markMessageRead("t1", "")).resolves.toBe(false);
  });
});

describe("sendWhatsAppLocationRequest", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it("sends an interactive location_request_message payload", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okFetch("wamid.loc"));
    vi.stubGlobal("fetch", fetchMock);
    const { inserts } = makeDb({ tenantRow: TENANT_ROW });
    const res = await sendWhatsAppLocationRequest("t1", "+234 801 234 56", "Where should we deliver?");
    expect(res).toEqual({ sent: true, simulated: false, wamid: "wamid.loc" });
    const body = JSON.parse((fetchMock.mock.calls[0] as any)[1].body);
    expect(body.to).toBe("23480123456");
    expect(body.type).toBe("interactive");
    expect(body.interactive.type).toBe("location_request_message");
    expect(body.interactive.action).toEqual({ name: "send_location" });
    expect(body.interactive.body.text).toBe("Where should we deliver?");
    // Logged with the replayable payload for the retry path
    expect(inserts[0].wamid).toBe("wamid.loc");
    expect(inserts[0].payload.interactive.type).toBe("location_request_message");
  });
});

describe("wamid persistence on send", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it("persists the returned messages[0].id and payload on text send", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okFetch("wamid.text.1")));
    const { inserts } = makeDb({ tenantRow: TENANT_ROW });
    const res = await sendWhatsAppText("t1", "23480123456", "hi");
    expect(res.wamids).toEqual(["wamid.text.1"]);
    expect(inserts[0].status).toBe("sent");
    expect(inserts[0].wamid).toBe("wamid.text.1");
    expect(inserts[0].payload.text.body).toBe("hi");
  });

  it("logs retriable failures with nextRetryAt; permanent without", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(errFetch(503)));
    let insp = makeDb({ tenantRow: TENANT_ROW });
    await expect(sendWhatsAppText("t1", "23480123456", "hi")).rejects.toThrow();
    expect(insp.inserts[0].status).toBe("failed");
    expect(insp.inserts[0].nextRetryAt).toBeInstanceOf(Date);
    expect(insp.inserts[0].attempts).toBe(1);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(errFetch(400)));
    insp = makeDb({ tenantRow: TENANT_ROW });
    await expect(sendWhatsAppText("t1", "23480123456", "hi")).rejects.toThrow();
    expect(insp.inserts[0].status).toBe("failed");
    expect(insp.inserts[0].nextRetryAt).toBeNull();
  });
});
