#!/usr/bin/env node
/**
 * Money-path availability probe for chaos experiments: drives real two-phase RESERVE -> VOID pairs through ledger-bridge
 * (and so through tb-adapter and the shared TigerBeetle), at a fixed arrival rate, and reports failures by stage with the
 * failure WINDOWS. /health tells you a pod is up; this tells you money can still move.
 *
 * RUN INSIDE THE CLUSTER, from a pod the NetworkPolicy lets reach the bridge (`server`), so it reads the internal key from
 * that pod's own environment and never prints it:
 *
 *   kubectl -n whatsapp-commerce exec -i deploy/server -c server -- \
 *     env PROBE_RPS=5 PROBE_SECONDS=60 node - < .qa/chaos/ledger-probe.mjs
 *
 * Footprint: two accounts (fresh random UUIDs, unconstrained) and one voided pending transfer per iteration, in the shared
 * TigerBeetle. Keep RPS x SECONDS modest. Idempotency keys are unique per iteration and per run.
 */
import { randomUUID } from "node:crypto";

const BASE = process.env.LEDGER_BRIDGE_URL ?? "http://ledger-bridge:8095";
const KEY = process.env.INTERNAL_API_KEY ?? "";
const RPS = Number(process.env.PROBE_RPS ?? 5);
const SECONDS = Number(process.env.PROBE_SECONDS ?? 60);
const TIMEOUT = Number(process.env.PROBE_TIMEOUT_MS ?? 3000);
const run = randomUUID().slice(0, 8);
const debit = randomUUID(), credit = randomUUID();
const headers = { "Content-Type": "application/json", ...(KEY ? { "X-Internal-Api-Key": KEY } : {}) };

const t0 = Date.now();
const rows = []; // { t, stage, ok, status, ms }
const post = async (path, body) => {
  const start = Date.now();
  try {
    const r = await fetch(BASE + path, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT) });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status, ms: Date.now() - start, json };
  } catch (e) {
    return { status: e.name === "TimeoutError" ? "timeout" : (e.cause?.code ?? e.name), ms: Date.now() - start, json: null };
  }
};

let i = 0;
const one = async () => {
  const n = ++i, t = Date.now() - t0;
  const res = await post("/transfer", { debit_account_id: debit, credit_account_id: credit, amount: 100, idempotency_key: `qa-chaos-${run}-${n}` });
  const pendingId = res.json?.pending_id;
  rows.push({ t, stage: "reserve", ok: res.status === 201 && !!pendingId, status: res.status, ms: res.ms });
  if (!pendingId) return;
  const v = await post("/ledger/void", { pending_id: pendingId });
  rows.push({ t: Date.now() - t0, stage: "void", ok: v.status === 200, status: v.status, ms: v.ms });
};

const inflight = [];
const timer = setInterval(() => inflight.push(one()), 1000 / RPS);
await new Promise((r) => setTimeout(r, SECONDS * 1000));
clearInterval(timer);
await Promise.allSettled(inflight);

rows.sort((a, b) => a.t - b.t);
const bad = rows.filter((r) => !r.ok);
const windows = [];
for (const f of bad) {
  const w = windows[windows.length - 1];
  if (w && f.t - w.end <= 1500) { w.end = f.t; w.count++; w.statuses[`${f.stage}:${f.status}`] = (w.statuses[`${f.stage}:${f.status}`] ?? 0) + 1; }
  else windows.push({ start: f.t, end: f.t, count: 1, statuses: { [`${f.stage}:${f.status}`]: 1 } });
}
const lat = rows.filter((r) => r.ok).map((r) => r.ms).sort((a, b) => a - b);
const pct = (p) => (lat.length ? lat[Math.min(lat.length - 1, Math.ceil((p / 100) * lat.length) - 1)] : null);
console.log(JSON.stringify({
  base: BASE, rps: RPS, seconds: SECONDS, iterations: i, calls: rows.length, ok: rows.length - bad.length, failed: bad.length,
  availabilityPct: +((100 * (rows.length - bad.length)) / Math.max(1, rows.length)).toFixed(3),
  reserveOk: rows.filter((r) => r.stage === "reserve" && r.ok).length, voidOk: rows.filter((r) => r.stage === "void" && r.ok).length,
  p50ms: pct(50), p95ms: pct(95), p99ms: pct(99), maxMs: lat.at(-1) ?? null,
  failureWindows: windows.map((w) => ({ fromSec: +(w.start / 1000).toFixed(1), toSec: +(w.end / 1000).toFixed(1), failed: w.count, statuses: w.statuses })),
}, null, 2));
