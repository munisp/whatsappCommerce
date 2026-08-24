/**
 * server/stepUpRateLimit.test.ts — W30 hotfix2: stepUpRequest OTP-bombing brake.
 *
 * phoneAuth.stepUpRequest sends an SMS/WhatsApp OTP to the tenant admin phone
 * on EVERY call; before this fix there was no throttle, so any tenant member
 * (or a hijacked member session) could bomb the admin phone. The procedure
 * now applies a per-tenant fixed window of 3 challenges / 10 min via the
 * shared fail-closed checkRateLimit (prod outage = deny; dev/test = fail-open
 * — the outage policy itself is pinned in redisOutage.test.ts).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Counting Redis client mock — real fixed-window semantics per key.
const counts = new Map<string, number>();
vi.mock("./redis", () => ({
  getRedis: vi.fn(async () => ({
    incr: vi.fn(async (key: string) => {
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      return n;
    }),
    expire: vi.fn(async () => 1),
  })),
  redisIncrEx: vi.fn(async () => 1),
  acquireIdempotencyLock: vi.fn(async () => true),
  releaseIdempotencyLock: vi.fn(async () => {}),
}));

vi.mock("./db", () => ({
  getDb: vi.fn(async () => ({})),
  withRetry: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

const issueStepUpChallenge = vi.fn(async () => ({ challengeId: "ch-1", ttlSeconds: 600 }));
vi.mock("./services/stepUp", () => ({
  issueStepUpChallenge,
  consumeStepUpChallenge: vi.fn(),
  requireStepUp: vi.fn(),
}));

const { phoneAuthRouter } = await import("./routers/phoneAuth");

function callerFor(tenantId: string) {
  return phoneAuthRouter.createCaller({
    user: {
      id: 7,
      openId: "stepup-rl",
      email: "stepup-rl@example.com",
      name: "StepUp RL",
      loginMethod: "keycloak",
      role: "user",
      tenantId,
      phone: null,
      phoneVerified: false,
      whatsappNotifOrders: true,
      whatsappNotifStatus: true,
      whatsappNotifMarketing: false,
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSignedIn: new Date(),
    },
    req: { protocol: "https", headers: {} },
    res: { clearCookie: () => {} },
  } as never);
}

describe("phoneAuth.stepUpRequest — per-tenant OTP-bombing rate limit", () => {
  beforeEach(() => {
    counts.clear();
    issueStepUpChallenge.mockClear();
  });

  it("allows 3 challenges per 10-min window and rejects the 4th (per tenant)", async () => {
    const caller = callerFor("tenant-rl-a");
    for (let i = 0; i < 3; i++) {
      await expect(
        caller.stepUpRequest({ tenantId: "tenant-rl-a", purpose: "withdrawal" }),
      ).resolves.toMatchObject({ challengeId: "ch-1" });
    }
    await expect(
      caller.stepUpRequest({ tenantId: "tenant-rl-a", purpose: "withdrawal" }),
    ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    // The 4th request never reached the OTP sender.
    expect(issueStepUpChallenge).toHaveBeenCalledTimes(3);
  });

  it("the limit is per-tenant — another tenant is unaffected", async () => {
    const a = callerFor("tenant-rl-a");
    const b = callerFor("tenant-rl-b");
    for (let i = 0; i < 3; i++) {
      await a.stepUpRequest({ tenantId: "tenant-rl-a", purpose: "payout_change" });
    }
    await expect(
      b.stepUpRequest({ tenantId: "tenant-rl-b", purpose: "payout_change" }),
    ).resolves.toMatchObject({ challengeId: "ch-1" });
  });

  it("cross-tenant step-up requests are still FORBIDDEN before any rate limiting", async () => {
    const a = callerFor("tenant-rl-a");
    await expect(
      a.stepUpRequest({ tenantId: "tenant-rl-b", purpose: "owner_grant" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
