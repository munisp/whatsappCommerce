// === W46 platform-p2 ===
/**
 * J422 — PLT-15: HMAC-signed internal service requests (ts+body, kid
 * key-versioning), additive alongside the legacy bearer, fail-closed in prod.
 * Functional roundtrip against server/_core/internalAuth.ts + source-contract
 * on the _core/index.ts guarded route.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { assert, assertIncludes } from "../world";
import type { Journey } from "../runner";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

export const journey: Journey = {
  id: "J422",
  name: "internal HMAC auth (sign/verify, kid rotation, fail-closed)",
  feature: "platform-p2: PLT-15 internal auth",
  async run() {
    const auth = await import("../../server/_core/internalAuth");

    const env = {
      INTERNAL_HMAC_KEYS: JSON.stringify({
        v2: "0123456789abcdef0123456789abcdef",
        v1: "fedcba9876543210fedcba9876543210",
      }),
      INTERNAL_HMAC_KEY_ID: "v2",
    } as unknown as NodeJS.ProcessEnv;

    // ── sign → verify roundtrip ──────────────────────────────────────────
    const headers = auth.signInternalRequest({ method: "post", path: "/api/internal/events", body: '{"events":[]}', now: 1_800_000_000, env });
    assert(headers, "signInternalRequest returns headers when configured");
    assertIncludes(headers![auth.HDR_KEY_ID], "v2", "signed with active kid");
    const ok = auth.verifyInternalRequest({
      method: "POST", path: "/api/internal/events", rawBody: '{"events":[]}',
      headers: headers!, now: 1_800_000_100, env,
    });
    assert(ok.ok === true && (ok as any).kid === "v2", `roundtrip verifies (got ${JSON.stringify(ok)})`);

    // ── body tamper → bad-signature ──────────────────────────────────────
    const tampered = auth.verifyInternalRequest({
      method: "POST", path: "/api/internal/events", rawBody: '{"events":[{"evil":1}]}',
      headers: headers!, now: 1_800_000_100, env,
    });
    assert(tampered.ok === false && tampered.error === "bad-signature", "tampered body rejected");

    // ── stale timestamp → stale-ts ───────────────────────────────────────
    const stale = auth.verifyInternalRequest({
      method: "POST", path: "/api/internal/events", rawBody: '{"events":[]}',
      headers: headers!, now: 1_800_000_000 + auth.INTERNAL_HMAC_MAX_SKEW_SECONDS + 60, env,
    });
    assert(stale.ok === false && stale.error === "stale-ts", "stale timestamp rejected");

    // ── key versioning: an old-kid signature still verifies (rotation) ───
    const oldEnv = { ...env, INTERNAL_HMAC_KEY_ID: "v1" } as unknown as NodeJS.ProcessEnv;
    const oldHeaders = auth.signInternalRequest({ method: "POST", path: "/api/internal/events", body: '{"events":[]}', now: 1_800_000_000, env: oldEnv });
    const rotated = auth.verifyInternalRequest({
      method: "POST", path: "/api/internal/events", rawBody: '{"events":[]}',
      headers: oldHeaders!, now: 1_800_000_100, env,
    });
    assert(rotated.ok === true && (rotated as any).kid === "v1", "old kid verifies during rotation window");

    // ── unknown kid / missing headers fail closed ────────────────────────
    const badKid = auth.verifyInternalRequest({
      method: "POST", path: "/api/internal/events", rawBody: "{}",
      headers: { ...headers!, [auth.HDR_KEY_ID]: "v99" }, now: 1_800_000_100, env,
    });
    assert(badKid.ok === false && badKid.error === "unknown-kid", "unknown kid rejected");
    const missing = auth.verifyInternalRequest({
      method: "POST", path: "/api/internal/events", rawBody: "{}", headers: {}, env,
    });
    assert(missing.ok === false && missing.error === "missing-headers", "missing headers rejected");
    const noKeys = auth.verifyInternalRequest({
      method: "POST", path: "/api/internal/events", rawBody: "{}", headers: headers!, now: 1_800_000_100,
      env: {} as NodeJS.ProcessEnv,
    });
    assert(noKeys.ok === false && noKeys.error === "not-configured", "unconfigured keyring fails closed");
    assert(auth.hmacRequired({ INTERNAL_AUTH_REQUIRE_HMAC: "true" } as any) === true, "require-hmac knob parses");
    assert(auth.hmacRequired({} as any) === false, "require-hmac default off");

    // ── route wiring: additive HMAC block on the sensitive internal route ──
    const idx = await readFile(`${repoRoot}/server/_core/index.ts`, "utf8");
    assertIncludes(idx, 'await import("./internalAuth")', "internal route imports the HMAC verifier");
    assertIncludes(idx, "verifyInternalRequest(", "route verifies HMAC");
    assertIncludes(idx, "invalid-internal-hmac", "bad HMAC → 401");
    assertIncludes(idx, "internal-hmac-required", "REQUIRE_HMAC refuses bearer in prod");
    assertIncludes(idx, "INTERNAL_API_KEY", "legacy bearer retained (additive)");

    // ── env docs ─────────────────────────────────────────────────────────
    const envExample = await readFile(`${repoRoot}/env.example.txt`, "utf8");
    assertIncludes(envExample, "INTERNAL_HMAC_KEYS", "env.example documents key map");
    assertIncludes(envExample, "INTERNAL_AUTH_REQUIRE_HMAC", "env.example documents fail-closed knob");
  },
};
