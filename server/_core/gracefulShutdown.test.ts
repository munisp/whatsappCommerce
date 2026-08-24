/**
 * Graceful shutdown tests (assurance A4-11).
 *
 * Covers:
 *   - SIGTERM/SIGINT handlers are registered and trigger a drain
 *   - drain: server.close() awaited, in-flight grace honored, then exit(0)
 *   - grace expiry force-closes connections and still exits
 *   - shutdown is idempotent (double signal → single drain)
 *   - unhandledRejection: CRITICAL capture; non-prod keeps process alive,
 *     prod drains + exits non-zero
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "events";

vi.mock("../services/observability", () => ({ captureException: vi.fn() }));
// closeInfraHandles probes these; keep them inert in unit tests.
vi.mock("../db", () => ({ getDb: vi.fn().mockResolvedValue(null) }));
vi.mock("../redis", () => ({ getRedis: vi.fn().mockResolvedValue(null) }));

import { captureException } from "../services/observability";
import { registerGracefulShutdown } from "./gracefulShutdown";

function fakeServer() {
  const server = new EventEmitter() as any;
  server.close = vi.fn((cb?: () => void) => { cb?.(); return server; });
  server.closeAllConnections = vi.fn();
  server.closeIdleConnections = vi.fn();
  return server;
}

const controllers: Array<{ unregister: () => void }> = [];
function register(server: any, opts: any = {}) {
  const c = registerGracefulShutdown(server, opts);
  controllers.push(c);
  return c;
}

afterEach(() => {
  while (controllers.length) controllers.pop()!.unregister();
  vi.clearAllMocks();
});

describe("registerGracefulShutdown", () => {
  it("registers SIGTERM/SIGINT/unhandledRejection/uncaughtException handlers and unregister removes them", () => {
    const before = {
      sigterm: process.listenerCount("SIGTERM"),
      sigint: process.listenerCount("SIGINT"),
      rej: process.listenerCount("unhandledRejection"),
      exc: process.listenerCount("uncaughtException"),
    };
    const c = register(fakeServer(), { exit: vi.fn() });
    expect(process.listenerCount("SIGTERM")).toBe(before.sigterm + 1);
    expect(process.listenerCount("SIGINT")).toBe(before.sigint + 1);
    expect(process.listenerCount("unhandledRejection")).toBe(before.rej + 1);
    expect(process.listenerCount("uncaughtException")).toBe(before.exc + 1);
    c.unregister();
    expect(process.listenerCount("SIGTERM")).toBe(before.sigterm);
  });

  it("SIGTERM drains in-flight requests then exits 0", async () => {
    const server = fakeServer();
    const exit = vi.fn();
    register(server, { exit, drainMs: 50 });
    process.emit("SIGTERM", "SIGTERM");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(server.close).toHaveBeenCalled();
  });

  it("force-closes connections and exits when drain exceeds the grace window", async () => {
    const server = fakeServer();
    server.close = vi.fn(() => server); // never calls back → stuck drain
    const exit = vi.fn();
    register(server, { exit, drainMs: 30 });
    process.emit("SIGINT", "SIGINT");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0), { timeout: 2000 });
    expect(server.closeAllConnections).toHaveBeenCalled();
  });

  it("shutdown is idempotent — a second signal does not re-drain", async () => {
    const server = fakeServer();
    const exit = vi.fn();
    const c = register(server, { exit, drainMs: 50 });
    await c.shutdown("test", 0);
    await c.shutdown("test-again", 0);
    expect(server.close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("unhandledRejection is captured CRITICAL and kept alive outside prod", async () => {
    // vitest runs NODE_ENV=test → isProd=false → log-only, no exit.
    const exit = vi.fn();
    register(fakeServer(), { exit, drainMs: 20 });
    const err = new Error("boom-rejection");
    process.emit("unhandledRejection", err, Promise.reject(err).catch(() => {}));
    expect(captureException).toHaveBeenCalledWith(
      err,
      expect.objectContaining({ operation: "unhandledRejection", severity: "critical" }),
    );
    await new Promise((r) => setTimeout(r, 60));
    expect(exit).not.toHaveBeenCalled();
  });
});

describe("unhandledRejection in production", () => {
  it("captures CRITICAL and drains + exits non-zero", async () => {
    const saved = { ...process.env };
    process.env.NODE_ENV = "production";
    process.env.DATABASE_URL = "postgres://x";
    process.env.JWT_SECRET = "a-strong-secret";
    process.env.KEYCLOAK_URL = "https://kc.example";
    process.env.APP_URL = "https://app.example";
    process.env.REDIS_URL = "redis://localhost:6379";
    process.env.SECRETS_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
    process.env.KYC_SERVICE_API_KEY = "kyc-live-test-key";
    process.env.WHATSAPP_VERIFY_TOKEN = "wa-verify-test-token-0123456789";
    process.env.USSD_GATEWAY_SECRET = "ussd-test-secret"; // W30 merge: D's /ussd prod boot gate
    process.env.INTERNAL_API_KEY = "internal-test-key"; // W30 merge: E's REQUIRED_BY_ENV
    vi.resetModules();
    try {
      const { registerGracefulShutdown: registerProd } = await import("./gracefulShutdown");
      const server = fakeServer();
      const exit = vi.fn();
      const c = registerProd(server, { exit, drainMs: 30 });
      controllers.push(c);
      const err = new Error("prod-rejection");
      process.emit("unhandledRejection", err, Promise.reject(err).catch(() => {}));
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1), { timeout: 2000 });
      expect(captureException).toHaveBeenCalledWith(
        err,
        expect.objectContaining({ operation: "unhandledRejection", severity: "critical" }),
      );
    } finally {
      process.env = saved;
      vi.resetModules();
    }
  });
});
