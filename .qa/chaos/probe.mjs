#!/usr/bin/env node
/**
 * Continuous availability prober for chaos experiments.
 * usage: node .qa/chaos/probe.mjs --url https://host/health --rps 10 --seconds 120 [--out file.json]
 * Records every request (start offset, status or error, latency) and reports
 * total / ok / failed, latency percentiles, and the failure WINDOWS (contiguous
 * runs of failures) so "how long were users affected" is a number, not a guess.
 */
import { writeFileSync } from "node:fs";
const a = Object.fromEntries(process.argv.slice(2).reduce((acc, v, i, arr) => v.startsWith("--") ? [...acc, [v.slice(2), arr[i + 1]]] : acc, []));
const url = a.url, rps = Number(a.rps ?? 10), seconds = Number(a.seconds ?? 60), timeoutMs = Number(a.timeout ?? 3000);
if (!url) { console.error("--url required"); process.exit(2); }
const t0 = Date.now(), results = [], inflight = [];
const fire = () => {
  const start = Date.now();
  const p = fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "manual" })
    .then(r => { results.push({ t: start - t0, ok: r.status < 500 && r.status !== 0, status: r.status, ms: Date.now() - start }); return r.arrayBuffer(); })
    .catch(e => results.push({ t: start - t0, ok: false, status: e.name === "TimeoutError" ? "timeout" : (e.cause?.code ?? e.name), ms: Date.now() - start }));
  inflight.push(p);
};
const timer = setInterval(fire, 1000 / rps);
await new Promise(r => setTimeout(r, seconds * 1000));
clearInterval(timer);
await Promise.allSettled(inflight);
results.sort((x, y) => x.t - y.t);
const bad = results.filter(r => !r.ok);
const lat = results.filter(r => r.ok).map(r => r.ms).sort((x, y) => x - y);
const pct = p => lat.length ? lat[Math.min(lat.length - 1, Math.ceil(p / 100 * lat.length) - 1)] : null;
// failure windows: gaps between consecutive failures > 1.5s start a new window
const windows = [];
for (const f of bad) {
  const w = windows[windows.length - 1];
  if (w && f.t - w.end <= 1500) { w.end = f.t; w.count++; w.statuses[f.status] = (w.statuses[f.status] ?? 0) + 1; }
  else windows.push({ start: f.t, end: f.t, count: 1, statuses: { [f.status]: 1 } });
}
const summary = {
  url, rps, seconds, total: results.length, ok: results.length - bad.length, failed: bad.length,
  availabilityPct: +(100 * (results.length - bad.length) / Math.max(1, results.length)).toFixed(3),
  p50ms: pct(50), p95ms: pct(95), p99ms: pct(99), maxMs: lat.at(-1) ?? null,
  failureWindows: windows.map(w => ({ fromSec: +(w.start / 1000).toFixed(1), toSec: +(w.end / 1000).toFixed(1), durationSec: +((w.end - w.start) / 1000).toFixed(1), failedRequests: w.count, statuses: w.statuses })),
};
console.log(JSON.stringify(summary, null, 2));
if (a.out) writeFileSync(a.out, JSON.stringify({ summary, results }));
