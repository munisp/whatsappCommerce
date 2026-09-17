/**
 * W42 (PLT-13) — cron JWT hardening: per-route scope, jti replay, short exp.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  __setCronReplayStoreForTest,
  assertCronClaimsHardened,
  consumeCronJti,
  MAX_CRON_TOKEN_TTL_SECONDS,
} from "./cronAuth";

function claims(scope: string, jti: string, ttl = 300) {
  const now = Math.floor(Date.now() / 1000);
  return {
    openId: "cron_scheduler",
    task_uid: `scheduler:${scope}`,
    scope,
    jti,
    iat: now,
    exp: now + ttl,
  };
}

afterEach(() => __setCronReplayStoreForTest(null));

describe("assertCronClaimsHardened", () => {
  it("accepts a correctly scoped token on its own route", async () => {
    await expect(
      assertCronClaimsHardened(claims("/api/scheduled/a", "jti-t1-abcdefgh"), "/api/scheduled/a"),
    ).resolves.toBeUndefined();
  });

  it("rejects a token scoped to another route", async () => {
    await expect(
      assertCronClaimsHardened(claims("/api/scheduled/a", "jti-t2-abcdefgh"), "/api/scheduled/b"),
    ).rejects.toThrow(/cannot invoke/);
  });

  it("rejects scope/task_uid mismatch, missing scope, long lifetime, missing jti", async () => {
    const c1 = claims("/api/scheduled/a", "jti-t3-abcdefgh");
    c1.task_uid = "scheduler:/api/scheduled/b";
    await expect(assertCronClaimsHardened(c1, "/api/scheduled/a")).rejects.toThrow(/task_uid/);

    const c2 = claims("/api/scheduled/a", "jti-t4-abcdefgh") as Record<string, unknown>;
    delete c2.scope;
    await expect(assertCronClaimsHardened(c2, "/api/scheduled/a")).rejects.toThrow(/scope/);

    await expect(
      assertCronClaimsHardened(claims("/api/scheduled/a", "jti-t5-abcdefgh", MAX_CRON_TOKEN_TTL_SECONDS + 1), "/api/scheduled/a"),
    ).rejects.toThrow(/lifetime/);

    const c4 = claims("/api/scheduled/a", "jti-t6-abcdefgh") as Record<string, unknown>;
    delete c4.jti;
    await expect(assertCronClaimsHardened(c4, "/api/scheduled/a")).rejects.toThrow(/jti/);
  });

  it("rejects a replayed jti via the shared replay cache", async () => {
    const seen = new Set<string>();
    __setCronReplayStoreForTest({
      async setIfAbsent(key: string) {
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      },
    });
    const c = claims("/api/scheduled/a", "dup-jti-abcdefgh");
    await assertCronClaimsHardened({ ...c }, "/api/scheduled/a");
    await expect(assertCronClaimsHardened({ ...c }, "/api/scheduled/a")).rejects.toThrow(/replay/i);
  });
});

describe("consumeCronJti", () => {
  it("first use true, replay false (injected store)", async () => {
    const seen = new Set<string>();
    __setCronReplayStoreForTest({
      async setIfAbsent(key: string) {
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      },
    });
    const exp = Math.floor(Date.now() / 1000) + 60;
    expect(await consumeCronJti("abc12345", exp)).toBe(true);
    expect(await consumeCronJti("abc12345", exp)).toBe(false);
  });
});
