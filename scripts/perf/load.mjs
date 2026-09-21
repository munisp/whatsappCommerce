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
 *   --random-tenant      Send a random X-Tenant-Id per request (defeats the
 *                        per-tenant rate limiter for pure endpoint benchmarks)
 *   --method <m>         HTTP method (default GET)
 *   --rate <rps>         OPEN-LOOP mode (QA-040): start `rps` requests per second whatever the server does, instead of
 *                        keeping `--concurrency` requests in flight. Closed-loop (the default) slows down when the server
 *                        does, so it can never show unbounded queueing; real users do not slow down, so overload is
 *                        open-loop. In this mode --concurrency is the socket pool size and --max-inflight (default
 *                        20000) bounds the client's own memory; requests refused by that bound are counted as `dropped`.
 *
 * Output: total requests, RPS, latency p50/p95/p99/max, per-status counts.
 */
import http from "node:http";
import https from "node:https";

function parseArgs(argv) {
  const args = { url: null, concurrency: 10, duration: 10, requests: 0, headers: [], method: "GET", randomTenant: false, rate: 0, maxInflight: 20000 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--url") args.url = argv[++i];
    else if (a === "--concurrency") args.concurrency = parseInt(argv[++i], 10);
    else if (a === "--duration") args.duration = parseFloat(argv[++i]);
    else if (a === "--requests") args.requests = parseInt(argv[++i], 10);
    else if (a === "--method") args.method = argv[++i];
    else if (a === "--random-tenant") args.randomTenant = true;
    else if (a === "--rate") args.rate = parseFloat(argv[++i]);            // OPEN-LOOP: issue N requests/second regardless of replies
    else if (a === "--max-inflight") args.maxInflight = parseInt(argv[++i], 10);
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
  const latenciesByStatus = new Map(); // status -> ms[]  (QA-040: a fast 503 must not flatter the latency of the requests that WERE served)
  const statusCounts = new Map();
  let errors = 0;
  let issued = 0;
  const deadline = Date.now() + args.duration * 1000;

  function oneRequest() {
    return new Promise((resolve) => {
      const t0 = process.hrtime.bigint();
      const headers = args.randomTenant
        ? { ...extraHeaders, "X-Tenant-Id": `t-${Math.random().toString(36).slice(2, 10)}` }
        : extraHeaders;
      const req = (isTls ? https : http).request(
        {
          agent,
          method: args.method,
          hostname: target.hostname,
          port: target.port || (isTls ? 443 : 80),
          path: target.pathname + target.search,
          headers,
        },
        (res) => {
          res.resume(); // drain
          res.on("end", () => {
            const ms = Number(process.hrtime.bigint() - t0) / 1e6;
            latencies.push(ms);
            if (!latenciesByStatus.has(res.statusCode)) latenciesByStatus.set(res.statusCode, []);
            latenciesByStatus.get(res.statusCode).push(ms);
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
  let dropped = 0;
  if (args.rate > 0) {
    // Open loop: a timer-driven arrival process. Batches per 10 ms tick keep the schedule accurate at thousands of rps.
    const pending = new Set();
    const perTick = args.rate / 100;
    let owed = 0;
    await new Promise((resolveAll) => {
      const tick = setInterval(() => {
        if (Date.now() >= deadline) {
          clearInterval(tick);
          Promise.all(pending).then(resolveAll);
          return;
        }
        owed += perTick;
        while (owed >= 1) {
          owed -= 1;
          if (pending.size >= args.maxInflight) { dropped++; continue; }
          issued++;
          const p = oneRequest().finally(() => pending.delete(p));
          pending.add(p);
        }
      }, 10);
    });
  } else {
    await Promise.all(Array.from({ length: args.concurrency }, () => worker()));
  }
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
    ...(args.rate > 0 ? { openLoopRate: args.rate, issued, dropped } : {}),
    total,
    rps: +(total / elapsedSec).toFixed(1),
    errors,
    statuses: statuses || "none",
    meanMs: +(sum / total).toFixed(2),
    p50Ms: +percentile(latencies, 50).toFixed(2),
    p95Ms: +percentile(latencies, 95).toFixed(2),
    p99Ms: +percentile(latencies, 99).toFixed(2),
    maxMs: +latencies[total - 1].toFixed(2),
    // Latency of each status class on its own. The overall numbers above blend fast refusals (503) into the percentiles;
    // the honest question under load shedding is "how long did the requests that were ACCEPTED take?".
    byStatus: Object.fromEntries([...latenciesByStatus.entries()].sort((a, b) => a[0] - b[0]).map(([st, xs]) => {
      xs.sort((a, b) => a - b);
      return [st, { n: xs.length, p50Ms: +percentile(xs, 50).toFixed(2), p95Ms: +percentile(xs, 95).toFixed(2), p99Ms: +percentile(xs, 99).toFixed(2), maxMs: +xs[xs.length - 1].toFixed(2) }];
    })),
  }, null, 2));
}

main().catch((err) => { console.error(err); process.exit(1); });
