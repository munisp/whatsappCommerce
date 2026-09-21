/**
 * QA-040: load shedding. The decisions are pure and deterministic (lag and randomness are injected); the one real-world
 * check is that the lag sampler actually sees a blocked event loop, because a sampler that always reports 0 would make
 * every other test here pass while protecting nothing.
 */
import { describe, it, expect, afterEach } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import {
  createLoadShedMiddleware, isLoadShedExempt, shedProbability, startEventLoopLagSampler, positiveNumberFromEnv, LOAD_SHED_EXEMPT_PREFIXES,
} from "./loadShed";

describe("shedProbability", () => {
  it.each([
    [0, 0], [50, 0], [200, 0], // at or below the start: nothing shed
    [600, 0.5], [400, 0.25], [800, 0.75], // linear in between
    [1000, 1], [5000, 1], // at or past `all`: everything
  ])("lag %d ms (start 200, all 1000) -> %d", (lag, want) => {
    expect(shedProbability(lag, 200, 1000)).toBeCloseTo(want, 10);
  });

  it("fails OPEN on anything that is not a usable number", () => {
    expect(shedProbability(NaN, 200, 1000)).toBe(0);
    expect(shedProbability(undefined as any, 200, 1000)).toBe(0);
    expect(shedProbability(-5, 200, 1000)).toBe(0);
    expect(shedProbability(Infinity, 200, 1000)).toBe(1); // a genuinely infinite stall is overload, not noise
  });

  it("a misconfigured window (all <= start) sheds nothing rather than dividing by zero", () => {
    expect(shedProbability(500, 300, 300)).toBe(0);
    expect(shedProbability(500, 300, 100)).toBe(0);
  });
});

describe("isLoadShedExempt", () => {
  it.each([
    "/health", "/health/ready", "/health/anything",
    "/api/metrics",
    "/api/webhooks/paystack", "/api/webhooks/whatsapp", "/api/webhooks/payments/paystack",
    "/integrations/shopify/webhook",
    "/api/internal/events", "/api/internal/sweeps",
    "/api/scheduled/cart-recovery",
  ])("never sheds %s", (path) => expect(isLoadShedExempt(path)).toBe(true));

  it.each([
    "/", "/api/trpc/auth.me", "/api/trpc/payment.initiate", "/api/storage/x", "/orders", "/api/finetune/stream",
  ])("does shed %s", (path) => expect(isLoadShedExempt(path)).toBe(false));

  it.each([
    "/healthz", "/health-check-evil", "/api/metricsx", "/api/webhooks", "/api/webhooks-evil/x", "/integrationsx/y", "/api/internalx/z",
  ])("look-alike %s is NOT exempt (prefixes match on the boundary)", (path) => expect(isLoadShedExempt(path)).toBe(false));

  it("a path that climbs out of an exempt prefix is not exempt", () => {
    expect(isLoadShedExempt("/api/webhooks/../trpc/payment.initiate")).toBe(false);
    expect(isLoadShedExempt("/health/../api/trpc/x")).toBe(false);
  });

  it("every exempt prefix is written on a boundary (a bare prefix with no slash is an exact-path exemption)", () => {
    for (const p of LOAD_SHED_EXEMPT_PREFIXES) expect(p === "/api/metrics" || p.endsWith("/"), p).toBe(true);
  });
});

// ── the middleware, in a real express app ─────────────────────────────────────────────────────────────────────────
let server: Server | undefined;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

async function appWith(opts: Parameters<typeof createLoadShedMiddleware>[0]) {
  const hits: string[] = [];
  const app = express();
  app.use(createLoadShedMiddleware(opts));
  app.use((req, res) => { hits.push(req.path); res.json({ ok: true }); });
  await new Promise<void>((r) => { server = app.listen(0, "127.0.0.1", () => r()); });
  return { base: `http://127.0.0.1:${(server!.address() as AddressInfo).port}`, hits };
}

describe("createLoadShedMiddleware", () => {
  it("passes everything through while the loop is healthy", async () => {
    const { base, hits } = await appWith({ lagMs: () => 20, random: () => 0 });
    const r = await fetch(`${base}/api/trpc/auth.me`);
    expect(r.status).toBe(200);
    expect(hits).toEqual(["/api/trpc/auth.me"]);
  });

  it("refuses with 503 + Retry-After + a JSON body when the loop is overloaded, and the handler never runs", async () => {
    const { base, hits } = await appWith({ lagMs: () => 5000, random: () => 0.99, retryAfterSeconds: 2 });
    const r = await fetch(`${base}/api/trpc/payment.initiate`);
    expect(r.status).toBe(503);
    expect(r.headers.get("retry-after")).toBe("2");
    expect(await r.json()).toMatchObject({ error: "overloaded", retryAfterSeconds: 2 });
    expect(hits, "a shed request must not reach the application").toEqual([]);
  });

  it("NEVER sheds health, metrics, webhooks or internal callers, however bad the lag", async () => {
    const { base, hits } = await appWith({ lagMs: () => 1e9, random: () => 0 });
    for (const path of ["/health", "/health/ready", "/api/metrics", "/api/webhooks/paystack", "/integrations/x/webhook", "/api/internal/events", "/api/scheduled/foo"]) {
      const r = await fetch(`${base}${path}`, { method: path.startsWith("/api/webhooks") || path.startsWith("/api/internal") ? "POST" : "GET" });
      expect(r.status, path).toBe(200);
    }
    expect(hits).toHaveLength(7);
  });

  it("sheds in proportion to the overload: at 50% probability a low draw is refused and a high draw is served", async () => {
    let draw = 0.4;
    const { base } = await appWith({ lagMs: () => 600, startMs: 200, allMs: 1000, random: () => draw });
    expect((await fetch(`${base}/api/trpc/x`)).status).toBe(503);
    draw = 0.6;
    expect((await fetch(`${base}/api/trpc/x`)).status).toBe(200);
  });

  it("reports each shed request to onShed, and a throwing onShed cannot break the 503", async () => {
    let n = 0;
    const { base } = await appWith({ lagMs: () => 5000, random: () => 0, onShed: () => { n++; throw new Error("metrics down"); } });
    const r = await fetch(`${base}/api/trpc/x`);
    expect(r.status).toBe(503);
    expect(n).toBe(1);
  });

  it("fails open: a sampler that throws sheds nothing", async () => {
    const { base } = await appWith({ lagMs: () => { throw new Error("sampler broke"); }, random: () => 0 });
    expect((await fetch(`${base}/api/trpc/x`)).status).toBe(200);
  });
});

describe("startEventLoopLagSampler — it must actually SEE a blocked loop", () => {
  it("reports a large value after the loop is blocked", async () => {
    const s = startEventLoopLagSampler(60);
    try {
      await new Promise((r) => setTimeout(r, 200));
      const idle = s.lagMs(); // NOT asserted against a fixed number: on a loaded CI box "idle" lag is not ~0, and a
                              // timing test that fails when the machine is busy is exactly the flake this suite fought.

      const until = Date.now() + 300; // block the event loop for 300 ms
      while (Date.now() < until) { /* spin */ }
      // lagMs() is the LAST COMPLETED window (that is the point: it is what the next request should react to), and
      // the stall lives in exactly one of these 60 ms windows — so watch for the peak rather than one instant.
      let peak = 0;
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 30));
        peak = Math.max(peak, s.lagMs());
      }
      expect(peak, "a 300 ms stall must be visible to the sampler, well above what idle looked like").toBeGreaterThan(Math.max(150, idle + 100));
    } finally {
      s.stop();
    }
  });
});

describe("startEventLoopLagSampler — it reports the TAIL of the window, not its typical value", () => {
  it("one long stall among many healthy ticks still shows up (a median/low percentile would hide it)", async () => {
    // A 400 ms window holds ~20 healthy 20 ms ticks plus the one late tick that follows the stall. The typical delay is
    // ~0; the tail is ~200+. Overload is a tail phenomenon — a request that sat through the stall is a slow request.
    const s = startEventLoopLagSampler(400);
    try {
      await new Promise((r) => setTimeout(r, 250)); // healthy ticks accumulate
      const until = Date.now() + 250;
      while (Date.now() < until) { /* stall */ }
      let peak = 0;
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 30));
        peak = Math.max(peak, s.lagMs());
      }
      expect(peak).toBeGreaterThan(120);
    } finally {
      s.stop();
    }
  });
});

describe("positiveNumberFromEnv", () => {
  it.each([[undefined, 200], ["", 200], ["  ", 200], ["abc", 200], ["-5", 200], ["0", 200], ["NaN", 200], ["Infinity", 200], ["350", 350], ["12.5", 12.5]])(
    "%j -> %d", (raw, want) => expect(positiveNumberFromEnv(raw as any, 200)).toBe(want));
});
