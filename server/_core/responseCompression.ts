/**
 * === W48 api-db (PERF-API-10) ===
 * Minimal gzip compression middleware for API/tRPC JSON responses.
 *
 * The `compression` npm package is NOT in the frozen lockfile (W48 invariant:
 * only Coder B may touch package.json), so this wraps res.json with a
 * zlib-based equivalent: responses ≥ threshold that the client accepts
 * gzipped are sent with Content-Encoding: gzip (~70-90% size cut on
 * catalog/transcript payloads).
 *
 * Doctrine: fail-open — any error falls back to the original res.json.
 * Webhook ack paths are skipped (tiny, time-critical).
 */
import type { Request, Response, NextFunction } from "express";
import zlib from "node:zlib";

export function jsonCompressionMiddleware(opts?: { threshold?: number }) {
  const threshold = opts?.threshold ?? 1024;
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      if (req.path.startsWith("/api/webhooks")) return next();
      const accept = String(req.headers["accept-encoding"] ?? "");
      if (!accept.includes("gzip")) return next();
      const origJson = res.json.bind(res);
      res.json = ((body: unknown) => {
        try {
          if (res.headersSent || res.getHeader("content-encoding")) return origJson(body);
          const payload = Buffer.from(JSON.stringify(body), "utf8");
          if (payload.length < threshold) return origJson(body);
          const compressed = zlib.gzipSync(payload);
          res.setHeader("content-encoding", "gzip");
          res.setHeader("content-type", "application/json; charset=utf-8");
          res.setHeader("vary", "accept-encoding");
          res.removeHeader("content-length");
          return res.end(compressed);
        } catch {
          return origJson(body);
        }
      }) as Response["json"];
    } catch {
      // never block the request on middleware setup
    }
    return next();
  };
}
// === END W48 api-db ===
