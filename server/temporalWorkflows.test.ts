/**
 * Temporal workflows (services/temporal-workflows/workflows.ts) — run for real.
 *
 * These execute the workflow bundle inside Temporal's actual deterministic sandbox against the
 * Temporal test server with TIME SKIPPING, so 7-day KYC waits and 45-minute payment windows
 * complete instantly. Activities are in-memory mocks that record how they were called.
 *
 * OPT-IN (downloads the Temporal test-server binary on first run, bundles workflows with
 * webpack — ~30s):   npm run test:temporal
 * Skipped in the default suite, like the real-Postgres money-path suite (PG_INTEGRATION=1).
 * The always-on guard for these files is server/temporalWorkflowsStatic.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { fileURLToPath } from "node:url";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { ApplicationFailure } from "@temporalio/common";

const enabled = process.env.TEMPORAL_WORKFLOW_TESTS === "1";
const WORKFLOWS_PATH = fileURLToPath(new URL("../services/temporal-workflows/workflows.ts", import.meta.url));

type Acts = Record<string, (...args: any[]) => Promise<any>>;

describe.skipIf(!enabled)("Temporal workflows (real sandbox, time-skipping)", () => {
  let env: TestWorkflowEnvironment;
  let seq = 0;
  /** firstExecutionRunId of the most recent run() — what the platform keys its run row by. */
  let lastFirstRunId = "";

  beforeAll(async () => {
    env = await TestWorkflowEnvironment.createTimeSkipping();
  }, 180_000);

  afterAll(async () => {
    await env?.teardown();
  });

  /** Run one workflow to completion on a fresh task queue with the given mock activities. */
  async function run(workflowType: string, args: unknown[], activities: Acts, opts: { signals?: Array<[string, unknown]> } = {}) {
    const taskQueue = `test-${++seq}`;
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowsPath: WORKFLOWS_PATH,
      activities,
    });
    return worker.runUntil(async () => {
      const handle = await env.client.workflow.start(workflowType, { taskQueue, workflowId: `${taskQueue}-wf`, args });
      lastFirstRunId = handle.firstExecutionRunId;
      for (const [name, payload] of opts.signals ?? []) await handle.signal(name, payload);
      return handle.result();
    });
  }

  async function failure(p: Promise<unknown>): Promise<{ type?: string; message: string }> {
    try {
      await p;
    } catch (e: any) {
      // A workflow failure wraps its cause; a failed ACTIVITY adds one more layer
      // (WorkflowFailedError → ActivityFailure → ApplicationFailure). Find the typed failure.
      let cause = e.cause;
      while (cause && cause.type === undefined && cause.cause) cause = cause.cause;
      return { type: cause?.type, message: cause?.message ?? e.message };
    }
    throw new Error("expected the workflow to fail");
  }

  // ── InventorySyncWorkflow ────────────────────────────────────────────────────
  describe("InventorySyncWorkflow", () => {
    it("syncs every tenant and totals the records", async () => {
      const synced: string[] = [];
      const res = await run("InventorySyncWorkflow", [{}], {
        listInventorySyncTenants: async () => ["t1", "t2", "t3"],
        syncTenantInventory: async (id: string) => {
          synced.push(id);
          return { tenantId: id, recordsSynced: 10 };
        },
      });
      expect(res).toEqual({ tenants: 3, succeeded: 3, failed: [], recordsSynced: 30 });
      expect(synced).toEqual(["t1", "t2", "t3"]);
    });

    it("one tenant failing does not abort the rest — it is reported in `failed`", async () => {
      const res = await run("InventorySyncWorkflow", [{}], {
        listInventorySyncTenants: async () => ["t1", "t2", "t3"],
        syncTenantInventory: async (id: string) => {
          if (id === "t2") throw ApplicationFailure.nonRetryable("tenant t2 not found", "PlatformRejected");
          return { tenantId: id, recordsSynced: 5 };
        },
      });
      expect(res).toEqual({ tenants: 3, succeeded: 2, failed: ["t2"], recordsSynced: 10 });
    });

    it("a single-tenant run never lists tenants", async () => {
      let listed = 0;
      const res = await run("InventorySyncWorkflow", [{ tenantId: "only" }], {
        listInventorySyncTenants: async () => {
          listed++;
          return ["x"];
        },
        syncTenantInventory: async (id: string) => ({ tenantId: id, recordsSynced: 1 }),
      });
      expect(listed).toBe(0);
      expect(res).toEqual({ tenants: 1, succeeded: 1, failed: [], recordsSynced: 1 });
    });

    it("retries a transient (retryable) failure and then succeeds", async () => {
      let attempts = 0;
      const res: any = await run("InventorySyncWorkflow", [{ tenantId: "t1" }], {
        syncTenantInventory: async (id: string) => {
          if (++attempts < 3) throw ApplicationFailure.retryable("platform unreachable", "PlatformUnavailable");
          return { tenantId: id, recordsSynced: 4 };
        },
      });
      expect(attempts).toBe(3);
      expect(res.succeeded).toBe(1);
    });

    it("does NOT retry a non-retryable failure (fails fast, exactly one attempt)", async () => {
      let attempts = 0;
      const res: any = await run("InventorySyncWorkflow", [{ tenantId: "t1" }], {
        syncTenantInventory: async () => {
          attempts++;
          throw ApplicationFailure.nonRetryable("HTTP 401", "PlatformRejected");
        },
      });
      expect(attempts).toBe(1);
      expect(res.failed).toEqual(["t1"]);
    });

    it("no tenants → an empty, successful result", async () => {
      const res = await run("InventorySyncWorkflow", [{}], {
        listInventorySyncTenants: async () => [],
        syncTenantInventory: async () => {
          throw new Error("must not be called");
        },
      });
      expect(res).toEqual({ tenants: 0, succeeded: 0, failed: [], recordsSynced: 0 });
    });
  });

  // ── JourneyOrchestrationWorkflow ─────────────────────────────────────────────
  // The workflow only sequences: plan → one server-side step at a time → close the run row.
  describe("JourneyOrchestrationWorkflow", () => {
    const input = { journeyId: "j-test", params: { any: "thing" } };

    function journeyActs(log: string[], overrides: Acts = {}): Acts {
      return {
        getJourneyPlan: async (id: string) => (log.push(`plan:${id}`), ["a", "b", "c"]),
        runJourneyActivity: async (runId: string, name: string) => (log.push(`step:${name}@${runId}`), { cached: false }),
        finishJourney: async (runId: string, status: string, error?: string) => void log.push(`finish:${status}@${runId}${error ? `:${error}` : ""}`),
        ...overrides,
      };
    }

    it("runs the plan in order, keyed by the FIRST execution's run id, then closes the run as completed", async () => {
      const log: string[] = [];
      const res = await run("JourneyOrchestrationWorkflow", [input], journeyActs(log));
      expect(res).toEqual({ journeyId: "j-test", executed: ["a", "b", "c"] });
      expect(lastFirstRunId).not.toBe("");
      expect(log).toEqual([
        "plan:j-test",
        `step:a@${lastFirstRunId}`,
        `step:b@${lastFirstRunId}`,
        `step:c@${lastFirstRunId}`,
        `finish:completed@${lastFirstRunId}`,
      ]);
    });

    it("a transient step failure is retried and the journey still completes", async () => {
      const log: string[] = [];
      let bAttempts = 0;
      await run(
        "JourneyOrchestrationWorkflow",
        [input],
        journeyActs(log, {
          runJourneyActivity: async (runId: string, name: string) => {
            if (name === "b" && ++bAttempts < 3) throw ApplicationFailure.retryable("platform 503", "PlatformUnavailable");
            log.push(`step:${name}`);
            return { cached: false };
          },
        }),
      );
      expect(bAttempts).toBe(3);
      expect(log.filter((l) => l.startsWith("step:"))).toEqual(["step:a", "step:b", "step:c"]);
      expect(log[log.length - 1]).toMatch(/^finish:completed@/);
    });

    it("a permanent step failure stops the journey, closes the run as failed with the ROOT message, and rethrows it", async () => {
      const log: string[] = [];
      let bAttempts = 0;
      const f = await failure(
        run(
          "JourneyOrchestrationWorkflow",
          [input],
          journeyActs(log, {
            runJourneyActivity: async (runId: string, name: string) => {
              log.push(`step:${name}`);
              if (name === "b") {
                bAttempts++;
                throw ApplicationFailure.nonRetryable("credit facility rejected", "PlatformRejected");
              }
              return { cached: false };
            },
          }),
        ),
      );
      expect(f.type).toBe("PlatformRejected");
      expect(bAttempts).toBe(1); // permanent → not retried
      expect(log.filter((l) => l.startsWith("step:"))).toEqual(["step:a", "step:b"]); // c never runs
      expect(log[log.length - 1]).toBe(`finish:failed@${lastFirstRunId}:credit facility rejected`);
    });

    it("an unknown journey fails at the plan step and never runs anything", async () => {
      const log: string[] = [];
      const f = await failure(
        run(
          "JourneyOrchestrationWorkflow",
          [{ journeyId: "nope", params: {} }],
          journeyActs(log, {
            getJourneyPlan: async () => {
              throw ApplicationFailure.nonRetryable("unknown orchestration journey: nope", "PlatformRejected");
            },
          }),
        ),
      );
      expect(f.type).toBe("PlatformRejected");
      expect(log.some((l) => l.startsWith("step:"))).toBe(false);
    });

    it("if closing the run row ALSO fails, the original failure is what surfaces (bookkeeping never masks it)", async () => {
      const f = await failure(
        run(
          "JourneyOrchestrationWorkflow",
          [input],
          journeyActs([], {
            runJourneyActivity: async () => {
              throw ApplicationFailure.nonRetryable("the real problem", "PlatformRejected");
            },
            finishJourney: async () => {
              throw ApplicationFailure.nonRetryable("orchestration run not found", "PlatformRejected");
            },
          }),
        ),
      );
      expect(f.message).toBe("the real problem");
    });

    it("cancelling a journey that is waiting to retry a step still closes the run row, as cancelled", async () => {
      // Deliberately NOT cancelled mid-step: cancelling a workflow whose activity is still
      // executing (a held promise) leaves that activity in flight on the shared test server and
      // stalls time-skipping for every later test in this file (their sleeps then take real time
      // and hit the 5s vitest timeout). Cancelling during the retry backoff exercises the same
      // path — ActivityFailure(CancelledFailure) → nonCancellable finish — without that side effect.
      const taskQueue = `test-${++seq}`;
      const log: string[] = [];
      let attempts = 0;
      let firstAttemptFailed!: () => void;
      const failedOnce = new Promise<void>((r) => (firstAttemptFailed = r));
      const worker = await Worker.create({
        connection: env.nativeConnection,
        taskQueue,
        workflowsPath: WORKFLOWS_PATH,
        activities: journeyActs(log, {
          // Always transient, so the workflow sits in the server-side retry backoff — no step is
          // executing when the cancel arrives.
          runJourneyActivity: async () => {
            attempts++;
            queueMicrotask(firstAttemptFailed);
            throw ApplicationFailure.retryable("platform 503", "PlatformUnavailable");
          },
        }),
      });
      let firstRunId = "";
      await worker.runUntil(async () => {
        const handle = await env.client.workflow.start("JourneyOrchestrationWorkflow", { taskQueue, workflowId: `${taskQueue}-wf`, args: [input] });
        firstRunId = handle.firstExecutionRunId;
        await failedOnce;
        await handle.cancel();
        await expect(handle.result()).rejects.toBeTruthy();
      });
      expect(attempts).toBeGreaterThanOrEqual(1);
      expect(log.some((l) => l.startsWith(`finish:cancelled@${firstRunId}`))).toBe(true);
      expect(log.some((l) => l.startsWith("finish:completed"))).toBe(false);
    });
  });

  // ── TenantOnboardingWorkflow ─────────────────────────────────────────────────
  describe("TenantOnboardingWorkflow", () => {
    const input = { tenantId: "t1", applicantEmail: "owner@shop.ng", billingModel: "subscription", kycApplicationId: "kyc-1" };

    function onboardingActs(decisions: string[], log: string[]): Acts {
      let i = 0;
      return {
        submitKycForReview: async (id: string) => void log.push(`submit:${id}`),
        getKycDecision: async () => {
          const d = decisions[Math.min(i++, decisions.length - 1)];
          log.push(`decision:${d}`);
          return d;
        },
        setupBillingPlan: async (t: string, m: string) => void log.push(`billing:${t}:${m}`),
        validateWhatsAppCredentials: async () => true,
        activateTenant: async (t: string) => void log.push(`activate:${t}`),
        sendWelcomeMessage: async (t: string, e: string) => void log.push(`welcome:${t}:${e}`),
      };
    }

    it("waits through pending decisions, then completes the full sequence in order", async () => {
      const log: string[] = [];
      await run("TenantOnboardingWorkflow", [input], onboardingActs(["pending", "pending", "approved"], log));
      expect(log).toEqual([
        "submit:kyc-1",
        "decision:pending",
        "decision:pending",
        "decision:approved",
        "billing:t1:subscription",
        "activate:t1",
        "welcome:t1:owner@shop.ng",
      ]);
    });

    it("a rejection fails the workflow (KycRejected) and never activates or messages the applicant", async () => {
      const log: string[] = [];
      const f = await failure(run("TenantOnboardingWorkflow", [input], onboardingActs(["rejected"], log)));
      expect(f.type).toBe("KycRejected");
      expect(log.some((l) => l.startsWith("activate") || l.startsWith("welcome") || l.startsWith("billing"))).toBe(false);
    });

    it("never approved within 7 days → KycTimeout, without activating", async () => {
      const log: string[] = [];
      const f = await failure(run("TenantOnboardingWorkflow", [input], onboardingActs(["pending"], log)));
      expect(f.type).toBe("KycTimeout");
      expect(log.some((l) => l.startsWith("activate"))).toBe(false);
      // Backoff keeps the poll count bounded (a fixed 5-minute poll would be ~2,000).
      expect(log.filter((l) => l === "decision:pending").length).toBeLessThan(250);
    });

    it("resubmit_required waits for a kycSubmitted signal, resubmits the NEW application, then approves", async () => {
      const log: string[] = [];
      await run("TenantOnboardingWorkflow", [input], onboardingActs(["resubmit_required", "approved"], log), {
        signals: [["kycSubmitted", { kycApplicationId: "kyc-2" }]],
      });
      expect(log.slice(0, 4)).toEqual(["submit:kyc-1", "decision:resubmit_required", "submit:kyc-2", "decision:approved"]);
      expect(log).toContain("activate:t1");
    });

    it("started with no application id: waits for the kycSubmitted signal, then proceeds", async () => {
      const log: string[] = [];
      await run("TenantOnboardingWorkflow", [{ ...input, kycApplicationId: undefined }], onboardingActs(["approved"], log), {
        signals: [["kycSubmitted", { kycApplicationId: "kyc-late" }]],
      });
      expect(log[0]).toBe("submit:kyc-late");
      expect(log).toContain("activate:t1");
    });

    it("started with no application id and no signal → KycTimeout after 7 days", async () => {
      const log: string[] = [];
      const f = await failure(run("TenantOnboardingWorkflow", [{ ...input, kycApplicationId: undefined }], onboardingActs(["approved"], log)));
      expect(f.type).toBe("KycTimeout");
      expect(log).toEqual([]);
    });

    it("an unbacked activity (honest failure) fails the workflow instead of skipping the step", async () => {
      const acts = onboardingActs(["approved"], []);
      acts.activateTenant = async () => {
        throw ApplicationFailure.nonRetryable("activity_not_implemented", "ActivityNotImplemented");
      };
      const f = await failure(run("TenantOnboardingWorkflow", [input], acts));
      expect(f.type).toBe("ActivityNotImplemented");
    });
  });

  // ── OrderFulfillmentWorkflow ─────────────────────────────────────────────────
  describe("OrderFulfillmentWorkflow", () => {
    const input = {
      orderId: "o1",
      tenantId: "t1",
      customerId: "c1",
      items: [{ productId: "p1", quantity: 2, price: 500 }],
      totalAmount: 1000,
      waPhoneNumber: "+2348000000000",
    };

    it("confirms payment, then syncs to Odoo, then messages the customer", async () => {
      const log: string[] = [];
      await run("OrderFulfillmentWorkflow", [input], {
        confirmPayment: async (id: string) => (log.push(`pay:${id}`), true),
        syncOrderToOdoo: async (id: string) => void log.push(`odoo:${id}`),
        sendOrderConfirmationWhatsApp: async (id: string, p: string) => void log.push(`wa:${id}:${p}`),
      });
      expect(log).toEqual(["pay:o1", "odoo:o1", "wa:o1:+2348000000000"]);
    });

    it("waits for a payment that arrives after creation (does not fail on the first unpaid check)", async () => {
      let polls = 0;
      const log: string[] = [];
      await run("OrderFulfillmentWorkflow", [input], {
        confirmPayment: async () => ++polls >= 4,
        syncOrderToOdoo: async () => void log.push("odoo"),
        sendOrderConfirmationWhatsApp: async () => void log.push("wa"),
      });
      expect(polls).toBe(4);
      expect(log).toEqual(["odoo", "wa"]);
    });

    it("never paid → PaymentNotConfirmed after the window; nothing is synced or sent", async () => {
      const log: string[] = [];
      const f = await failure(
        run("OrderFulfillmentWorkflow", [input], {
          confirmPayment: async () => false,
          syncOrderToOdoo: async () => void log.push("odoo"),
          sendOrderConfirmationWhatsApp: async () => void log.push("wa"),
        }),
      );
      expect(f.type).toBe("PaymentNotConfirmed");
      expect(log).toEqual([]);
    });

    it("does not reserve inventory a second time (stock is reserved when the order is created)", async () => {
      let reserveCalls = 0;
      await run("OrderFulfillmentWorkflow", [input], {
        confirmPayment: async () => true,
        syncOrderToOdoo: async () => {},
        sendOrderConfirmationWhatsApp: async () => {},
        reserveInventory: async () => {
          reserveCalls++;
          return true;
        },
      });
      expect(reserveCalls).toBe(0);
    });
  });

  // ── BroadcastCampaignWorkflow ────────────────────────────────────────────────
  describe("BroadcastCampaignWorkflow", () => {
    const input = { campaignId: "c1", tenantId: "t1", templateId: "tpl", recipientCount: 5, batchSize: 2, scheduledAt: "2026-09-25T00:00:00Z" };

    it("sends the audience in batches of batchSize and totals what was sent", async () => {
      const batches: string[][] = [];
      const res = await run("BroadcastCampaignWorkflow", [input], {
        buildAudience: async () => ["a", "b", "c", "d", "e"],
        sendBroadcastBatch: async (_c: string, recipients: string[]) => (batches.push(recipients), recipients.length),
      });
      expect(batches).toEqual([["a", "b"], ["c", "d"], ["e"]]);
      expect(res).toEqual({ sent: 5, audience: 5 });
    });

    it("reports what was actually sent when a batch under-delivers", async () => {
      const res = await run("BroadcastCampaignWorkflow", [input], {
        buildAudience: async () => ["a", "b", "c"],
        sendBroadcastBatch: async (_c: string, r: string[]) => (r.length === 2 ? 1 : r.length),
      });
      expect(res).toEqual({ sent: 2, audience: 3 });
    });

    it("an empty audience sends nothing", async () => {
      let sends = 0;
      const res = await run("BroadcastCampaignWorkflow", [input], {
        buildAudience: async () => [],
        sendBroadcastBatch: async () => (sends++, 0),
      });
      expect(sends).toBe(0);
      expect(res).toEqual({ sent: 0, audience: 0 });
    });
  });
});
