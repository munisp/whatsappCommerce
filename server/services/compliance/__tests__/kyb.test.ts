import { describe, it, expect, beforeEach } from "vitest";
import { runKybChecks, type KybRecommendation } from "../index";
import { __resetSanctionsCache } from "../sanctions";
import { makeFakeHttp } from "../fakeHttp";

const DRAFT = {
  businessName: "Acme Nigeria Limited",
  registrationNumber: "RC123456",
  country: "NG",
};

const CAC = "https://cac.example.ng/api";
const LIST = "https://lists.example.com/sanctions.json";

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    COMPLIANCE_REGISTRY_PROVIDER: "cac",
    CAC_API_BASE: CAC,
    CAC_API_KEY: "key",
    SANCTIONS_LIST_URL: LIST,
    ...extra,
  } as NodeJS.ProcessEnv;
}

type RegistryResp = { status: number; body: unknown } | { error: Error };
type ListResp = { status: number; body: unknown } | { error: Error };

function http(registry: RegistryResp, list: ListResp) {
  return makeFakeHttp({ routes: { [CAC]: registry as never, [LIST]: list as never } });
}

const REG_OK: RegistryResp = { status: 200, body: { companyName: "Acme Nigeria Limited" } };
const REG_MISMATCH: RegistryResp = { status: 200, body: { companyName: "Different Ventures PLC" } };
const REG_404: RegistryResp = { status: 404, body: {} };
const REG_DOWN: RegistryResp = { error: new Error("down") };
const LIST_CLEAN: ListResp = { status: 200, body: [{ name: "Unrelated Sanctioned Person" }] };
const LIST_HIT: ListResp = { status: 200, body: [{ name: "Acme Nigeria Limited", list: "OFAC-SDN" }] };
const LIST_DOWN: ListResp = { error: new Error("down") };

beforeEach(() => __resetSanctionsCache());

describe("runKybChecks decision matrix", () => {
  const cases: Array<[string, RegistryResp, ListResp, NodeJS.ProcessEnv, KybRecommendation]> = [
    // verified registry
    ["verified + clean list => auto_approve", REG_OK, LIST_CLEAN, env(), "auto_approve"],
    ["verified + sanctions hit => reject", REG_OK, LIST_HIT, env(), "reject"],
    ["verified + degraded sanctions (prod) => manual_review", REG_OK, LIST_DOWN, env({ NODE_ENV: "production" }), "manual_review"],
    // mismatch
    ["mismatch + clean => manual_review", REG_MISMATCH, LIST_CLEAN, env(), "manual_review"],
    ["mismatch + hit => reject (sanctions dominates)", REG_MISMATCH, LIST_HIT, env(), "reject"],
    // not_found
    ["not_found + clean => manual_review", REG_404, LIST_CLEAN, env(), "manual_review"],
    ["not_found + hit => reject", REG_404, LIST_HIT, env(), "reject"],
    // unavailable
    ["unavailable + clean => manual_review", REG_DOWN, LIST_CLEAN, env(), "manual_review"],
    ["unavailable + degraded sanctions => manual_review", REG_DOWN, LIST_DOWN, env({ NODE_ENV: "production" }), "manual_review"],
  ];

  for (const [name, reg, list, e, expected] of cases) {
    it(name, async () => {
      const res = await runKybChecks(DRAFT, { env: e, http: http(reg, list) });
      expect(res.recommendation).toBe(expected);
      expect(res.reasons.length).toBeGreaterThan(0);
    });
  }
});

describe("runKybChecks result shape", () => {
  it("auto_approve carries both sub-results and explanatory reasons", async () => {
    const res = await runKybChecks(DRAFT, { env: env(), http: http(REG_OK, LIST_CLEAN) });
    expect(res.registry.status).toBe("verified");
    expect(res.sanctions.hit).toBe(false);
    expect(res.reasons.join(" ")).toContain("registry verified");
  });

  it("reject reason names the sanctioned entity and list", async () => {
    const res = await runKybChecks(DRAFT, { env: env(), http: http(REG_OK, LIST_HIT) });
    expect(res.recommendation).toBe("reject");
    expect(res.reasons.join(" ")).toContain("Acme Nigeria Limited");
    expect(res.reasons.join(" ")).toContain("OFAC-SDN");
  });

  it("degraded sanctions reason mentions manual review", async () => {
    const res = await runKybChecks(DRAFT, {
      env: env({ NODE_ENV: "production" }),
      http: http(REG_OK, LIST_DOWN),
    });
    expect(res.recommendation).toBe("manual_review");
    expect(res.reasons.join(" ")).toContain("degraded");
  });

  it("recommendation is advisory: reject still returns full sub-results for the reviewer", async () => {
    const res = await runKybChecks(DRAFT, { env: env(), http: http(REG_404, LIST_HIT) });
    expect(res.recommendation).toBe("reject");
    expect(res.registry.status).toBe("not_found");
    expect(res.sanctions.matches.length).toBeGreaterThan(0);
  });
});
