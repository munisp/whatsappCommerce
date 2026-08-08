#!/usr/bin/env node
/**
 * scripts/perf/load.mjs — minimal HTTP load driver using Node built-ins only.
 *
 * Usage:
 *   node scripts/perf/load.mjs --url http://localhost:3000/health \
 *       --concurrency 100 --duration 15
 *   node scripts/perf/load.mjs --url http://localhost:3000/api/trpc/auth.me \
 *       --concurrency 200 --requests 250 --header "X-Tenant-Id: t-load"
 *
 * Options:
 *   --url <url>          Target URL (required)
 *   --concurrency <n>    Parallel workers (default 10)
 *   --duration <sec>     Run for N seconds (default 10); ignored if --requests set
 *   --requests <n>       Stop after N total requests
 *   --header "K: V"      Extra request header (repeatable)
 *   --method <m>         HTTP method (default GET)
 *
 * Output: total requests, RPS, latency p50/p95/p99/max, per-status counts.
 */
import http from "node:http";
import https from "node:https";

function parseArgs(argv) {
  const args = { url: null, concurrency: 10, duration: 10, requests: 0, headers: [], method: "GET" };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--url") args.url = argv[++i];
    else if (a === "--concurrency") args.concurrency = parseInt(argv[++i], 10);
    else if (a === "--duration") args.duration = parseFloat(argv[++i]);
    else if (a === "--requests") args.requests = parseInt(argv[++i], 10);
    else if (a === "--method") args.method = argv[++i];
    else if (a === "--header") args.headers.push(argv[++i]);
    else if (a === "--help") { console.log("see header comment"); process.exit(0); }
    else { console.error(`unknown arg: ${a}`); process.exit(2); }
  }
  if (!args.url) { console.error("--url is required"); process.exit(2); }
  return args;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

async function main() {
  const args = parseArgs(process.argv);
  const target = new URL(args.url);
  const isTls = target.protocol === "https:";
  const agent = (isTls ? https : http).Agent({
    keepAlive: true,
    maxSockets: args.concurrency,
    maxFreeSockets: args.concurrency,
  });
  const extraHeaders = {};
  for (const h of args.headers) {
    const idx = h.indexOf(":");
    if (idx > 0) extraHeaders[h.slice(0, idx).trim()] = h.slice(idx + 1).trim();
  }

  const latencies = []; // ms
  const statusCounts = new Map();
  let errors = 0;
  let issued = 0;
  const deadline = Date.now() + args.duration * 1000;

  function oneRequest() {
    return new Promise((resolve) => {
      const t0 = process.hrtime.bigint();
      const req = (isTls ? https : http).request(
        {
          agent,
          method: args.method,
          hostname: target.hostname,
          port: target.port || (isTls ? 443 : 80),
          path: target.pathname + target.search,
          headers: extraHeaders,
        },
        (res) => {
          res.resume(); // drain
          res.on("end", () => {
            const ms = Number(process.hrtime.bigint() - t0) / 1e6;
            latencies.push(ms);
            statusCounts.set(res.statusCode, (statusCounts.get(res.statusCode) ?? 0) + 1);
            resolve();
          });
        }
      );
      req.on("error", () => {
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        latencies.push(ms);
        errors++;
        resolve();
      });
      req.end();
    });
  }

  async function worker() {
    while (Date.now() < deadline) {
      if (args.requests > 0 && issued >= args.requests) return;
      issued++;
      await oneRequest();
    }
  }

  const started = Date.now();
  await Promise.all(Array.from({ length: args.concurrency }, () => worker()));
  const elapsedSec = (Date.now() - started) / 1000;
  agent.destroy();

  latencies.sort((a, b) => a - b);
  const total = latencies.length;
  const sum = latencies.reduce((a, b) => a + b, 0);
  const statuses = [...statusCounts.entries()].sort((a, b) => a[0] - b[0])
    .map(([s, n]) => `${s}:${n}`).join(" ");

  console.log(JSON.stringify({
    url: args.url,
    concurrency: args.concurrency,
    elapsedSec: +elapsedSec.toFixed(2),
    total,
    rps: +(total / elapsedSec).toFixed(1),
    errors,
    statuses: statuses || "none",
    meanMs: +(sum / total).toFixed(2),
    p50Ms: +percentile(latencies, 50).toFixed(2),
    p95Ms: +percentile(latencies, 95).toFixed(2),
    p99Ms: +percentile(latencies, 99).toFixed(2),
    maxMs: +latencies[total - 1].toFixed(2),
  }, null, 2));
}

main().catch((err) => { console.error(err); process.exit(1); });
