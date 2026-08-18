import { describe, it, expect } from "vitest";
import { join } from "path";
import {
  runChecks,
  summarize,
  scanEnvExample,
  checkDocsPack,
  checkEnvExample,
  SOC2_DOCS,
  type CheckResult,
} from "./soc2-check";

const ROOT = join(__dirname, "..");

function byId(results: CheckResult[], id: string): CheckResult {
  const r = results.find((x) => x.id === id);
  if (!r) throw new Error(`check ${id} not found`);
  return r;
}

describe("soc2-check against this repository", () => {
  const results = runChecks(ROOT);

  it("finds every SOC2 pack doc (PASS)", () => {
    for (const doc of SOC2_DOCS) {
      expect(byId(results, `docs:${doc}`).status, doc).toBe("PASS");
    }
  });

  it("core control files PASS (compliance router, authz scanner, paymentConfirm)", () => {
    for (const id of [
      "file:server/routers/compliance.ts",
      "file:server/routers/__tests__/authzScan.lib.ts",
      "file:server/routers/__tests__/authzCoverage.test.ts",
      "file:server/services/paymentConfirm.ts",
      "file:scripts/soc2-check.ts",
    ]) {
      expect(byId(results, id).status, id).toBe("PASS");
    }
  });

  it("env.example.txt contains no real-looking secrets", () => {
    expect(byId(results, "env:example").status).toBe("PASS");
  });

  it("exits non-zero only on FAIL", () => {
    const { exitCode } = summarize(results);
    expect([0, 1]).toContain(exitCode);
    expect(exitCode).toBe(results.some((r) => r.status === "FAIL") ? 1 : 0);
    // This wave's own deliverables must not FAIL on the repo itself.
    expect(results.filter((r) => r.status === "FAIL")).toEqual([]);
  });
});

describe("scanEnvExample heuristics", () => {
  it("accepts placeholders", () => {
    const findings = scanEnvExample(
      [
        "JWT_SECRET=change-me-in-production-min-32-chars",
        "OPENAI_API_KEY=sk-...",
        "WHATSAPP_VERIFY_TOKEN=your-webhook-verify-token",
        "# COMMENTED_OUT_TOKEN=AKIAIOSFODNN7EXAMPLE",
        "PLAIN_FLAG=enabled",
      ].join("\n"),
    );
    expect(findings).toEqual([]);
  });

  it("flags real-looking secrets", () => {
    const findings = scanEnvExample(
      ["STRIPE_SECRET_KEY=rk_live_9f8e7d6c5b4a3210abcd", "NORMAL=value"].join("\n"),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].key).toBe("STRIPE_SECRET_KEY");
  });
});

describe("checkDocsPack on a synthetic missing tree", () => {
  it("reports FAIL for missing docs", () => {
    const res = checkDocsPack(join(ROOT, "definitely-not-here"));
    expect(res.every((r) => r.status === "FAIL")).toBe(true);
  });
});

describe("checkEnvExample file handling", () => {
  it("FAILs when env.example.txt is absent", () => {
    const res = checkEnvExample(join(ROOT, "definitely-not-here"));
    expect(res.status).toBe("FAIL");
  });
});
