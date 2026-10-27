/**
 * Load / concurrency burst against the REAL-TigerBeetle ledger stack.
 * Money-safety under volume: (1) idempotency under a concurrent race, (2) exact
 * totals under a high-contention hotspot (many concurrent legs into one escrow),
 * (3) throughput. Real strict-serializability is the property under test.
 */
import { randomUUID } from "node:crypto";
import { CFG, postJson, uniqueId } from "./helpers/stack";
const TB = process.env.TB_ADAPTER_URL!;
const L = CFG.ledgerUrl;
async function acct(id: string) {
  const r = await fetch(`${TB}/api/v1/accounts/${id}`);
  return r.status === 404 ? null : ((await r.json()) as any);
}
const transfer = (body: Record<string, unknown>) => postJson(L, "/transfer", { ledger: 1, code: 1, ...body });
const pct = (arr: number[], p: number) => arr.slice().sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor(arr.length * p))];

let failures = 0;
const check = (label: string, ok: boolean, detail: string) => { console.log(`${ok ? "PASS" : "FAIL"}  ${label} — ${detail}`); if (!ok) failures++; };

async function main() {
  // ── 1. Idempotency under a concurrent race ──────────────────────────────
  const debit = randomUUID(), credit = randomUUID(), key = uniqueId("race");
  const N = 100;
  const res = await Promise.all(Array.from({ length: N }, () => transfer({ debit_account_id: debit, credit_account_id: credit, amount: 5000, idempotency_key: key })));
  const pids = new Set(res.map((r) => r.body?.pending_id).filter(Boolean));
  const d = await acct(debit);
  check("idempotency race: 100 concurrent same-key reserves → ONE reservation",
    pids.size === 1 && d?.debits_pending === 5000,
    `distinct pending_ids=${pids.size} (expect 1), debit debits_pending=${d?.debits_pending} (expect 5000)`);

  // ── 2. High-contention hotspot: many concurrent legs into ONE escrow ────
  const esc = randomUUID(), src = randomUUID();
  const M = 400, AMT = 100;
  const lat: number[] = [];
  const t0 = Date.now();
  for (let off = 0; off < M; off += 50) {
    await Promise.all(Array.from({ length: Math.min(50, M - off) }, () => {
      const s = Date.now();
      return transfer({ debit_account_id: src, credit_account_id: esc, amount: AMT, single_phase: true, idempotency_key: uniqueId("leg") })
        .then((r) => { lat.push(Date.now() - s); return r; });
    }));
  }
  const elapsed = Date.now() - t0;
  const e = await acct(esc), s = await acct(src);
  check("volume: 400 concurrent single-phase legs → escrow total EXACT",
    e?.credits_posted === M * AMT,
    `escrow credits_posted=${e?.credits_posted} (expect ${M * AMT})`);
  check("double-entry holds under load: source debits == escrow credits",
    s?.debits_posted === M * AMT && e?.credits_posted === M * AMT,
    `src debits_posted=${s?.debits_posted}, esc credits_posted=${e?.credits_posted}`);
  console.log(`\nthroughput: ${M} legs in ${elapsed}ms = ~${Math.round(M / (elapsed / 1000))} tx/s | latency p50=${pct(lat, 0.5)}ms p99=${pct(lat, 0.99)}ms max=${Math.max(...lat)}ms`);

  // ── 3. No money created/lost: escrow never exceeds what was funded ──────
  check("no overdraw: escrow credits exactly equal funded debits (no money created/lost)",
    (e?.credits_posted ?? 0) === (s?.debits_posted ?? -1), `esc=${e?.credits_posted} src=${s?.debits_posted}`);

  console.log(`\n${failures === 0 ? "ALL LOAD INVARIANTS HELD" : failures + " FAILURES"}`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error("LOAD_ERROR", e); process.exit(2); });
