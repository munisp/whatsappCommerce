/**
 * W15 catalog extraction adapter tests — provider resolution, customHttp
 * contract, timeout, secret redaction. All network via makeFakeHttp.
 */
import { describe, it, expect } from "vitest";
import {
  extractionProvider,
  extractionTimeoutMs,
  getExtractionAdapter,
} from "../extraction";
import { makeFakeHttp, HttpTimeoutError } from "../../compliance/fakeHttp";

const ENV_HTTP = {
  CATALOG_EXTRACTION_PROVIDER: "customHttp",
  CATALOG_EXTRACTION_ENDPOINT: "https://vision.example.test/extract",
  CATALOG_EXTRACTION_API_KEY: "sekret-extract-123",
} as NodeJS.ProcessEnv;

const REQ = {
  tenantId: "t1",
  imageUrl: "https://cdn.example.test/list.jpg",
  mimeType: "image/jpeg",
  hints: { currency: "NGN" },
};

describe("extractionProvider / config", () => {
  it("defaults to 'disabled' when unset", () => {
    expect(extractionProvider({} as NodeJS.ProcessEnv)).toBe("disabled");
    expect(getExtractionAdapter({ env: {} as NodeJS.ProcessEnv }).name).toBe("disabled");
  });

  it("unknown provider strings fall back to 'disabled' (fail-safe)", () => {
    expect(extractionProvider({ CATALOG_EXTRACTION_PROVIDER: "openai" } as NodeJS.ProcessEnv)).toBe("disabled");
  });

  it("parses customHttp case-insensitively", () => {
    expect(extractionProvider({ CATALOG_EXTRACTION_PROVIDER: "CustomHttp" } as NodeJS.ProcessEnv)).toBe("customHttp");
  });

  it("timeout defaults to 8000 and honors a positive override", () => {
    expect(extractionTimeoutMs({} as NodeJS.ProcessEnv)).toBe(8000);
    expect(extractionTimeoutMs({ CATALOG_EXTRACTION_TIMEOUT_MS: "3000" } as NodeJS.ProcessEnv)).toBe(3000);
    expect(extractionTimeoutMs({ CATALOG_EXTRACTION_TIMEOUT_MS: "-1" } as NodeJS.ProcessEnv)).toBe(8000);
  });
});

describe("disabled adapter", () => {
  it("extract throws extraction_disabled", async () => {
    const adapter = getExtractionAdapter({ env: {} as NodeJS.ProcessEnv });
    await expect(adapter.extract(REQ)).rejects.toThrow("extraction_disabled");
  });
});

describe("customHttp adapter", () => {
  it("POSTs image + hints with bearer auth and parses {items}", async () => {
    const http = makeFakeHttp({
      routes: {
        "https://vision.example.test": {
          status: 200,
          body: { items: [{ name: "Rice", price: "₦1,500" }], ref: "up-1" },
        },
      },
    });
    const adapter = getExtractionAdapter({ env: ENV_HTTP, http });
    const res = await adapter.extract(REQ);
    expect(res.items).toHaveLength(1);
    expect(res.upstreamRef).toBe("up-1");
    const req = http.requests[0];
    expect(req.method).toBe("POST");
    expect(req.headers?.authorization).toBe("Bearer sekret-extract-123");
    const body = JSON.parse(req.body!);
    expect(body.imageUrl).toBe(REQ.imageUrl);
    expect(body.mimeType).toBe("image/jpeg");
    expect(body.hints).toEqual({ currency: "NGN" });
    expect(req.timeoutMs).toBe(8000);
  });

  it("sends imageBase64 when provided instead of imageUrl", async () => {
    const http = makeFakeHttp({
      routes: { "https://vision.example.test": { status: 200, body: { items: [] } } },
    });
    const adapter = getExtractionAdapter({ env: ENV_HTTP, http });
    await adapter.extract({ tenantId: "t1", imageBase64: "QUJD", mimeType: "image/png" });
    const body = JSON.parse(http.requests[0].body!);
    expect(body.imageBase64).toBe("QUJD");
    expect(body.imageUrl).toBeUndefined();
  });

  it("non-2xx throws with the API key redacted from the message", async () => {
    const http = makeFakeHttp({
      routes: {
        "https://vision.example.test": { status: 401, body: "bad key sekret-extract-123" },
      },
    });
    const adapter = getExtractionAdapter({ env: ENV_HTTP, http });
    await expect(adapter.extract(REQ)).rejects.toThrow(/HTTP 401/);
    try {
      await adapter.extract(REQ);
    } catch (e) {
      expect((e as Error).message).not.toContain("sekret-extract-123");
    }
  });

  it("missing endpoint throws a config error (no request sent)", async () => {
    const http = makeFakeHttp({ routes: {} });
    const adapter = getExtractionAdapter({
      env: { CATALOG_EXTRACTION_PROVIDER: "customHttp" } as NodeJS.ProcessEnv,
      http,
    });
    await expect(adapter.extract(REQ)).rejects.toThrow("CATALOG_EXTRACTION_ENDPOINT");
    expect(http.requests).toHaveLength(0);
  });

  it("times out slow upstreams (override honored)", async () => {
    const http = makeFakeHttp({ routes: {}, latencyMs: 50 });
    const adapter = getExtractionAdapter({
      env: { ...ENV_HTTP, CATALOG_EXTRACTION_TIMEOUT_MS: "10" } as NodeJS.ProcessEnv,
      http,
    });
    await expect(adapter.extract(REQ)).rejects.toBeInstanceOf(HttpTimeoutError);
  });

  it("malformed upstream body (no items array) yields empty items, not a crash", async () => {
    const http = makeFakeHttp({
      routes: { "https://vision.example.test": { status: 200, body: "not json object" } },
    });
    const adapter = getExtractionAdapter({ env: ENV_HTTP, http });
    const res = await adapter.extract(REQ);
    expect(res.items).toEqual([]);
  });
});
