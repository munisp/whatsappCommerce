/**
 * Full Integration Test Suite
 * Tests all 12 services, tRPC endpoints, ONNX pipeline, and middleware
 */
import { describe, it, expect } from "vitest";

const BASE = process.env.TEST_BASE_URL ?? "https://wa-app.newfire.app";
const TIMEOUT = 15_000;

async function get(path: string) {
  return fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(TIMEOUT) });
}

async function post(path: string, body: unknown) {
  return fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT),
  });
}

async function trpcGet(procedure: string, input?: unknown) {
  const url = input !== undefined
    ? `${BASE}/api/trpc/${procedure}?input=${encodeURIComponent(JSON.stringify(input))}`
    : `${BASE}/api/trpc/${procedure}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT) });
  return { status: res.status, data: await res.json().catch(() => null) };
}

describe("Core Platform", () => {
  it("serves the root page", async () => {
    const res = await get("/");
    expect(res.status).toBe(200);
  });

  it("serves the dashboard page", async () => {
    const res = await get("/dashboard");
    expect(res.status).toBe(200);
  });

  it("returns health status", async () => {
    const res = await get("/api/health");
    expect(res.status).toBe(200);
  });
});

describe("ML Fraud Detection Pipeline", () => {
  it("returns fraud probability for low-risk transaction", async () => {
    const res = await post("/api/ml/predict", {
      tenantId: "demo",
      amount: 5000,
      phone: "+2348012345678",
      items: [{ id: "p1", qty: 1 }],
      customerId: "cust-001",
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveProperty("fraudProbability");
    expect(data).toHaveProperty("creditScore");
    expect(data).toHaveProperty("riskLevel");
    expect(data.riskLevel).toBe("low");
    expect(data.fraudProbability).toBeLessThan(0.4);
  });

  it("returns high fraud probability for suspicious transaction", async () => {
    const res = await post("/api/ml/predict", {
      tenantId: "demo",
      amount: 750000,
      phone: "",
      items: Array(60).fill({ id: "p1", qty: 1 }),
      customerId: null,
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.riskLevel).toBe("high");
    expect(data.fraudProbability).toBeGreaterThan(0.7);
  });

  it("returns source field indicating model used", async () => {
    const res = await post("/api/ml/predict", {
      amount: 10000,
      phone: "+2348012345678",
      customerId: "c1",
    });
    const data = await res.json();
    expect(data).toHaveProperty("source");
    expect(["ml_inference_server", "statistical_model", "heuristic"]).toContain(data.source);
  });

  it("handles zero-amount transactions as high risk", async () => {
    const res = await post("/api/ml/predict", {
      amount: 0,
      phone: "+2348012345678",
      customerId: "c1",
    });
    const data = await res.json();
    expect(data.fraudProbability).toBeGreaterThan(0.5);
  });
});

describe("tRPC Endpoints", () => {
  it("auth.me returns user or unauthorized", async () => {
    const { status } = await trpcGet("auth.me");
    expect([200, 401, 403]).toContain(status);
  });

  it("infra.infraHealth is accessible", async () => {
    const { status } = await trpcGet("infra.infraHealth");
    expect([200, 401, 403]).toContain(status);
  });

  it("temporal.health returns temporal status", async () => {
    const { status } = await trpcGet("temporal.health");
    expect([200, 401, 403]).toContain(status);
  });
});

describe("WhatsApp Integration", () => {
  it("webhook verification endpoint exists", async () => {
    const res = await get("/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=test&hub.challenge=test123");
    expect([200, 403, 401]).toContain(res.status);
  });

  it("inbound message webhook accepts POST", async () => {
    const res = await post("/api/webhooks/whatsapp", {
      object: "whatsapp_business_account",
      entry: [{
        id: "test",
        changes: [{
          value: {
            messaging_product: "whatsapp",
            messages: [{
              from: "2348012345678",
              id: "wamid.test123",
              timestamp: "1234567890",
              type: "text",
              text: { body: "Hello" },
            }],
          },
          field: "messages",
        }],
      }],
    });
    expect([200, 400, 401, 403]).toContain(res.status);
  });
});

describe("Payment Webhooks", () => {
  it("Paystack webhook endpoint exists", async () => {
    const res = await post("/api/webhooks/paystack", {
      event: "charge.success",
      data: { reference: "test-ref", amount: 100000, status: "success" },
    });
    expect([200, 400, 401, 403]).toContain(res.status);
  });
});

describe("Infrastructure Health", () => {
  it("Temporal health endpoint responds", async () => {
    const res = await get("/api/health/temporal");
    expect([200, 503]).toContain(res.status);
  });
});

describe("Concurrent Load Simulation", () => {
  it("handles 20 concurrent ML predict requests", async () => {
    const requests = Array(20).fill(null).map((_, i) =>
      post("/api/ml/predict", {
        amount: (i + 1) * 10000,
        phone: `+234801234567${i % 10}`,
        customerId: `stress-test-${i}`,
      })
    );
    const results = await Promise.allSettled(requests);
    const successes = results.filter(r => r.status === "fulfilled" && (r.value as Response).status === 200);
    expect(successes.length).toBeGreaterThanOrEqual(18);
  });
});
