/**
 * server/temporalOutage.test.ts — Temporal server outage behavior.
 *
 * Pins: when Temporal is unreachable/not configured, starting a workflow does
 * NOT crash and does NOT lose the record — the order/workflow persists as a
 * synthetic local-* run in temporal_workflow_runs (status "running"), and the
 * caller gets started:false with error "temporal_unavailable" so the flow
 * proceeds synchronously.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Ensure the "Temporal down" path: no address configured → client disabled.
delete process.env.TEMPORAL_ADDRESS;

const insertedRuns: Record<string, unknown>[] = [];

vi.mock("./db", () => ({
  getDb: vi.fn(async () => ({
    insert: (_table: unknown) => ({
      values: (vals: Record<string, unknown>) => ({
        onConflictDoNothing: () => {
          insertedRuns.push(vals);
          return Promise.resolve([]);
        },
      }),
    }),
    select: () => ({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }),
    }),
    update: () => ({
      set: () => ({ where: () => Promise.resolve([]) }),
    }),
  })),
  withRetry: vi.fn((fn: () => Promise<unknown>) => fn()),
}));

const { startWorkflow } = await import("./temporal");

describe("startWorkflow — Temporal outage fallback", () => {
  beforeEach(() => {
    insertedRuns.length = 0;
  });

  it("Temporal down → no crash, synthetic local-* run recorded, started:false", async () => {
    const result = await startWorkflow(
      "OrderFulfillmentWorkflow",
      { orderId: "order-temporal-outage", tenantId: "tenant-1" },
      { workflowId: "order-fulfillment-order-temporal-outage", tenantId: "tenant-1", entityId: "order-temporal-outage" },
    );

    // No crash; honest degradation signal for the caller.
    expect(result.started).toBe(false);
    expect(result.error).toBe("temporal_unavailable");
    expect(result.workflowId).toBe("order-fulfillment-order-temporal-outage");

    // Synthetic run id is clearly distinguishable from a real Temporal run id.
    expect(result.runId).toMatch(/^local-\d+-[a-z0-9]+$/);

    // The run was persisted (order context survives the outage for recon).
    expect(insertedRuns.length).toBe(1);
    expect(insertedRuns[0].runId).toBe(result.runId);
    expect(insertedRuns[0].workflowType).toBe("OrderFulfillmentWorkflow");
    expect(insertedRuns[0].status).toBe("running");
    expect(insertedRuns[0].tenantId).toBe("tenant-1");
    expect((insertedRuns[0].input as Record<string, unknown>).orderId).toBe("order-temporal-outage");
  });

  it("works without a DB too (db unavailable must not crash the flow)", async () => {
    const { getDb } = await import("./db");
    vi.mocked(getDb).mockResolvedValueOnce(null);
    const result = await startWorkflow("InventorySyncWorkflow", { sku: "SKU-1" });
    expect(result.started).toBe(false);
    expect(result.runId).toMatch(/^local-/);
  });
});
