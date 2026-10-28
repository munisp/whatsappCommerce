/**
 * Spike-to-rejection against the REAL-TigerBeetle ledger bridge. Ramps concurrency
 * through escalating levels; at each level measures throughput + latency (p50/p99/max)
 * + error rate, then VERIFIES money stayed exact (escrow credits_posted == acknowledged
 * successes × amount — no lost ack, no phantom credit). Ends with a recovery probe so a
 * post-overload request must still succeed quickly (no wedge).
 *   node tests/e2e/_spike-burst.mjs   (bridge on :8095, adapter on :3100)
 */
import { randomUUID } from "node:crypto";
const L = process.env.LEDGER_URL ?? "http://localhost:8095";
const TB = process.env.TB_ADAPTER_URL ?? "http://localhost:3100";
const AMT = 100;
const LEVELS = [50, 100, 200, 400, 800, 1600];

const pct = (a, p) => a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))] ?? 0;
async function acct(id) { const r = await fetch(`${TB}/api/v1/accounts/${id}`); return r.status === 404 ? null : await r.json(); }
async function oneTransfer(src, esc) {
  const t0 = Date.now();
  try {
    const r = await fetch(`${L}/transfer`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ledger: 1, code: 1, debit_account_id: src, credit_account_id: esc, amount: AMT, single_phase: true, idempotency_key: randomUUID() }),
      signal: AbortSignal.timeout(30000),
    });
    return { ok: r.status >= 200 && r.status < 300, status: r.status, ms: Date.now() - t0 };
  } catch (e) { return { ok: false, status: -1, err: String(e.name), ms: Date.now() - t0 }; }
}

const rows = [];
let moneySafe = true;
for (const N of LEVELS) {
  const src = randomUUID(), esc = randomUUID();
  const t0 = Date.now();
  const res = await Promise.all(Array.from({ length: N }, () => oneTransfer(src, esc)));
  const wall = Date.now() - t0;
  const ok = res.filter((r) => r.ok).length;
  const errs = res.length - ok;
  const lat = res.map((r) => r.ms);
  const e = await acct(esc);
  const posted = e?.credits_posted ?? 0;
  const exact = posted === ok * AMT;        // every acknowledged success actually posted; none phantom
  if (!exact) moneySafe = false;
  const statusHist = res.reduce((m, r) => ((m[r.status] = (m[r.status] || 0) + 1), m), {});
  rows.push({ N, ok, errs, tps: Math.round(N / (wall / 1000)), p50: pct(lat, 0.5), p99: pct(lat, 0.99), max: Math.max(...lat), postedOk: exact, status: statusHist });
  console.log(`N=${String(N).padStart(4)} ok=${ok} err=${errs} tps=${String(rows.at(-1).tps).padStart(4)} p50=${pct(lat,0.5)}ms p99=${pct(lat,0.99)}ms max=${Math.max(...lat)}ms money=${exact ? "EXACT" : "DRIFT!"} status=${JSON.stringify(statusHist)}`);
}

// Recovery probe: after the heaviest burst, a single normal transfer must succeed quickly.
const rsrc = randomUUID(), resc = randomUUID();
const rec = await oneTransfer(rsrc, resc);
const recBal = (await acct(resc))?.credits_posted ?? 0;
console.log(`\nRECOVERY: single transfer after peak -> ok=${rec.ok} status=${rec.status} ms=${rec.ms} postedCorrectly=${recBal === AMT}`);

console.log(`\n===== SPIKE SUMMARY =====`);
console.log(`money stayed EXACT at every level (no lost ack / no phantom credit): ${moneySafe ? "YES ✓" : "NO ✗"}`);
console.log(`recovered after peak: ${rec.ok && recBal === AMT ? "YES ✓" : "NO ✗"}`);
const degraded = rows.find((r) => r.errs > 0);
console.log(degraded ? `first level with rejections: N=${degraded.N} (${degraded.errs} errs, status ${JSON.stringify(degraded.status)})` : `no outright rejections up to N=${LEVELS.at(-1)} (latency is the ceiling, not errors)`);
console.log(`peak p99: ${Math.max(...rows.map((r) => r.p99))}ms at the top levels`);
process.exit(moneySafe && rec.ok ? 0 : 1);
