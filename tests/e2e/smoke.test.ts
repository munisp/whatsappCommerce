/**
 * SMOKE — every service in the E2E compose stack answers its documented
 * health route with 200.
 *
 * Health-path evidence (grep-verified against source at 626cb97):
 *   platform         GET /api/health/postgres   server/_core/index.ts:2069
 *   platform         GET /api/health/redis      server/_core/index.ts:2082
 *   platform         GET /api/health/tigerbeetle server/_core/index.ts:2093
 *   api-gateway      GET /health                services/gateway/cmd/main.go:144
 *   api-gateway      GET /ready                 services/gateway/cmd/main.go:159
 *   commerce-engine  GET /health                services/commerce-engine/cmd/main.go:33
 *   ledger-bridge    GET /health                rust/ledger-bridge/src/main.rs (route table ~L747)
 *   recon-worker     GET /health                rust/recon-worker/src/main.rs:307
 *   ml-inference     GET /health                services/ml-stack/inference/server.py:320
 */
import { describe, it, expect } from "vitest";
import { CFG, getJson } from "./helpers/stack";

describe("smoke: service health endpoints", () => {
  it("platform /api/health/postgres → 200 { online: true }", async () => {
    const { status, body } = await getJson(CFG.platformUrl, "/api/health/postgres");
    expect(status).toBe(200);
    expect(body).toMatchObject({ online: true });
    expect(typeof body.latencyMs).toBe("number");
  });

  it("platform /api/health/redis → 200 { online: true }", async () => {
    const { status, body } = await getJson(CFG.platformUrl, "/api/health/redis");
    expect(status).toBe(200);
    expect(body).toMatchObject({ online: true });
  });

  it("platform /api/health/tigerbeetle → 200 (ledger-bridge reachable)", async () => {
    const { status, body } = await getJson(CFG.platformUrl, "/api/health/tigerbeetle");
    expect(status).toBe(200);
    expect(body).toMatchObject({ online: true });
  });

  it("gateway /health → 200 with service + middleware map", async () => {
    const { status, body } = await getJson(CFG.gatewayUrl, "/health");
    expect(status).toBe(200);
    expect(body).toMatchObject({ status: "ok", service: "gateway" });
    expect(body).toHaveProperty("middleware");
  });

  it("gateway /ready → 200", async () => {
    const { status, body } = await getJson(CFG.gatewayUrl, "/ready");
    expect(status).toBe(200);
    expect(body).toMatchObject({ status: "ready" });
  });

  it("commerce-engine /health → 200", async () => {
    const { status, body } = await getJson(CFG.commerceUrl, "/health");
    expect(status).toBe(200);
    expect(body).toHaveProperty("status");
  });

  it("ledger-bridge /health → 200 with tigerbeetle + postgres substatus", async () => {
    const { status, body } = await getJson(CFG.ledgerUrl, "/health");
    expect(status).toBe(200);
    // NB: postgres.healthy is derived from the deadpool connection count and
    // only flips true after the pool is first used — assert shape, not value.
    expect(body).toHaveProperty("tigerbeetle.healthy");
    expect(body).toHaveProperty("postgres.healthy");
  });

  it("recon-worker /health → 200", async () => {
    const { status, body } = await getJson(CFG.reconUrl, "/health");
    expect(status).toBe(200);
    expect(body).toHaveProperty("status");
  });

  it("ml-inference /health → 200 with model status map", async () => {
    const { status, body } = await getJson(CFG.mlUrl, "/health");
    expect(status).toBe(200);
    expect(body).toMatchObject({ status: "ok", service: "ml-inference" });
    expect(body).toHaveProperty("models.fraud");
    expect(body).toHaveProperty("models.credit");
  });
});
