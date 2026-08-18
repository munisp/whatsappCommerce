/**
 * Pre-compressed static asset serving.
 *
 * Cloudflare compresses uncached JS/CSS responses on the fly when the origin
 * doesn't already send a Content-Encoding — and because the compressed size
 * isn't known upfront, it relays them without Content-Length, relying purely
 * on HTTP/2 stream-end signaling. That's a known-flaky pattern in WebKit
 * under concurrent load (verified live: a single isolated request always
 * succeeds, but loading the real page — several large bundles requested at
 * once — reliably fails with "network connection was lost" in Safari, while
 * the identical concurrent load succeeds in Chromium and curl).
 *
 * Fix: pre-compress once at server startup and serve the .br file directly,
 * with a real Content-Length. Cloudflare passes through content the origin
 * already encoded rather than re-compressing it, so this restores a normal,
 * fully-specified response end-to-end instead of the ambiguous streamed one.
 */
import fs from "fs";
import path from "path";
import zlib from "zlib";
import { promisify } from "util";
import type { Express, Request, Response, NextFunction } from "express";

const COMPRESSIBLE_EXT = new Set([".js", ".css", ".svg", ".json", ".html", ".txt", ".map"]);
const MIN_SIZE_BYTES = 1024; // not worth compressing tiny files

function contentTypeFor(ext: string): string | null {
  switch (ext) {
    case ".js": return "application/javascript; charset=UTF-8";
    case ".css": return "text/css; charset=UTF-8";
    case ".svg": return "image/svg+xml";
    case ".json": return "application/json; charset=UTF-8";
    case ".html": return "text/html; charset=UTF-8";
    default: return null;
  }
}

const brotliCompress = promisify(zlib.brotliCompress);

// Compression is fired off for all 3 app dirs concurrently at startup, each
// via its own unbounded Promise.all over every stale file. On a fresh deploy
// (no .br files yet) that reads every JS/CSS bundle across all 3 apps into
// memory at once — enough to OOM under the container's 512Mi limit. This
// semaphore caps how many files are being read+compressed at any moment,
// globally across all precompressStaticAssets() calls, regardless of how
// many app dirs or files are queued.
const MAX_CONCURRENT_COMPRESSIONS = 3;
let activeCompressions = 0;
const waitQueue: Array<() => void> = [];

async function acquireSlot(): Promise<void> {
  if (activeCompressions < MAX_CONCURRENT_COMPRESSIONS) {
    activeCompressions++;
    return;
  }
  await new Promise<void>((resolve) => waitQueue.push(resolve));
  activeCompressions++;
}

function releaseSlot(): void {
  activeCompressions--;
  const next = waitQueue.shift();
  if (next) next();
}

async function compressOne(full: string): Promise<void> {
  await acquireSlot();
  try {
    const input = await fs.promises.readFile(full);
    const output = await brotliCompress(input, {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: 9,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: input.length,
      },
    });
    await fs.promises.writeFile(full + ".br", output);
  } finally {
    releaseSlot();
  }
}

/** Collects eligible files needing (re-)compression under `dir`. */
function findStaleFiles(dir: string): string[] {
  const stale: string[] = [];
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      const ext = path.extname(entry.name);
      if (!COMPRESSIBLE_EXT.has(ext) || entry.name.endsWith(".br")) continue;
      const stat = fs.statSync(full);
      if (stat.size < MIN_SIZE_BYTES) continue;
      const brPath = full + ".br";
      if (fs.existsSync(brPath) && fs.statSync(brPath).mtimeMs >= stat.mtimeMs) continue;
      stale.push(full);
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return stale;
}

/**
 * Brotli-compresses eligible files that don't already have an up-to-date
 * .br sibling. Uses the async zlib API (libuv threadpool), so it never
 * blocks the event loop — safe to fire-and-forget at startup without
 * delaying health checks or request handling. Actual read+compress work is
 * capped at MAX_CONCURRENT_COMPRESSIONS in flight (globally, across every
 * caller) to bound peak memory on a fresh deploy with no .br files yet.
 * Quality 9 rather than the max (11): ~20x faster with only ~8% larger
 * output, and the point here is a correct Content-Length, not the smallest
 * possible payload.
 */
export async function precompressStaticAssets(dir: string): Promise<void> {
  const files = findStaleFiles(dir);
  if (files.length === 0) return;
  const start = Date.now();
  await Promise.all(files.map(compressOne));
  console.log(`[static-compression] pre-compressed ${files.length} asset(s) under ${dir} in ${Date.now() - start}ms`);
}

/** Serves a pre-compressed .br sibling with a real Content-Length when one
 *  exists and the client accepts brotli; otherwise falls through untouched. */
export function serveBrotliPrecompressed(distPath: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const acceptEncoding = req.headers["accept-encoding"];
    const acceptsBr = typeof acceptEncoding === "string" && acceptEncoding.includes("br");
    if (!acceptsBr || req.method !== "GET") return next();

    const urlPath = req.path.split("?")[0];
    const ext = path.extname(urlPath);
    const contentType = contentTypeFor(ext);
    if (!contentType) return next();

    const filePath = path.join(distPath, urlPath);
    const brPath = filePath + ".br";
    fs.stat(brPath, (err, stat) => {
      if (err || !stat.isFile()) return next();
      res.set({
        "Content-Type": contentType,
        "Content-Encoding": "br",
        "Content-Length": String(stat.size),
        "Cache-Control": "public, max-age=14400",
        Vary: "Accept-Encoding",
      });
      fs.createReadStream(brPath).pipe(res);
    });
  };
}

/**
 * Registers pre-compression + serving for a static app root. Call BEFORE
 * express.static for the same distPath so .br responses win when available.
 * Compression itself is fire-and-forget: requests are served normally
 * (falling through to express.static / Cloudflare's own compression) until
 * each file's .br sibling exists, so this never delays server startup.
 */
export function useBrotliPrecompression(app: Express, urlPrefix: string, distPath: string): void {
  precompressStaticAssets(distPath).catch((err: unknown) => {
    console.error(`[static-compression] failed for ${distPath}:`, (err as Error)?.message);
  });
  app.use(urlPrefix, serveBrotliPrecompressed(distPath));
}
