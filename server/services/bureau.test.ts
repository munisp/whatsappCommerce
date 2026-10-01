// === W56 credit ===
/**
 * bureau.ts pure-part tests: provider resolution (tenant settings → env →
 * sim fallback), sandbox report determinism, idempotency keys, secret
 * envelope resolution. DB-backed flows are covered by journeys J571-J573.
 */
import { describe, it, expect } from "vitest";
import {
  resolveBureauProvider,
  resolveBureauSecret,
  sandboxBureauReport,
  reportEventKey,
  REPORT_BACKOFF_MS,
  BUREAU_CONSENT_VERSION,
  type BureauSubjectRef,
} from "./bureau";
import { encryptSecret } from "./crypto/secrets";

const subject: BureauSubjectRef = { subjectType: "buyer", subjectId: "cust-1", phone: "+2348012345678" };

describe("W56 bureau pure parts", () => {
  it("tenant settings win over env; env wins over default", () => {
    expect(resolveBureauProvider({ bureau: { provider: "firstcentral" } }, {} as any)).toBe("firstcentral");
    expect(resolveBureauProvider(null, { BUREAU_W56_PROVIDER: "crc" } as any)).toBe("crc");
    expect(resolveBureauProvider(null, {} as any)).toBe("disabled");
  });

  it("sim env falls back to the deterministic sandbox adapter", () => {
    expect(resolveBureauProvider(null, { SIM_MODE: "true" } as any)).toBe("sandbox");
    expect(resolveBureauProvider(null, { BUREAU_SIM: "true" } as any)).toBe("sandbox");
  });

  it("unknown provider strings fall back safely", () => {
    expect(resolveBureauProvider({ bureau: { provider: "nonsense" } }, {} as any)).toBe("disabled");
  });

  it("sandbox reports are deterministic per subject+consent", () => {
    const a = sandboxBureauReport(subject, "consent-1");
    const b = sandboxBureauReport(subject, "consent-1");
    const c = sandboxBureauReport(subject, "consent-2");
    expect(a).toEqual(b);
    expect(a.rawRef).not.toBe(c.rawRef);
    expect(a.score).toBeGreaterThanOrEqual(200);
    expect(a.score).toBeLessThanOrEqual(850);
    expect(a.rawRef.startsWith("sandbox:")).toBe(true);
  });

  it("idempotency keys are stable and length-bounded", () => {
    const e = { tenantId: "t1", subjectType: "buyer" as const, subjectId: "s1", eventType: "paid_on_time" as const, ref: "repay:1" };
    expect(reportEventKey(e)).toBe(reportEventKey({ ...e }));
    expect(reportEventKey(e).length).toBeLessThanOrEqual(160);
    expect(reportEventKey({ ...e, ref: "repay:2" })).not.toBe(reportEventKey(e));
  });

  it("secrets resolve via the decryptSecret envelope, falling back to raw", () => {
    const enc = encryptSecret("crc-live-key-123");
    expect(resolveBureauSecret(enc)).toBe("crc-live-key-123");
    expect(resolveBureauSecret("plain-env-value")).toBe("plain-env-value");
    expect(resolveBureauSecret("")).toBe("");
    expect(resolveBureauSecret(undefined)).toBe("");
  });

  it("backoff ladder is bounded and the consent version is stamped", () => {
    expect(REPORT_BACKOFF_MS).toEqual([60_000, 300_000, 900_000, 3_600_000]);
    expect(BUREAU_CONSENT_VERSION).toBe("w14-v1");
  });
});
