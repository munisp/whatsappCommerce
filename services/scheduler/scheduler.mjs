#!/usr/bin/env node
/**
 * W30 cron scheduler (V3#3) — invokes the platform's /api/scheduled/* routes
 * on their documented cadences with a locally-signed cron JWT (CRON_JWT).
 *
 * Modes:
 *   node scheduler.mjs                      daemon: ticks every TICK_MS and
 *                                           fires routes whose interval elapsed
 *   node scheduler.mjs --once <path>        invoke a single route and exit
 *                                           (used by k8s CronJob objects)
 *   node scheduler.mjs --list               print the allowlist and exit 0
 *
 * Env:
 *   PLATFORM_URL   default http://platform:3000
 *   CRON_JWT       HS256 shared secret (REQUIRED — process exits non-zero
 *                  without it; the platform rejects cron tokens when unset)
 *   TICK_MS        daemon tick granularity (default 15000; min 1000)
 *
 * The allowlist below is the SINGLE source of truth for route cadences —
 * keep it in sync with server/_core/index.ts (J178 asserts parity).
 */
import { createHmac } from "node:crypto";

const PLATFORM_URL = (process.env.PLATFORM_URL ?? "http://platform:3000").replace(/\/$/, "");
const CRON_JWT = (process.env.CRON_JWT ?? "").trim();
const TICK_MS = Math.max(1000, parseInt(process.env.TICK_MS ?? "15000", 10));

/**
 * Every /api/scheduled/* route registered in server/_core/index.ts, with its
 * cadence in minutes (daily = 1440). Cadences mirror the manus-heartbeat
 * comments in index.ts; undocumented routes get a conservative interval
 * matching their handler semantics (per-minute sweeps stay per-minute).
 */
export const SCHEDULE = [
  { path: "/api/scheduled/cart-recovery", intervalMin: 10 },
  { path: "/api/scheduled/bookkeeping-digests", intervalMin: 1440 },
  { path: "/api/scheduled/odoo-sync", intervalMin: 1440 },
  { path: "/api/scheduled/credit-loan-repayment", intervalMin: 10 },
  { path: "/api/scheduled/wa-send-retry", intervalMin: 5 },
  { path: "/api/scheduled/inventory-sync", intervalMin: 5 },
  { path: "/api/scheduled/reconciliation-alert", intervalMin: 60 },
  { path: "/api/scheduled/forecast-snapshot", intervalMin: 1440 },
  { path: "/api/scheduled/leaderboard-top3", intervalMin: 1440 },
  { path: "/api/scheduled/escrow-auto-confirm", intervalMin: 10 },
  { path: "/api/scheduled/float-income", intervalMin: 1440 },
  { path: "/api/scheduled/sla-scan", intervalMin: 15 },
  { path: "/api/scheduled/broadcast-scheduler", intervalMin: 1 },
  { path: "/api/scheduled/journey-tick", intervalMin: 1 },
  { path: "/api/scheduled/journey-orchestrate-tick", intervalMin: 1 },
  { path: "/api/scheduled/lead-model-tick", intervalMin: 60 },
  { path: "/api/scheduled/pd-model-tick", intervalMin: 60 },
  { path: "/api/scheduled/uplift-model-tick", intervalMin: 60 },
  { path: "/api/scheduled/bandit-reward-tick", intervalMin: 15 },
  { path: "/api/scheduled/broadcast-dispatch", intervalMin: 1 },
  { path: "/api/scheduled/window-expiry-check", intervalMin: 15 },
  { path: "/api/scheduled/wa-quality-refresh", intervalMin: 1440 },
  { path: "/api/scheduled/wa-media-download", intervalMin: 5 },
  { path: "/api/scheduled/wa-webhook-retry", intervalMin: 2 },
  { path: "/api/scheduled/inventory-reservation-sweep", intervalMin: 1 },
  { path: "/api/scheduled/integration-outbox-dispatch", intervalMin: 1 },
  { path: "/api/scheduled/odoo-inventory-sync", intervalMin: 10 },
  { path: "/api/scheduled/medusa-catalog-sync", intervalMin: 30 },
  { path: "/api/scheduled/nightly-finetune", intervalMin: 1440 },
  { path: "/api/scheduled/ab-test-metrics", intervalMin: 30 },
  { path: "/api/scheduled/drift-alert", intervalMin: 360 },
  { path: "/api/scheduled/delivery-summary", intervalMin: 1440 },
  { path: "/api/scheduled/hermes-po-expiry", intervalMin: 60 },
  { path: "/api/scheduled/hermes-health-snapshot", intervalMin: 5 },
];

function b64url(buf) {
  return Buffer.from(buf).toString("base64url");
}

/** Sign an HS256 cron JWT the platform accepts (server/_core/sdk.ts local path). */
export function signCronToken(secret, routePath) {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({
    openId: "cron_scheduler",
    appId: "wacommerce",
    name: "Cron Scheduler",
    task_uid: `scheduler:${routePath}`,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 300,
  }));
  const sig = createHmac("sha256", secret).update(`${header}.${payload}`).digest();
  return `${header}.${payload}.${b64url(sig)}`;
}

/** Invoke one scheduled route with cron auth. Returns {status, body}. */
export async function invokeRoute(path, { platformUrl = PLATFORM_URL, secret = CRON_JWT, fetchImpl = fetch } = {}) {
  if (!SCHEDULE.some((r) => r.path === path)) {
    throw new Error(`route not in scheduler allowlist: ${path}`);
  }
  if (!secret) throw new Error("CRON_JWT is not set — refusing to invoke scheduled routes unauthenticated");
  const token = signCronToken(secret, path);
  const res = await fetchImpl(`${platformUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: "{}",
    signal: AbortSignal.timeout(120_000),
  });
  const body = await res.text();
  return { status: res.status, body };
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--list") {
    for (const r of SCHEDULE) console.log(`${r.intervalMin}\t${r.path}`);
    return;
  }
  if (!CRON_JWT) {
    console.error("[scheduler] FATAL: CRON_JWT is unset — scheduled routes require cron auth. Set CRON_JWT (matching the platform) before starting.");
    process.exit(1);
  }
  if (args[0] === "--print-token") {
    // Mint a short-lived cron JWT for manual/authenticated curl invocations:
    //   curl -H "Authorization: Bearer $(node scheduler.mjs --print-token /api/scheduled/x)" ...
    const path = args[1];
    if (!SCHEDULE.some((r) => r.path === path)) {
      console.error(`[scheduler] route not in allowlist: ${path}`);
      process.exit(1);
    }
    process.stdout.write(signCronToken(CRON_JWT, path));
    return;
  }
  if (args[0] === "--once") {
    const path = args[1];
    const { status, body } = await invokeRoute(path);
    console.log(`[scheduler] ${path} → ${status} ${body.slice(0, 300)}`);
    process.exit(status >= 200 && status < 300 ? 0 : 1);
  }
  // Daemon mode
  console.log(`[scheduler] starting; ${SCHEDULE.length} routes, tick=${TICK_MS}ms, target=${PLATFORM_URL}`);
  const lastRun = new Map();
  const tick = async () => {
    const now = Date.now();
    for (const r of SCHEDULE) {
      const due = now - (lastRun.get(r.path) ?? 0) >= r.intervalMin * 60_000;
      if (!due) continue;
      lastRun.set(r.path, now);
      try {
        const { status, body } = await invokeRoute(r.path);
        if (status >= 400) console.warn(`[scheduler] ${r.path} → ${status} ${body.slice(0, 200)}`);
        else console.log(`[scheduler] ${r.path} → ${status}`);
      } catch (e) {
        console.warn(`[scheduler] ${r.path} failed: ${e?.message ?? e}`);
      }
    }
  };
  await tick();
  setInterval(tick, TICK_MS).unref?.();
  // Keep alive
  setInterval(() => {}, 1 << 30);
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) main().catch((e) => { console.error("[scheduler] fatal:", e); process.exit(1); });
