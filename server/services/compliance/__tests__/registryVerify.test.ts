import { describe, it, expect } from "vitest";
import {
  verifyBusinessRegistration,
  isVerifiedForGate,
  normalizeName,
  nameSimilarity,
} from "../registryVerify";
import { makeFakeHttp, HttpTimeoutError } from "../fakeHttp";

const BASE = { registrationNumber: "RC123456", businessName: "Acme Nigeria Limited", country: "NG" };

const cacEnv = (extra: Record<string, string> = {}): NodeJS.ProcessEnv =>
  ({
    COMPLIANCE_REGISTRY_PROVIDER: "cac",
    CAC_API_BASE: "https://cac.example.ng/api",
    CAC_API_KEY: "super-secret-cac-key",
    ...extra,
  }) as NodeJS.ProcessEnv;

describe("normalizeName / nameSimilarity", () => {
  it("normalizes case, diacritics and punctuation", () => {
    expect(normalizeName("  Àcmé Níg. (Ltd.) ")).toBe("acme nig ltd");
  });
  it("token overlap: identical sets score 1", () => {
    expect(nameSimilarity("Acme Nigeria Limited", "acme nigeria limited")).toBe(1);
  });
  it("token overlap: disjoint names score 0", () => {
    expect(nameSimilarity("Acme Nigeria", "Zulu Farms")).toBe(0);
  });
  it("partial overlap scores between 0 and 1", () => {
    const s = nameSimilarity("Acme Nigeria Limited", "Acme Nigeria Enterprises");
    expect(s).toBeGreaterThan(0.5);
    expect(s).toBeLessThan(1);
  });
});

describe("cac provider", () => {
  it("verified: name matches at >=0.8 token overlap", async () => {
    const http = makeFakeHttp({
      routes: {
        "https://cac.example.ng/api": {
          status: 200,
          body: { companyName: "Acme Nigeria Limited" },
        },
      },
    });
    const res = await verifyBusinessRegistration(BASE, { env: cacEnv(), http });
    expect(res).toEqual({
      verified: true,
      matchedName: "Acme Nigeria Limited",
      status: "verified",
      provider: "cac",
    });
  });

  it("mismatch: registry name differs materially", async () => {
    const http = makeFakeHttp({
      routes: {
        "https://cac.example.ng/api": { status: 200, body: { companyName: "Different Ventures PLC" } },
      },
    });
    const res = await verifyBusinessRegistration(BASE, { env: cacEnv(), http });
    expect(res.status).toBe("mismatch");
    expect(res.verified).toBe(false);
    expect(res.matchedName).toBe("Different Ventures PLC");
  });

  it("not_found: 404 from registry", async () => {
    const http = makeFakeHttp({
      routes: { "https://cac.example.ng/api": { status: 404, body: {} } },
    });
    const res = await verifyBusinessRegistration(BASE, { env: cacEnv(), http });
    expect(res.status).toBe("not_found");
    expect(res.verified).toBe(false);
  });

  it("unavailable: 500 from registry", async () => {
    const http = makeFakeHttp({
      routes: { "https://cac.example.ng/api": { status: 500, body: {} } },
    });
    const res = await verifyBusinessRegistration(BASE, { env: cacEnv(), http });
    expect(res.status).toBe("unavailable");
  });

  it("unavailable: network error", async () => {
    const http = makeFakeHttp({
      routes: { "https://cac.example.ng/api": { error: new Error("ECONNREFUSED") } },
    });
    const res = await verifyBusinessRegistration(BASE, { env: cacEnv(), http });
    expect(res.status).toBe("unavailable");
  });

  it("timeout: slow upstream collapses to unavailable, never throws", async () => {
    const http = makeFakeHttp({
      latencyMs: 60_000,
      routes: { "https://cac.example.ng/api": { status: 200, body: { companyName: "x" } } },
    });
    const res = await verifyBusinessRegistration(BASE, { env: cacEnv(), http });
    expect(res.status).toBe("unavailable");
    expect(res.verified).toBe(false);
  });

  it("no retry on 4xx: exactly one request is made", async () => {
    const http = makeFakeHttp({
      routes: { "https://cac.example.ng/api": { status: 401, body: {} } },
    });
    const res = await verifyBusinessRegistration(BASE, { env: cacEnv(), http });
    expect(res.status).toBe("unavailable");
    expect(http.requests).toHaveLength(1);
  });

  it("sends the API key as a Bearer token", async () => {
    const http = makeFakeHttp({
      routes: {
        "https://cac.example.ng/api": { status: 200, body: { companyName: "Acme Nigeria Limited" } },
      },
    });
    await verifyBusinessRegistration(BASE, { env: cacEnv(), http });
    expect(http.requests[0].headers?.Authorization).toBe("Bearer super-secret-cac-key");
    expect(http.requests[0].url).toContain("rcNumber=RC123456");
  });

  it("misconfigured cac (missing key) degrades to disabled/unavailable", async () => {
    const http = makeFakeHttp({ routes: {} });
    const res = await verifyBusinessRegistration(BASE, {
      env: { COMPLIANCE_REGISTRY_PROVIDER: "cac" } as NodeJS.ProcessEnv,
      http,
    });
    expect(res.status).toBe("unavailable");
    expect(res.provider).toBe("disabled");
  });
});

describe("customHttp provider", () => {
  const env = {
    COMPLIANCE_REGISTRY_PROVIDER: "customHttp",
    COMPLIANCE_REGISTRY_BASE_URL: "https://registry.example.com",
    COMPLIANCE_REGISTRY_API_KEY: "k",
  } as NodeJS.ProcessEnv;

  it("verified when found and names match", async () => {
    const http = makeFakeHttp({
      routes: {
        "https://registry.example.com": {
          status: 200,
          body: { found: true, businessName: "Acme Nigeria Limited" },
        },
      },
    });
    const res = await verifyBusinessRegistration(BASE, { env, http });
    expect(res.status).toBe("verified");
    expect(res.provider).toBe("customHttp");
  });

  it("not_found when registry reports no record", async () => {
    const http = makeFakeHttp({
      routes: { "https://registry.example.com": { status: 200, body: { found: false } } },
    });
    const res = await verifyBusinessRegistration(BASE, { env, http });
    expect(res.status).toBe("not_found");
  });

  it("unavailable on timeout error", async () => {
    const http = makeFakeHttp({
      routes: { "https://registry.example.com": { error: new HttpTimeoutError() } },
    });
    const res = await verifyBusinessRegistration(BASE, { env, http });
    expect(res.status).toBe("unavailable");
  });
});

describe("disabled provider (default)", () => {
  it("always unavailable", async () => {
    const res = await verifyBusinessRegistration(BASE, {
      env: {} as NodeJS.ProcessEnv,
      http: makeFakeHttp({ routes: {} }),
    });
    expect(res).toEqual({ verified: false, status: "unavailable", provider: "disabled" });
  });
});

describe("fail-closed gate semantics", () => {
  const prod = { NODE_ENV: "production", KYB_GATE_ACTIVE: "true" } as NodeJS.ProcessEnv;
  it("prod + gate: unavailable does NOT count as verified", () => {
    expect(
      isVerifiedForGate({ verified: false, status: "unavailable", provider: "cac" }, prod),
    ).toBe(false);
  });
  it("prod + gate: not_found does NOT count as verified", () => {
    expect(
      isVerifiedForGate({ verified: false, status: "not_found", provider: "cac" }, prod),
    ).toBe(false);
  });
  it("prod + gate: verified counts", () => {
    expect(
      isVerifiedForGate(
        { verified: true, matchedName: "Acme", status: "verified", provider: "cac" },
        prod,
      ),
    ).toBe(true);
  });
  it("a malformed result claiming verified with unavailable status is rejected", () => {
    expect(
      isVerifiedForGate({ verified: true, status: "unavailable", provider: "cac" }, prod),
    ).toBe(false);
  });
});
