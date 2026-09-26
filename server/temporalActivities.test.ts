/**
 * Temporal activities (services/temporal-workflows/activities.ts).
 *
 * Two properties carry the weight:
 *  1. The platform client classifies failures correctly — transient ones (network, 5xx, 429) are
 *     retryable, definitive ones (401/400/404) are not — because that decides whether Temporal
 *     burns its retry budget or fails fast and visibly.
 *  2. A step with no real backing endpoint NEVER returns a fabricated result (W42 doctrine):
 *     KYC / payment / messaging activities throw a non-retryable ActivityNotImplemented.
 */
import { describe, it, expect, vi } from "vitest";
import { ApplicationFailure } from "@temporalio/activity";
import {
  createActivities,
  createApiCall,
  FAILURE_NOT_IMPLEMENTED,
  FAILURE_PLATFORM_REJECTED,
  FAILURE_PLATFORM_UNAVAILABLE,
} from "../services/temporal-workflows/activities";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const cfg = (fetchImpl: typeof fetch) => ({
  baseUrl: "http://server.whatsapp-commerce.svc.cluster.local:3000/",
  internalToken: "tok-123",
  fetchImpl,
});

async function caught(p: Promise<unknown>): Promise<ApplicationFailure> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ApplicationFailure);
    return e as ApplicationFailure;
  }
  throw new Error("expected the call to throw");
}

describe("createApiCall — request shape", () => {
  it("POSTs {json: input} to /api/trpc/<procedure> with the internal token, tolerating a trailing slash", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { result: { data: { json: { ok: true } } } }));
    const apiCall = createApiCall(cfg(fetchImpl as unknown as typeof fetch));
    await apiCall("temporalInternal.syncTenantInventory", { tenantId: "t1" });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://server.whatsapp-commerce.svc.cluster.local:3000/api/trpc/temporalInternal.syncTenantInventory");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["X-Internal-Token"]).toBe("tok-123");
    expect(JSON.parse(init.body as string)).toEqual({ json: { tenantId: "t1" } });
  });

  it("unwraps the superjson envelope", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { result: { data: { json: { tenantIds: ["a", "b"] } } } }));
    const out = await createApiCall(cfg(fetchImpl as unknown as typeof fetch))<{ tenantIds: string[] }>("x", {});
    expect(out.tenantIds).toEqual(["a", "b"]);
  });
});

describe("createApiCall — failure classification", () => {
  it("a network error is RETRYABLE (PlatformUnavailable)", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const f = await caught(createApiCall(cfg(fetchImpl as unknown as typeof fetch))("x", {}));
    expect(f.nonRetryable).toBe(false);
    expect(f.type).toBe(FAILURE_PLATFORM_UNAVAILABLE);
    expect(f.message).toContain("fetch failed");
  });

  for (const status of [500, 502, 503, 504, 429]) {
    it(`HTTP ${status} is RETRYABLE`, async () => {
      const fetchImpl = vi.fn(async () => jsonResponse(status, { error: { json: { message: "try later" } } }));
      const f = await caught(createApiCall(cfg(fetchImpl as unknown as typeof fetch))("x", {}));
      expect(f.nonRetryable).toBe(false);
      expect(f.type).toBe(FAILURE_PLATFORM_UNAVAILABLE);
    });
  }

  for (const status of [400, 401, 403, 404]) {
    it(`HTTP ${status} is NON-retryable (PlatformRejected) and carries the server's message`, async () => {
      const fetchImpl = vi.fn(async () => jsonResponse(status, { error: { json: { message: "invalid-internal-api-key" } } }));
      const f = await caught(createApiCall(cfg(fetchImpl as unknown as typeof fetch))("temporalInternal.x", {}));
      expect(f.nonRetryable).toBe(true);
      expect(f.type).toBe(FAILURE_PLATFORM_REJECTED);
      expect(f.message).toContain("invalid-internal-api-key");
      expect(f.message).toContain(String(status));
    });
  }

  it("a non-JSON error body still classifies by status (e.g. a proxy's HTML 502)", async () => {
    const fetchImpl = vi.fn(async () => new Response("<html>Bad Gateway</html>", { status: 502 }));
    const f = await caught(createApiCall(cfg(fetchImpl as unknown as typeof fetch))("x", {}));
    expect(f.nonRetryable).toBe(false);
  });
});

describe("backed activities", () => {
  it("listInventorySyncTenants returns the tenant ids from the platform", async () => {
    const apiCall = vi.fn(async () => ({ tenantIds: ["t1", "t2"] }));
    const a = createActivities({ apiCall: apiCall as any });
    await expect(a.listInventorySyncTenants()).resolves.toEqual(["t1", "t2"]);
    expect(apiCall).toHaveBeenCalledWith("temporalInternal.listInventorySyncTenants", {});
  });

  it("syncTenantInventory passes the tenant id through and returns the platform's result", async () => {
    const apiCall = vi.fn(async () => ({ tenantId: "t1", recordsSynced: 12 }));
    const a = createActivities({ apiCall: apiCall as any });
    await expect(a.syncTenantInventory("t1")).resolves.toEqual({ tenantId: "t1", recordsSynced: 12 });
    expect(apiCall).toHaveBeenCalledWith("temporalInternal.syncTenantInventory", { tenantId: "t1" });
  });
});

describe("honest-failure doctrine — unbacked activities never fabricate success", () => {
  const apiCall = vi.fn();
  const a = createActivities({ apiCall: apiCall as any });

  const unbacked: Array<[string, () => Promise<unknown>]> = [
    ["submitKycForReview", () => a.submitKycForReview("app-1")],
    ["getKycDecision", () => a.getKycDecision("app-1")],
    ["setupBillingPlan", () => a.setupBillingPlan("t1", "subscription")],
    ["validateWhatsAppCredentials", () => a.validateWhatsAppCredentials("t1")],
    ["activateTenant", () => a.activateTenant("t1")],
    ["sendWelcomeMessage", () => a.sendWelcomeMessage("t1", "a@b.co")],
    ["confirmPayment", () => a.confirmPayment("order-1")],
    ["syncOrderToOdoo", () => a.syncOrderToOdoo("order-1")],
    ["sendOrderConfirmationWhatsApp", () => a.sendOrderConfirmationWhatsApp("order-1", "+2348000000000")],
    ["buildAudience", () => a.buildAudience("c-1")],
    ["sendBroadcastBatch", () => a.sendBroadcastBatch("c-1", ["+2348000000000"], "tpl-1")],
  ];

  for (const [name, call] of unbacked) {
    it(`${name} throws a NON-retryable ActivityNotImplemented and makes no platform call`, async () => {
      apiCall.mockClear();
      const f = await caught(call());
      expect(f.nonRetryable).toBe(true);
      expect(f.type).toBe(FAILURE_NOT_IMPLEMENTED);
      expect(f.message).toContain(`"${name}"`);
      expect(apiCall).not.toHaveBeenCalled();
    });
  }

  it("activateTenant's message records WHY it is unbacked (must not bypass go-live gates)", async () => {
    const f = await caught(a.activateTenant("t1"));
    expect(f.message).toContain("goLiveTenant");
  });
});
