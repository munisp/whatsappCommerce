// === W48 api-db ===
/**
 * J473 — PERF-API-10: gzip compression middleware for API/tRPC JSON
 * responses (zlib-based; the `compression` package is not in the frozen
 * lockfile).
 *
 * Exercises the middleware directly with stub req/res:
 *   1. payload ≥ threshold + Accept-Encoding: gzip → gzip-encoded body that
 *      gunzips back to the exact JSON,
 *   2. small payload → untouched,
 *   3. no Accept-Encoding → untouched,
 *   4. /api/webhooks/* paths → skipped (acks stay latency-critical),
 *   5. middleware errors never break the response (fail-open passthrough).
 */
import zlib from "node:zlib";
import { assert, type World } from "../world";
import type { Journey } from "../runner";

function mkRes() {
  const headers: Record<string, string> = {};
  const res: any = {
    headersSent: false,
    body: null as Buffer | null,
    setHeader(k: string, v: string) { headers[k.toLowerCase()] = v; },
    getHeader(k: string) { return headers[k.toLowerCase()]; },
    removeHeader(k: string) { delete headers[k.toLowerCase()]; },
    end(b: any) { res.body = Buffer.isBuffer(b) ? b : Buffer.from(String(b)); res.headersSent = true; return res; },
  };
  res.json = (body: unknown) => res.end(JSON.stringify(body));
  return res;
}

export const journey: Journey = {
  id: "J473",
  name: "API/tRPC JSON gzip compression middleware (PERF-API-10)",
  feature: "res.json ≥1KB gzipped when accepted; webhooks + small payloads untouched; fail-open",
  async run(world: World) {
    const { jsonCompressionMiddleware } = await import("../../server/_core/responseCompression");
    const mw = jsonCompressionMiddleware({ threshold: 1024 });

    // 1. Large payload + gzip accepted → compressed round-trip.
    {
      const req: any = { path: "/api/trpc/orders.list", headers: { "accept-encoding": "gzip, br" } };
      const res = mkRes();
      await new Promise<void>((resolve) => mw(req, res, () => resolve()));
      const payload = { rows: Array.from({ length: 200 }, (_, i) => ({ id: i, name: `product-${i}-with-a-fairly-long-name` })) };
      res.json(payload);
      assert(res.getHeader("content-encoding") === "gzip", "large JSON gzipped");
      const round = JSON.parse(zlib.gunzipSync(res.body).toString("utf8"));
      assert(round.rows.length === 200 && round.rows[5].name.includes("product-5"), "gunzip round-trip exact");
      assert(res.body.length < Buffer.from(JSON.stringify(payload)).length / 2, "meaningful size cut");
    }

    // 2. Small payload → untouched.
    {
      const req: any = { path: "/api/trpc/health", headers: { "accept-encoding": "gzip" } };
      const res = mkRes();
      await new Promise<void>((resolve) => mw(req, res, () => resolve()));
      res.json({ ok: true });
      assert(res.getHeader("content-encoding") === undefined, "small payload not compressed");
      assert(JSON.parse(res.body.toString()).ok === true, "small payload intact");
    }

    // 3. No Accept-Encoding → middleware passes through without wrapping.
    {
      const req: any = { path: "/api/trpc/orders.list", headers: {} };
      const res = mkRes();
      const origJson = res.json;
      await new Promise<void>((resolve) => mw(req, res, () => resolve()));
      assert(res.json === origJson, "no gzip accept → res.json untouched");
    }

    // 4. Webhook paths skipped.
    {
      const req: any = { path: "/api/webhooks/paystack", headers: { "accept-encoding": "gzip" } };
      const res = mkRes();
      const origJson = res.json;
      await new Promise<void>((resolve) => mw(req, res, () => resolve()));
      assert(res.json === origJson, "webhook ack path untouched");
    }

    await world.settle(50);
  },
};
