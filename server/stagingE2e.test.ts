/**
 * staging-e2e script — env parsing, skip logic, PASS/FAIL matrix, and step
 * behavior with a mocked network. The script itself is NOT part of the vitest
 * suite; these unit tests import its pure/exported functions.
 */
import { describe, it, expect, vi } from "vitest";
import {
  parseEnv,
  renderMatrix,
  hasFailure,
  stepHealth,
  stepMeta,
  stepPaystack,
  stepIntegrations,
  type StagingEnv,
  type StepResult,
} from "../scripts/staging-e2e";

const okJson = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("parseEnv", () => {
  it("reads the documented variables and trims blanks", () => {
    const cfg = parseEnv({
      STAGING_BASE_URL: " https://staging.example/ ",
      META_TEST_PHONE_NUMBER_ID: "123",
      META_TEST_ACCESS_TOKEN: " tok ",
      PAYSTACK_TEST_SECRET_KEY: "sk_test_x",
      ODOO_URL: "",
    } as any);
    expect(cfg.baseUrl).toBe("https://staging.example");
    expect(cfg.metaPhoneNumberId).toBe("123");
    expect(cfg.metaAccessToken).toBe("tok");
    expect(cfg.paystackSecretKey).toBe("sk_test_x");
    expect(cfg.odooUrl).toBeUndefined();
    expect(cfg.pollTimeoutMs).toBe(90_000);
  });

  it("missing env yields undefined fields (skip, not fail)", () => {
    const cfg = parseEnv({} as any);
    expect(cfg.baseUrl).toBeUndefined();
    expect(cfg.metaRecipient).toBeUndefined();
    expect(cfg.medusaApiKey).toBeUndefined();
  });

  it("honours STAGING_POLL_TIMEOUT_MS", () => {
    expect(parseEnv({ STAGING_POLL_TIMEOUT_MS: "5000" } as any).pollTimeoutMs).toBe(5000);
  });
});

describe("matrix rendering + exit-code input", () => {
  it("renderMatrix lists each step and the totals", () => {
    const results: StepResult[] = [
      { step: "health.ready", status: "PASS" },
      { step: "meta.send", status: "FAIL", detail: "boom" },
      { step: "paystack.init", status: "SKIP", detail: "unset" },
    ];
    const text = renderMatrix(results);
    expect(text).toContain("health.ready");
    expect(text).toContain("FAIL — boom");
    expect(text).toContain("PASS=1 FAIL=1 SKIP=1");
  });

  it("hasFailure drives the non-zero exit code", () => {
    expect(hasFailure([{ step: "a", status: "PASS" }, { step: "b", status: "SKIP" }])).toBe(false);
    expect(hasFailure([{ step: "a", status: "PASS" }, { step: "b", status: "FAIL" }])).toBe(true);
  });
});

describe("stepHealth", () => {
  it("SKIPs when STAGING_BASE_URL is unset", async () => {
    const r = await stepHealth({});
    expect(r[0]).toMatchObject({ step: "health.ready", status: "SKIP" });
  });

  it("PASSes when all readiness components are ok", async () => {
    const fetchFn = vi.fn(async () => okJson({ ok: true, components: { db: { ok: true }, redis: { ok: true } } })) as any;
    const r = await stepHealth({ baseUrl: "https://s" } as StagingEnv, fetchFn);
    expect(r[0].status).toBe("PASS");
  });

  it("FAILs naming the not-ready components", async () => {
    const fetchFn = vi.fn(async () => okJson({ ok: false, components: { db: { ok: true }, redis: { ok: false, error: "ping" } } })) as any;
    const r = await stepHealth({ baseUrl: "https://s" } as StagingEnv, fetchFn);
    expect(r[0].status).toBe("FAIL");
    expect(r[0].detail).toContain("redis");
  });

  it("FAILs when the instance is unreachable", async () => {
    const fetchFn = vi.fn(async () => { throw new Error("ECONNREFUSED"); }) as any;
    const r = await stepHealth({ baseUrl: "https://s" } as StagingEnv, fetchFn);
    expect(r[0]).toMatchObject({ status: "FAIL" });
    expect(r[0].detail).toContain("ECONNREFUSED");
  });
});

describe("stepMeta skip logic", () => {
  it("SKIPs everything when Meta creds are unset (no network calls)", async () => {
    const fetchFn = vi.fn() as any;
    const r = await stepMeta({} as StagingEnv, fetchFn);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ step: "meta.credentials", status: "SKIP" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("credential PASS + no recipient → send skipped", async () => {
    const fetchFn = vi.fn(async () => okJson({ id: "123" })) as any; // Graph GET 200
    const r = await stepMeta({ metaPhoneNumberId: "123", metaAccessToken: "tok" } as StagingEnv, fetchFn);
    expect(r.find((s) => s.step === "meta.credentials")?.status).toBe("PASS");
    expect(r.find((s) => s.step === "meta.send")?.status).toBe("SKIP");
  });

  it("send FAILs when Graph rejects the message", async () => {
    const fetchFn = vi.fn(async (url: any) => {
      if (String(url).includes("/messages")) return okJson({ error: { message: "bad" } }, 400);
      return okJson({ id: "123" });
    }) as any;
    const r = await stepMeta(
      { metaPhoneNumberId: "123", metaAccessToken: "tok", metaRecipient: "234801" } as StagingEnv,
      fetchFn,
    );
    expect(r.find((s) => s.step === "meta.send")?.status).toBe("FAIL");
    expect(r.find((s) => s.step === "meta.roundtrip")?.status).toBe("SKIP");
  });

  it("round-trip SKIPs without admin token (never fails on missing env)", async () => {
    const fetchFn = vi.fn(async (url: any) => {
      if (String(url).includes("/messages")) return okJson({ messages: [{ id: "wamid.1" }] });
      return okJson({ id: "123" });
    }) as any;
    const r = await stepMeta(
      { metaPhoneNumberId: "123", metaAccessToken: "tok", metaRecipient: "234801", baseUrl: "https://s" } as StagingEnv,
      fetchFn,
    );
    expect(r.find((s) => s.step === "meta.send")?.status).toBe("PASS");
    expect(r.find((s) => s.step === "meta.roundtrip")?.status).toBe("SKIP");
  });
});

describe("stepPaystack", () => {
  it("SKIPs without PAYSTACK_TEST_SECRET_KEY", async () => {
    const fetchFn = vi.fn() as any;
    const r = await stepPaystack({} as StagingEnv, fetchFn);
    expect(r[0]).toMatchObject({ status: "SKIP" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("PASSes init + verify on a pending N100 test charge", async () => {
    const fetchFn = vi.fn(async (url: any) => {
      if (String(url).includes("initialize")) {
        return okJson({ status: true, data: { authorization_url: "https://pay/abc", reference: "STG-E2E-1" } });
      }
      return okJson({ status: true, data: { status: "abandoned" } });
    }) as any;
    const r = await stepPaystack({ paystackSecretKey: "sk_test_x" } as StagingEnv, fetchFn);
    expect(r.map((s) => s.status)).toEqual(["PASS", "PASS"]);
    expect(r[0].detail).toContain("STG-E2E-1");
    expect(r[1].detail).toContain("manual");
  });

  it("FAILs init on Paystack error and does not verify", async () => {
    const fetchFn = vi.fn(async () => okJson({ status: false, message: "Invalid key" }, 401)) as any;
    const r = await stepPaystack({ paystackSecretKey: "sk_bad" } as StagingEnv, fetchFn);
    expect(r).toHaveLength(1);
    expect(r[0].status).toBe("FAIL");
  });
});

describe("stepIntegrations skip logic", () => {
  it("SKIPs each integration whose env is unset", async () => {
    const fetchFn = vi.fn() as any;
    const r = await stepIntegrations({} as StagingEnv, fetchFn);
    expect(r.map((s) => s.status)).toEqual(["SKIP", "SKIP", "SKIP"]);
    expect(r.map((s) => s.step)).toEqual(["integration.odoo", "integration.twenty", "integration.medusa"]);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("checks only the configured integrations", async () => {
    const fetchFn = vi.fn(async () => okJson({ jsonrpc: "2.0", result: { server_version: "17.0" } })) as any;
    const r = await stepIntegrations({ odooUrl: "https://odoo.example" } as StagingEnv, fetchFn);
    expect(r.find((s) => s.step === "integration.odoo")?.status).toBe("PASS");
    expect(r.find((s) => s.step === "integration.twenty")?.status).toBe("SKIP");
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(String(fetchFn.mock.calls[0][0])).toContain("odoo.example/jsonrpc");
  });

  it("FAILs with detail when a configured integration rejects", async () => {
    const fetchFn = vi.fn(async () => okJson({ error: "unauthorized" }, 401)) as any;
    const r = await stepIntegrations({ medusaUrl: "https://m.example", medusaApiKey: "bad" } as StagingEnv, fetchFn);
    expect(r.find((s) => s.step === "integration.medusa")?.status).toBe("FAIL");
  });
});
