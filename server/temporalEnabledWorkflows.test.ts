/**
 * TEMPORAL_ENABLED_WORKFLOWS — connecting the server to Temporal must not reroute every flow.
 *
 * Several flows have no real worker behind them (payment saga; onboarding / order fulfilment /
 * broadcast activities are deliberately unbacked). Before this allowlist, merely setting
 * TEMPORAL_ADDRESS would start all of them on Temporal, where they would queue forever ("looks
 * durable, isn't"), and journey orchestration would skip its local execution. Default is now:
 * nothing runs on Temporal until a workflow type is named explicitly.
 *
 * Hermetic on purpose: no database at all (DATABASE_URL is cleared, so startWorkflow skips its
 * persistence step) and the Temporal client is stubbed. What gets RECORDED in
 * temporal_workflow_runs is asserted against a real database in simulation journey J468.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const connectSpy = vi.fn(async () => ({ close: async () => {} }));
const startSpy = vi.fn(async (_type: string, opts: any) => ({ firstExecutionRunId: `run-${opts.workflowId}` }));
vi.mock("@temporalio/client", () => ({
  Connection: { connect: connectSpy },
  Client: class {
    workflow = { start: startSpy };
  },
}));

const SAVED = {
  addr: process.env.TEMPORAL_ADDRESS,
  list: process.env.TEMPORAL_ENABLED_WORKFLOWS,
  dbUrl: process.env.DATABASE_URL,
  pgUrl: process.env.POSTGRES_URL,
};

beforeEach(() => {
  // No database: a developer's shell DATABASE_URL must never turn this into a DB test.
  delete process.env.DATABASE_URL;
  delete process.env.POSTGRES_URL;
  connectSpy.mockClear();
  startSpy.mockClear();
  vi.resetModules(); // temporal.ts caches its client / connect attempt at module level
  process.env.TEMPORAL_ADDRESS = "temporal-frontend.temporal.svc.cluster.local:7233";
  delete process.env.TEMPORAL_ENABLED_WORKFLOWS;
});

afterEach(() => {
  for (const [k, v] of [
    ["TEMPORAL_ADDRESS", SAVED.addr],
    ["TEMPORAL_ENABLED_WORKFLOWS", SAVED.list],
    ["DATABASE_URL", SAVED.dbUrl],
    ["POSTGRES_URL", SAVED.pgUrl],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("temporalWorkflowEnabled", () => {
  it("is off for everything when unset or blank (the safe default)", async () => {
    const { temporalWorkflowEnabled } = await import("./temporal");
    expect(temporalWorkflowEnabled("InventorySyncWorkflow", {})).toBe(false);
    expect(temporalWorkflowEnabled("InventorySyncWorkflow", { TEMPORAL_ENABLED_WORKFLOWS: "   " })).toBe(false);
  });

  it("enables exactly the listed types (whitespace tolerated, case-sensitive)", async () => {
    const { temporalWorkflowEnabled } = await import("./temporal");
    const env = { TEMPORAL_ENABLED_WORKFLOWS: " InventorySyncWorkflow , BroadcastCampaignWorkflow " };
    expect(temporalWorkflowEnabled("InventorySyncWorkflow", env)).toBe(true);
    expect(temporalWorkflowEnabled("BroadcastCampaignWorkflow", env)).toBe(true);
    expect(temporalWorkflowEnabled("OrderFulfillmentWorkflow", env)).toBe(false);
    expect(temporalWorkflowEnabled("inventorysyncworkflow", env)).toBe(false);
    // A prefix/substring must not match.
    expect(temporalWorkflowEnabled("InventorySync", env)).toBe(false);
  });

  it('"*" enables everything (explicit opt-in to the old all-or-nothing behavior)', async () => {
    const { temporalWorkflowEnabled } = await import("./temporal");
    expect(temporalWorkflowEnabled("AnythingWorkflow", { TEMPORAL_ENABLED_WORKFLOWS: "*" })).toBe(true);
  });
});

describe("startWorkflow with TEMPORAL_ADDRESS set", () => {
  it("not opted in → behaves as if Temporal were down: local run id, started:false, and Temporal is never contacted", async () => {
    const { startWorkflow } = await import("./temporal");
    const res = await startWorkflow("OrderFulfillmentWorkflow", { orderId: "o1" }, { workflowId: "wf-1", tenantId: "t1" });

    expect(res.started).toBe(false);
    expect(res.error).toBe("temporal_not_enabled_for_workflow");
    expect(res.runId).toMatch(/^local-/);
    expect(connectSpy).not.toHaveBeenCalled();
    expect(startSpy).not.toHaveBeenCalled();
  });

  it("opted in → starts on Temporal on the whatsapp-commerce queue and returns the real run id", async () => {
    process.env.TEMPORAL_ENABLED_WORKFLOWS = "InventorySyncWorkflow";
    const { startWorkflow } = await import("./temporal");
    const res = await startWorkflow("InventorySyncWorkflow", { tenantId: "t1" }, { workflowId: "wf-2", tenantId: "t1" });

    expect(res).toMatchObject({ started: true, workflowId: "wf-2", runId: "run-wf-2" });
    expect(startSpy).toHaveBeenCalledTimes(1);
    const [type, opts] = startSpy.mock.calls[0] as [string, any];
    expect(type).toBe("InventorySyncWorkflow");
    expect(opts.taskQueue).toBe("whatsapp-commerce");
    expect(opts.args).toEqual([{ tenantId: "t1" }]);
  });

  it("only the listed type starts — another type on the same server still stays off Temporal", async () => {
    process.env.TEMPORAL_ENABLED_WORKFLOWS = "InventorySyncWorkflow";
    const { startWorkflow } = await import("./temporal");
    const off = await startWorkflow("TenantOnboardingWorkflow", { tenantId: "t1" }, { workflowId: "wf-3" });
    expect(off.started).toBe(false);
    expect(off.error).toBe("temporal_not_enabled_for_workflow");
    expect(startSpy).not.toHaveBeenCalled();
  });

  it("no TEMPORAL_ADDRESS at all keeps the original 'temporal_unavailable' signal", async () => {
    delete process.env.TEMPORAL_ADDRESS;
    const { startWorkflow } = await import("./temporal");
    const res = await startWorkflow("InventorySyncWorkflow", {}, { workflowId: "wf-4" });
    expect(res.started).toBe(false);
    expect(res.error).toBe("temporal_unavailable");
  });
});

describe("payment saga guard", () => {
  it("does not start paymentSagaWorkflow just because an address is configured", async () => {
    const { triggerPaymentSaga } = await import("./routers/payment");
    const res = await triggerPaymentSaga("payment-saga-1", {
      paymentIntentId: "pi-1", tenantId: "t1", amount: 100, currency: "NGN", provider: "paystack", reference: "ref-1",
    });
    expect(res).toEqual({ started: false, error: "not_enabled" });
    expect(connectSpy).not.toHaveBeenCalled();
    expect(startSpy).not.toHaveBeenCalled();
  });

  it("starts it only when explicitly enabled (once a real saga + worker exist)", async () => {
    process.env.TEMPORAL_ENABLED_WORKFLOWS = "paymentSagaWorkflow";
    const { triggerPaymentSaga } = await import("./routers/payment");
    const res = await triggerPaymentSaga("payment-saga-2", {
      paymentIntentId: "pi-2", tenantId: "t1", amount: 100, currency: "NGN", provider: "paystack", reference: "ref-2",
    });
    expect(res.started).toBe(true);
    expect(startSpy).toHaveBeenCalledTimes(1);
  });
});
