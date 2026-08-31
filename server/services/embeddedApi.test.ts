/**
 * W33 embedded-api: credential-service unit tests (no DB) — sha256-only
 * storage, timing-safe comparison, scope checks, actor label.
 */
import { describe, expect, it } from "vitest";
import {
  EMBEDDED_SCOPES,
  clientHasScope,
  embeddedActor,
  generateApiKey,
  hashApiKey,
  isValidScope,
  timingSafeEqualStr,
} from "./embeddedApi";

describe("embeddedApi credentials", () => {
  it("stores only sha256 hex digests (64 chars), never plaintext", () => {
    const key = generateApiKey();
    expect(key.startsWith("emb_")).toBe(true);
    const digest = hashApiKey(key);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).not.toContain("emb_");
    expect(hashApiKey(key)).toBe(digest); // deterministic
    expect(hashApiKey(key + "x")).not.toBe(digest);
  });

  it("timingSafeEqualStr is length-guarded (no throw on mismatch)", () => {
    const a = hashApiKey("a");
    expect(timingSafeEqualStr(a, a)).toBe(true);
    expect(timingSafeEqualStr(a, hashApiKey("b"))).toBe(false);
    expect(timingSafeEqualStr(a, a.slice(0, 32))).toBe(false); // length mismatch
    expect(timingSafeEqualStr("", "")).toBe(true);
  });

  it("scopes are a closed set; clientHasScope checks membership", () => {
    expect(EMBEDDED_SCOPES).toContain("bills:read");
    expect(isValidScope("payments:write")).toBe(true);
    expect(isValidScope("admin:all")).toBe(false);
    const client = { scopes: ["bills:read"] } as any;
    expect(clientHasScope(client, "bills:read")).toBe(true);
    expect(clientHasScope(client, "bills:write")).toBe(false);
    expect(clientHasScope({ scopes: null } as any, "bills:read")).toBe(false);
  });

  it("audit actor label is embedded:<clientId>", () => {
    const id = "11111111-2222-3333-4444-555555555555";
    expect(embeddedActor({ id } as any)).toBe(`embedded:${id}`);
    expect(`embedded:${id}`.length).toBeLessThanOrEqual(64); // fits audit_logs.actor_id
  });
});
