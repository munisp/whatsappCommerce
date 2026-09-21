/**
 * QA-038 part 2/3: every server-side caller of a PROTECTED ledger-bridge / recon-worker route now sends
 * X-Internal-Api-Key when INTERNAL_API_KEY is configured — those services will start requiring it once
 * their own INTERNAL_API_KEY is set (see rust/ledger-bridge, rust/recon-worker). This is the "callers
 * send it" stage of the rollout; nothing enforces yet, but every call site is pinned here so the
 * enforcing stage cannot be flipped on before every caller is ready.
 *
 * Also pins the OTHER half: with INTERNAL_API_KEY unset (today's live state), no caller sends the
 * header — so this doesn't change any behavior against a bridge that isn't enforcing yet.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/trpc";

function ctxFor(user: { id: number; role: string } | null): TrpcContext {
  return {
    user: user
      ? ({ id: user.id, openId: `u${user.id}`, email: "a@e.c", name: "A", loginMethod: "manus", role: user.role, tenantId: null, createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() } as TrpcContext["user"])
      : null,
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: () => {} } as unknown as TrpcContext["res"],
  };
}

type Call = { url: string; headers: Record<string, string> };
let calls: Call[];

beforeEach(() => {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: any, init?: any) => {
    calls.push({ url: String(url), headers: { ...(init?.headers ?? {}) } });
    return new Response(JSON.stringify({ status: "no_runs_yet", pending_id: "p1", replayed: false }), { status: 200 });
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.INTERNAL_API_KEY;
  vi.resetModules();
});

const headerNames = (h: Record<string, string>) => Object.keys(h).map((k) => k.toLowerCase());

describe("server/services/ledgerBridge.ts — ledgerBridgeRequest", () => {
  it("sends X-Internal-Api-Key when INTERNAL_API_KEY is configured", async () => {
    process.env.INTERNAL_API_KEY = "s3cret";
    vi.resetModules();
    const { ledgerBridgeRequest } = await import("./services/ledgerBridge");
    await ledgerBridgeRequest("/health", "GET");
    expect(calls[0].headers["X-Internal-Api-Key"]).toBe("s3cret");
  });

  it("sends nothing extra when INTERNAL_API_KEY is unset (today's live state — must not break an enforcing-free bridge)", async () => {
    delete process.env.INTERNAL_API_KEY;
    vi.resetModules();
    const { ledgerBridgeRequest } = await import("./services/ledgerBridge");
    await ledgerBridgeRequest("/health", "GET");
    expect(headerNames(calls[0].headers)).not.toContain("x-internal-api-key");
  });

  it("postDirectLedgerLeg and reverseCommittedTransfer go through the same helper, so they inherit the header too", async () => {
    process.env.INTERNAL_API_KEY = "s3cret";
    vi.resetModules();
    const { postDirectLedgerLeg, reverseCommittedTransfer } = await import("./services/ledgerBridge");
    await postDirectLedgerLeg({ debit_ref: "customer:+2348000000000", credit_ref: "escrow:t1", amount: 100, idempotency_key: "k1" }).catch(() => {});
    await reverseCommittedTransfer("p1", "test").catch(() => {});
    expect(calls.every((c) => c.headers["X-Internal-Api-Key"] === "s3cret")).toBe(true);
  });
});

describe("server/routers/payment.ts — ledgerRequest (payment.ts's own local copy)", () => {
  it("sends X-Internal-Api-Key when configured", async () => {
    process.env.INTERNAL_API_KEY = "s3cret";
    vi.resetModules();
    const { ledgerRequest } = await import("./routers/payment");
    await ledgerRequest("/health", "GET");
    expect(calls[0].headers["X-Internal-Api-Key"]).toBe("s3cret");
  });

  it("sends nothing extra when unset", async () => {
    delete process.env.INTERNAL_API_KEY;
    vi.resetModules();
    const { ledgerRequest } = await import("./routers/payment");
    await ledgerRequest("/health", "GET");
    expect(headerNames(calls[0].headers)).not.toContain("x-internal-api-key");
  });
});

describe("server/routers/infra.ts — provisionTbAccount is DISABLED (QA-039)", () => {
  // It used to be the call site the first pass of QA-038 missed (found by sweeping the repo for every caller). It is no
  // longer a caller at all: the body was never valid (camelCase vs the bridge's snake_case), and making it valid would
  // have started creating random-id, unconstrained, PERMANENT accounts in the shared TigerBeetle. So what is pinned is
  // that it refuses, explains itself, and never touches the bridge.
  const admin = () => appRouter.createCaller(ctxFor({ id: 1, role: "admin" }));
  const input = { accountType: "float" as const, currency: "NGN" };

  it("refuses with PRECONDITION_FAILED and an explanation, and never calls the ledger bridge", async () => {
    process.env.INTERNAL_API_KEY = "s3cret";
    await expect(admin().infra.provisionTbAccount(input)).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringMatching(/disabled.*created automatically/is),
    });
    expect(calls, "no request may reach the bridge").toHaveLength(0);
  });

  it("is still admin-only (a non-admin gets FORBIDDEN, not the explanation)", async () => {
    await expect(appRouter.createCaller(ctxFor({ id: 2, role: "user" })).infra.provisionTbAccount(input)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(calls).toHaveLength(0);
  });
});

describe("server/routers/infra.ts — recon-worker calls (triggerReconciliation, getLastReconciliation)", () => {
  const admin = () => appRouter.createCaller(ctxFor({ id: 1, role: "admin" }));

  it("triggerReconciliation sends the header when configured", async () => {
    process.env.INTERNAL_API_KEY = "s3cret";
    process.env.RECON_WORKER_URL = "http://recon-worker:8096";
    await admin().infra.triggerReconciliation().catch(() => {}); // response shape isn't what's under test here
    expect(calls[0].headers["X-Internal-Api-Key"]).toBe("s3cret");
    expect(calls[0].url).toContain("/recon/trigger");
  });

  it("triggerReconciliation sends nothing extra when unset", async () => {
    delete process.env.INTERNAL_API_KEY;
    process.env.RECON_WORKER_URL = "http://recon-worker:8096";
    await admin().infra.triggerReconciliation().catch(() => {});
    expect(headerNames(calls[0]?.headers ?? {})).not.toContain("x-internal-api-key");
  });

  it("getLastReconciliation sends the header when configured", async () => {
    process.env.INTERNAL_API_KEY = "s3cret";
    process.env.RECON_WORKER_URL = "http://recon-worker:8096";
    await admin().infra.getLastReconciliation();
    expect(calls[0].headers["X-Internal-Api-Key"]).toBe("s3cret");
    expect(calls[0].url).toContain("/recon/last");
  });

  it("getLastReconciliation sends nothing extra when unset", async () => {
    delete process.env.INTERNAL_API_KEY;
    process.env.RECON_WORKER_URL = "http://recon-worker:8096";
    await admin().infra.getLastReconciliation();
    expect(headerNames(calls[0].headers)).not.toContain("x-internal-api-key");
  });
});

// ── static sweep ──────────────────────────────────────────────────────────────────────────────────────────────
// The per-call-site tests above only cover the call sites someone remembered. provisionTbAccount was missed by the
// first pass (it is disabled now, QA-039) and found by reading, not by a failing test — so this is the tripwire for the NEXT one: every place in
// server/ that builds a URL from the bridge's or recon-worker's address must either hit an OPEN path (/health,
// /health/ready — kubelet sends no header) or set X-Internal-Api-Key nearby. Deliberately a heuristic (a header on a
// different request within the window would fool it); its job is to make forgetting loud, not to prove correctness.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

describe("static sweep: no caller of a protected bridge/recon-worker route can forget the header", () => {
  const SERVER = join(__dirname);
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.ts$/.test(name) && !/\.test\.ts$|\.spec\.ts$|\.d\.ts$/.test(name)) files.push(full);
    }
  };
  walk(SERVER);

  // \`\${<something naming the bridge/recon-worker address>}<path>\` inside a template literal
  const TARGET = /\$\{[^}]*(ledgerBridgeUrl|ledgerBridgeHealthUrl|reconWorkerUrl|LEDGER_BRIDGE_URL|RECON_WORKER_URL|ledgerUrl)[^}]*\}(\/[A-Za-z0-9_/:.-]*|\$\{)?/g;
  const OPEN = /^\/health(\/ready)?$/;

  const sites: Array<{ file: string; line: number; path: string; ok: boolean }> = [];
  for (const file of files) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((text, i) => {
      if (/^\s*(\/\/|\*)/.test(text) || /ledgerBridgeUrl:|ledgerBridgeHealthUrl:|reconWorkerUrl:/.test(text)) return; // comments, env.ts definitions
      for (const m of text.matchAll(TARGET)) {
        const path = (m[2] ?? "").replace(/\$\{$/, "");
        const window = lines.slice(Math.max(0, i - 8), i + 14).join("\n");
        sites.push({ file: file.replace(SERVER + "/", ""), line: i + 1, path: path || "(dynamic)", ok: OPEN.test(path) || /X-Internal-Api-Key/.test(window) });
      }
    });
  }

  it("is not vacuous: it finds the call sites we know exist", () => {
    const where = sites.map((s) => `${s.file}`);
    for (const known of ["services/ledgerBridge.ts", "routers/payment.ts", "routers/infra.ts"]) expect(where.some((w) => w.endsWith(known)), known).toBe(true);
    expect(sites.length).toBeGreaterThanOrEqual(6); // was 7 before provisionTbAccount stopped being a caller (QA-039)
  });

  it("every one either targets an open /health path or sets X-Internal-Api-Key nearby", () => {
    const bad = sites.filter((s) => !s.ok).map((s) => `${s.file}:${s.line} → ${s.path}`);
    expect(bad, `these call a protected bridge/recon-worker route without the internal key:\n  ${bad.join("\n  ")}`).toEqual([]);
  });
});
