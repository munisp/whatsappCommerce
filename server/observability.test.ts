/**
 * w10 observability — captureException sinks, ring buffer, redaction, and the
 * infra.systemRecentErrors admin procedure.
 *
 * fetch and process.stdout.write are mocked; ERROR_WEBHOOK_URL is set per
 * test and restored afterwards.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  captureException,
  getRecentErrors,
  redactExtra,
  _resetRecentErrors,
} from "./services/observability";
import { infraRouter } from "./routers/infra";

const ADMIN_CTX = { user: { id: 1, role: "admin", tenantId: null } } as any;
const USER_CTX = { user: { id: 2, role: "user", tenantId: "t1" } } as any;

const ORIGINAL_WEBHOOK = process.env.ERROR_WEBHOOK_URL;
let stdoutSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  _resetRecentErrors();
  delete process.env.ERROR_WEBHOOK_URL;
  stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(() => {
  stdoutSpy.mockRestore();
  vi.unstubAllGlobals();
  if (ORIGINAL_WEBHOOK === undefined) delete process.env.ERROR_WEBHOOK_URL;
  else process.env.ERROR_WEBHOOK_URL = ORIGINAL_WEBHOOK;
});

function lastStdoutLine(): any {
  const calls = stdoutSpy.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return JSON.parse(String(calls[calls.length - 1][0]));
}

describe("captureException — stdout sink", () => {
  it("emits one structured JSON line with the expected shape", () => {
    captureException(new Error("boom"), { service: "svc", operation: "op", tenantId: "t1" });
    const line = lastStdoutLine();
    expect(line.level).toBe("error"); // default severity
    expect(line.service).toBe("svc");
    expect(line.operation).toBe("op");
    expect(line.tenantId).toBe("t1");
    expect(line.message).toBe("boom");
    expect(typeof line.timestamp).toBe("string");
    expect(line.stack).toContain("boom");
  });

  it("converts non-Error values to a message and never throws", () => {
    expect(() => captureException("plain string", { service: "s", operation: "o" })).not.toThrow();
    expect(lastStdoutLine().message).toBe("plain string");
    expect(() => captureException(undefined, { service: "s", operation: "o" })).not.toThrow();
  });

  it("respects explicit severity (critical / warn)", () => {
    captureException(new Error("money"), { service: "s", operation: "o", severity: "critical" });
    expect(lastStdoutLine().severity).toBe("critical");
    expect(lastStdoutLine().level).toBe("critical");
    captureException(new Error("degraded"), { service: "s", operation: "o", severity: "warn" });
    expect(lastStdoutLine().severity).toBe("warn");
  });

  it("omits tenantId when not provided", () => {
    captureException(new Error("x"), { service: "s", operation: "o" });
    expect("tenantId" in lastStdoutLine()).toBe(false);
  });
});

describe("captureException — redaction", () => {
  it("redactExtra strips token/secret/password/authorization keys", () => {
    const out = redactExtra({
      token: "abc",
      accessToken: "abc",
      webhookSecret: "abc",
      dbPassword: "abc",
      Authorization: "Bearer x",
      orderId: "o1",
      nested: { apiToken: "t", safe: 1 },
      list: [{ password: "p", ok: true }],
    })!;
    expect(out.token).toBe("[redacted]");
    expect(out.accessToken).toBe("[redacted]");
    expect(out.webhookSecret).toBe("[redacted]");
    expect(out.dbPassword).toBe("[redacted]");
    expect(out.Authorization).toBe("[redacted]");
    expect(out.orderId).toBe("o1");
    expect((out.nested as any).apiToken).toBe("[redacted]");
    expect((out.nested as any).safe).toBe(1);
    expect((out.list as any)[0].password).toBe("[redacted]");
    expect((out.list as any)[0].ok).toBe(true);
  });

  it("redactExtra passes through undefined", () => {
    expect(redactExtra(undefined)).toBeUndefined();
  });

  it("stored + emitted records carry redacted extra", () => {
    captureException(new Error("b"), {
      service: "s", operation: "o",
      extra: { reference: "PAY-1", paystackSecret: "sk_live_x" },
    });
    const stored = getRecentErrors(1)[0];
    expect(stored.extra?.reference).toBe("PAY-1");
    expect(stored.extra?.paystackSecret).toBe("[redacted]");
    expect(JSON.stringify(lastStdoutLine())).not.toContain("sk_live_x");
  });
});

describe("captureException — webhook sink", () => {
  it("POSTs a Slack-compatible {text} payload when ERROR_WEBHOOK_URL is set", async () => {
    process.env.ERROR_WEBHOOK_URL = "https://hooks.example/xyz";
    const fetchSpy = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", fetchSpy);
    captureException(new Error("kaput"), {
      service: "integrations/outbox", operation: "dispatch.dlq",
      tenantId: "t9", severity: "critical", extra: { eventId: "e1", authToken: "sekrit" },
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as any;
    expect(url).toBe("https://hooks.example/xyz");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body);
    expect(typeof body.text).toBe("string");
    expect(body.text).toContain("[CRITICAL]");
    expect(body.text).toContain("integrations/outbox/dispatch.dlq");
    expect(body.text).toContain("tenant=t9");
    expect(body.text).toContain("kaput");
    expect(body.text).not.toContain("sekrit"); // sanitized payload
  });

  it("does not call fetch when ERROR_WEBHOOK_URL is unset", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    captureException(new Error("x"), { service: "s", operation: "o" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("swallows webhook delivery failures without throwing", async () => {
    process.env.ERROR_WEBHOOK_URL = "https://hooks.example/down";
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    expect(() => captureException(new Error("x"), { service: "s", operation: "o" })).not.toThrow();
    // Let the rejected promise settle — nothing should escape.
    await new Promise((r) => setTimeout(r, 10));
  });
});

describe("ring buffer", () => {
  it("getRecentErrors returns newest first and honours the limit", () => {
    for (let i = 0; i < 5; i++) captureException(new Error(`e${i}`), { service: "s", operation: "o" });
    const all = getRecentErrors(50);
    expect(all.map((r) => r.message)).toEqual(["e4", "e3", "e2", "e1", "e0"]);
    expect(getRecentErrors(2).map((r) => r.message)).toEqual(["e4", "e3"]);
  });

  it("caps at 200 entries (oldest evicted)", () => {
    for (let i = 0; i < 230; i++) captureException(new Error(`m${i}`), { service: "s", operation: "o" });
    const all = getRecentErrors(500);
    expect(all.length).toBe(200);
    expect(all[0].message).toBe("m229");
    expect(all[199].message).toBe("m30");
  });
});

describe("infra.systemRecentErrors procedure", () => {
  it("returns the captured errors (newest first) for admins", async () => {
    captureException(new Error("first"), { service: "a", operation: "x" });
    captureException(new Error("second"), { service: "b", operation: "y", severity: "critical" });
    const caller = infraRouter.createCaller(ADMIN_CTX);
    const res = await caller.systemRecentErrors({ limit: 10 });
    expect(res.capacity).toBe(200);
    expect(res.errors).toHaveLength(2);
    expect(res.errors[0].message).toBe("second");
    expect(res.errors[0].severity).toBe("critical");
    expect(res.errors[1].message).toBe("first");
  });

  it("works without input (default limit)", async () => {
    captureException(new Error("one"), { service: "a", operation: "x" });
    const caller = infraRouter.createCaller(ADMIN_CTX);
    const res = await caller.systemRecentErrors(undefined);
    expect(res.errors).toHaveLength(1);
  });

  it("rejects non-admin callers", async () => {
    const caller = infraRouter.createCaller(USER_CTX);
    await expect(caller.systemRecentErrors({ limit: 5 })).rejects.toThrow();
  });
});
