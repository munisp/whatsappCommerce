#!/usr/bin/env tsx
/**
 * scripts/perf/auth-bench.mts — measure the latency added by auth hardening.
 *
 * Benchmarks (N iterations each, mean/p50/p95 reported):
 *   1. HS256 session-JWT verify  (mirrors server/_core/sdk.ts verifySession)
 *   2. RS256 JWT verify          (2048-bit RSA, mirrors gateway keycloak.go)
 *   3. Permify permission check  (only when PERMIFY_URL is reachable — this is
 *      the "when enabled" overhead of the Permify authorization layer)
 *
 * Usage:
 *   npx tsx scripts/perf/auth-bench.mts [--iters 2000]
 *   PERMIFY_URL=http://localhost:3476 PERMIFY_TENANT_ID=t1 npx tsx scripts/perf/auth-bench.mts
 */
import { SignJWT, jwtVerify, generateKeyPair, exportJWK } from "jose";

const iters = (() => {
  const i = process.argv.indexOf("--iters");
  return i >= 0 ? parseInt(process.argv[i + 1], 10) : 2000;
})();

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function stats(samples: number[]) {
  const s = [...samples].sort((a, b) => a - b);
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  return {
    n: samples.length,
    meanMs: +mean.toFixed(4),
    p50Ms: +percentile(s, 50).toFixed(4),
    p95Ms: +percentile(s, 95).toFixed(4),
    maxMs: +s[s.length - 1].toFixed(4),
  };
}

async function bench(label: string, fn: () => Promise<unknown>): Promise<void> {
  // warmup
  for (let i = 0; i < Math.min(100, iters / 10); i++) await fn();
  const samples: number[] = [];
  for (let i = 0; i < iters; i++) {
    const t0 = process.hrtime.bigint();
    await fn();
    samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  console.log(JSON.stringify({ bench: label, ...stats(samples) }));
}

async function main() {
  // ── 1. HS256 session cookie path ─────────────────────────────────────────
  const hsSecret = new TextEncoder().encode(process.env.JWT_SECRET ?? "bench-secret-32-bytes-minimum!!");
  const hsToken = await new SignJWT({ openId: "u-bench", appId: "app", name: "Bench User" })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setExpirationTime("1h")
    .sign(hsSecret);
  await bench("hs256-session-verify", () => jwtVerify(hsToken, hsSecret, { algorithms: ["HS256"] }));

  // ── 2. RS256 (Keycloak-style) verify ─────────────────────────────────────
  const { publicKey, privateKey } = await generateKeyPair("RS256", { modulusLength: 2048 });
  const rsToken = await new SignJWT({
    sub: "kc-user",
    preferred_username: "bench",
    realm_access: { roles: ["user"] },
  })
    .setProtectedHeader({ alg: "RS256", kid: "bench-key" })
    .setIssuer("http://localhost:8080/realms/wacommerce")
    .setExpirationTime("5m")
    .sign(privateKey);
  await bench("rs256-keycloak-verify", () => jwtVerify(rsToken, publicKey, { algorithms: ["RS256"] }));
  const jwk = await exportJWK(publicKey);
  console.log(JSON.stringify({ note: "RS256 key", kty: jwk.kty, modulusBits: 2048 }));

  // ── 3. Permify check (only when enabled/reachable) ───────────────────────
  const permifyUrl = process.env.PERMIFY_URL ?? "";
  const tenantId = process.env.PERMIFY_TENANT_ID ?? "t1";
  if (permifyUrl) {
    try {
      const health = await fetch(`${permifyUrl}/healthz`, { signal: AbortSignal.timeout(2000) }).catch(() => null);
      if (!health) throw new Error("unreachable");
      const body = {
        metadata: { schema_version: "", depth: 20 },
        entity: { type: "document", id: "doc-1" },
        permission: "view",
        subject: { type: "user", id: "u-bench" },
      };
      await bench("permify-check", () =>
        fetch(`${permifyUrl}/v1/tenants/${tenantId}/permissions/check`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }).then((r) => r.json())
      );
    } catch {
      console.log(JSON.stringify({ bench: "permify-check", skipped: true, reason: "permify unreachable" }));
    }
  } else {
    console.log(JSON.stringify({ bench: "permify-check", skipped: true, reason: "PERMIFY_URL not set" }));
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
