/**
 * W17 F8 — journey builder: step-graph validation + tick execution.
 *
 * Runs on a queue-based fake db (same pattern as broadcast.test.ts):
 * `selectQueue` feeds .limit() results in call order; `executeQueue` feeds
 * raw-SQL calls (consents → tenants settings → notif log → replies) in order.
 */
import { describe, expect, it, vi } from "vitest";
import {
  consentBlocksSend,
  evaluateCondition,
  MAX_JOURNEY_STEPS,
  processJourneyRun,
  runDueJourneySteps,
  validateJourneySteps,
  type JourneyStep,
} from "./journeyBuilder";

// ── Validation ───────────────────────────────────────────────────────────────
const linear: JourneyStep[] = [
  { id: "s1", type: "send_template", templateName: "welcome" },
  { id: "s2", type: "wait", durationMinutes: 60 },
  { id: "s3", type: "exit" },
];

describe("validateJourneySteps", () => {
  it("accepts a valid linear journey", () => {
    expect(validateJourneySteps(linear)).toEqual([]);
  });

  it("accepts branches (wait_for_reply / condition) when targets exist and are reachable", () => {
    const steps: JourneyStep[] = [
      { id: "s1", type: "send_template", templateName: "welcome" },
      { id: "s2", type: "wait_for_reply", timeoutMinutes: 120, onReplyStepId: "s3", onTimeoutStepId: "s4" },
      { id: "s3", type: "condition", condition: { kind: "has_tag", tag: "vip" }, onTrueStepId: "s5", onFalseStepId: "s4" },
      { id: "s4", type: "exit" },
      { id: "s5", type: "send_template", templateName: "vip_offer" },
    ];
    expect(validateJourneySteps(steps)).toEqual([]);
  });

  it("rejects empty / non-array", () => {
    expect(validateJourneySteps([])).toEqual(["journey must have at least one step"]);
    expect(validateJourneySteps(null)).toEqual(["journey must have at least one step"]);
  });

  it("rejects more than MAX_JOURNEY_STEPS steps", () => {
    const steps = Array.from({ length: MAX_JOURNEY_STEPS + 1 }, (_, i) => ({ id: `s${i}`, type: "exit" as const }));
    expect(validateJourneySteps(steps).some((e) => e.includes("at most"))).toBe(true);
  });

  it("rejects duplicate step ids", () => {
    const steps: JourneyStep[] = [
      { id: "s1", type: "exit" },
      { id: "s1", type: "exit" },
    ];
    expect(validateJourneySteps(steps).some((e) => e.includes("duplicate"))).toBe(true);
  });

  it("rejects waits over 30 days", () => {
    const steps: JourneyStep[] = [{ id: "s1", type: "wait", durationMinutes: 31 * 24 * 60 }];
    expect(validateJourneySteps(steps).some((e) => e.includes("30 days"))).toBe(true);
    const wr: JourneyStep[] = [
      { id: "s1", type: "wait_for_reply", timeoutMinutes: 31 * 24 * 60, onReplyStepId: "s2", onTimeoutStepId: "s2" },
      { id: "s2", type: "exit" },
    ];
    expect(validateJourneySteps(wr).some((e) => e.includes("30 days"))).toBe(true);
  });

  it("rejects orphan branches (unreachable steps)", () => {
    const steps: JourneyStep[] = [
      { id: "s1", type: "send_template", templateName: "welcome" },
      { id: "s2", type: "exit" },
      { id: "s3", type: "send_template", templateName: "never_reached" },
    ];
    const errs = validateJourneySteps(steps);
    expect(errs).toEqual(['step "s3" is unreachable (orphan branch)']);
  });

  it("rejects dangling branch references", () => {
    const steps: JourneyStep[] = [
      { id: "s1", type: "wait_for_reply", timeoutMinutes: 60, onReplyStepId: "ghost", onTimeoutStepId: "s2" },
      { id: "s2", type: "exit" },
    ];
    expect(validateJourneySteps(steps).some((e) => e.includes("ghost"))).toBe(true);
  });

  it("rejects unknown step types and bad conditions", () => {
    expect(validateJourneySteps([{ id: "s1", type: "teleport" }]).some((e) => e.includes("unknown step type"))).toBe(true);
    const bad: any[] = [{ id: "s1", type: "condition", condition: { kind: "has_tag" }, onTrueStepId: "s2", onFalseStepId: "s2" }, { id: "s2", type: "exit" }];
    expect(validateJourneySteps(bad).some((e) => e.includes("has_tag condition needs a tag"))).toBe(true);
  });
});

describe("evaluateCondition", () => {
  const now = new Date("2026-03-10T12:00:00Z");
  it("has_tag", () => {
    expect(evaluateCondition({ kind: "has_tag", tag: "vip" }, { tags: ["vip", "lagos"] }, now)).toBe(true);
    expect(evaluateCondition({ kind: "has_tag", tag: "vip" }, { tags: ["lagos"] }, now)).toBe(false);
    expect(evaluateCondition({ kind: "has_tag", tag: "vip" }, null, now)).toBe(false);
  });
  it("last_order_within_days", () => {
    const recent = { lastOrderAt: new Date("2026-03-08T12:00:00Z") };
    const stale = { lastOrderAt: new Date("2026-02-01T12:00:00Z") };
    expect(evaluateCondition({ kind: "last_order_within_days", days: 7 }, recent, now)).toBe(true);
    expect(evaluateCondition({ kind: "last_order_within_days", days: 7 }, stale, now)).toBe(false);
    expect(evaluateCondition({ kind: "last_order_within_days", days: 7 }, { lastOrderAt: null }, now)).toBe(false);
  });
});

describe("consentBlocksSend", () => {
  it("missing row blocks (fail closed)", () => expect(consentBlocksSend(null)).toBe(true));
  it("withdrawn blocks even when granted=true", () =>
    expect(consentBlocksSend({ granted: true, withdrawnAt: new Date() })).toBe(true));
  it("denied blocks", () => expect(consentBlocksSend({ granted: false, withdrawnAt: null })).toBe(true));
  it("granted + not withdrawn allows", () => expect(consentBlocksSend({ granted: true, withdrawnAt: null })).toBe(false));
});

// ── Execution (fake db) ──────────────────────────────────────────────────────
function makeDb(opts: {
  selectQueue?: any[][];
  executeQueue?: any[];
} = {}) {
  const sels = [...(opts.selectQueue ?? [])];
  const execs = [...(opts.executeQueue ?? [])];
  const updates: any[] = [];
  const chain: any = {
    from: vi.fn(),
    where: vi.fn(),
    orderBy: vi.fn(),
    limit: vi.fn(() => Promise.resolve(sels.shift() ?? [])),
    then: (resolve: any, reject: any) => Promise.resolve(sels.shift() ?? []).then(resolve, reject),
  };
  chain.from.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.orderBy.mockReturnValue(chain);
  const db: any = {
    select: vi.fn(() => chain),
    update: vi.fn(() => ({
      set: vi.fn((vals: any) => {
        updates.push(vals);
        return { where: vi.fn(() => Promise.resolve()) };
      }),
    })),
    insert: vi.fn(() => ({ values: vi.fn(() => Promise.resolve()) })),
    execute: vi.fn(() => Promise.resolve(execs.shift() ?? { rows: [] })),
  };
  return { db, updates };
}

const CUSTOMER = {
  id: "cust-1",
  tenantId: "t1",
  whatsappPhone: "+2348011111111",
  name: "Ada",
  tags: ["vip"],
  lastOrderAt: new Date("2026-03-09T12:00:00Z"),
};

const RUN = {
  id: "run-1",
  journeyId: "j1",
  tenantId: "t1",
  customerId: "cust-1",
  currentStep: 0,
  state: "waiting" as const,
  context: {},
  nextRunAt: new Date("2026-03-10T11:00:00Z"),
};

const NOW = new Date("2026-03-10T11:00:00Z"); // 12:00 Lagos — outside quiet hours
const GRANTED = { rows: [{ granted: true, withdrawnAt: null }] };

describe("processJourneyRun", () => {
  it("send_template → sends, advances, exit → done", async () => {
    const { db, updates } = makeDb({
      selectQueue: [[CUSTOMER]],
      executeQueue: [GRANTED, { rows: [{ settings: {} }] }, { rows: [] }],
    });
    const sendTemplate = vi.fn(async () => ({}));
    const steps: JourneyStep[] = [
      { id: "s1", type: "send_template", templateName: "welcome" },
      { id: "s2", type: "exit" },
    ];
    const after = await processJourneyRun(db, { id: "j1", tenantId: "t1", steps }, RUN, NOW, { sendTemplate });
    expect(sendTemplate).toHaveBeenCalledWith("t1", "2348011111111", "welcome", "en_US");
    expect(after.state).toBe("done");
    expect(updates.at(-1)).toMatchObject({ state: "done" });
  });

  it("frequency cap defers the send (nextRunAt in future, nothing sent)", async () => {
    const sends = {
      rows: [{ sent_at: "2026-03-09T11:00:00Z" }, { sent_at: "2026-03-08T11:00:00Z" }],
    };
    const { db } = makeDb({
      selectQueue: [[CUSTOMER]],
      executeQueue: [GRANTED, { rows: [{ settings: {} }] }, sends],
    });
    const sendTemplate = vi.fn(async () => ({}));
    const steps: JourneyStep[] = [{ id: "s1", type: "send_template", templateName: "welcome" }];
    const after = await processJourneyRun(db, { id: "j1", tenantId: "t1", steps }, RUN, NOW, { sendTemplate });
    expect(sendTemplate).not.toHaveBeenCalled();
    expect(after.state).toBe("waiting");
    expect(new Date(after.nextRunAt as any).getTime()).toBeGreaterThan(NOW.getTime());
  });

  it("consent withdrawal mid-journey exits the run", async () => {
    const withdrawn = { rows: [{ granted: true, withdrawnAt: "2026-03-10T10:00:00Z" }] };
    const { db, updates } = makeDb({
      selectQueue: [[CUSTOMER]],
      executeQueue: [withdrawn],
    });
    const sendTemplate = vi.fn(async () => ({}));
    const steps: JourneyStep[] = [{ id: "s1", type: "send_template", templateName: "welcome" }];
    const after = await processJourneyRun(db, { id: "j1", tenantId: "t1", steps }, RUN, NOW, { sendTemplate });
    expect(sendTemplate).not.toHaveBeenCalled();
    expect(after.state).toBe("exited");
    expect(updates.at(-1)).toMatchObject({ state: "exited", context: expect.objectContaining({ exitReason: "consent_withdrawn" }) });
  });

  it("wait_for_reply: a reply since step start takes the on_reply branch", async () => {
    const { db } = makeDb({
      selectQueue: [[CUSTOMER]],
      executeQueue: [GRANTED, { rows: [{ one: 1 }] }], // reply exists
    });
    const steps: JourneyStep[] = [
      { id: "s1", type: "wait_for_reply", timeoutMinutes: 120, onReplyStepId: "s2", onTimeoutStepId: "s3" },
      { id: "s2", type: "exit" },
      { id: "s3", type: "send_template", templateName: "nudge" },
    ];
    const after = await processJourneyRun(db, { id: "j1", tenantId: "t1", steps }, { ...RUN, context: { stepStartedAt: "2026-03-10T10:30:00Z" } }, NOW);
    expect(after.state).toBe("done");
    expect(after.context.exitStep).toBe("s2");
  });

  it("wait_for_reply: timeout takes the on_timeout branch", async () => {
    const { db } = makeDb({
      selectQueue: [[CUSTOMER]],
      executeQueue: [GRANTED, { rows: [] }], // no reply
    });
    const steps: JourneyStep[] = [
      { id: "s1", type: "wait_for_reply", timeoutMinutes: 30, onReplyStepId: "s2", onTimeoutStepId: "s3" },
      { id: "s2", type: "exit" },
      { id: "s3", type: "exit" },
    ];
    const after = await processJourneyRun(
      db, { id: "j1", tenantId: "t1", steps },
      { ...RUN, context: { stepStartedAt: "2026-03-10T09:00:00Z" } }, // 2h ago > 30m timeout
      NOW,
    );
    expect(after.state).toBe("done");
    expect(after.context.exitStep).toBe("s3");
  });

  it("wait_for_reply: no reply + no timeout parks with a poll nextRunAt", async () => {
    const { db } = makeDb({
      selectQueue: [[CUSTOMER]],
      executeQueue: [GRANTED, { rows: [] }],
    });
    const steps: JourneyStep[] = [
      { id: "s1", type: "wait_for_reply", timeoutMinutes: 120, onReplyStepId: "s2", onTimeoutStepId: "s2" },
      { id: "s2", type: "exit" },
    ];
    const after = await processJourneyRun(
      db, { id: "j1", tenantId: "t1", steps },
      { ...RUN, context: { stepStartedAt: "2026-03-10T10:55:00Z" } },
      NOW,
    );
    expect(after.state).toBe("waiting");
    expect(new Date(after.nextRunAt as any).getTime()).toBe(NOW.getTime() + 5 * 60_000);
  });

  it("condition routes on customer tags", async () => {
    const { db } = makeDb({
      selectQueue: [[CUSTOMER]],
      executeQueue: [GRANTED],
    });
    const steps: JourneyStep[] = [
      { id: "s1", type: "condition", condition: { kind: "has_tag", tag: "vip" }, onTrueStepId: "s2", onFalseStepId: "s3" },
      { id: "s2", type: "exit" },
      { id: "s3", type: "send_template", templateName: "x" },
    ];
    const after = await processJourneyRun(db, { id: "j1", tenantId: "t1", steps }, RUN, NOW);
    expect(after.state).toBe("done");
    expect(after.context.exitStep).toBe("s2");
  });

  it("send failure marks the run failed", async () => {
    const { db } = makeDb({
      selectQueue: [[CUSTOMER]],
      executeQueue: [GRANTED, { rows: [{ settings: {} }] }, { rows: [] }],
    });
    const sendTemplate = vi.fn(async () => { throw new Error("Meta 500"); });
    const steps: JourneyStep[] = [{ id: "s1", type: "send_template", templateName: "welcome" }];
    const after = await processJourneyRun(db, { id: "j1", tenantId: "t1", steps }, RUN, NOW, { sendTemplate });
    expect(after.state).toBe("failed");
    expect(String(after.context.error)).toContain("Meta 500");
  });
});

describe("runDueJourneySteps", () => {
  it("advances due runs of active journeys; skips paused ones", async () => {
    const journey = { id: "j1", tenantId: "t1", status: "active", steps: [linear[0], linear[2]] }; // send → exit
    const pausedJourney = { id: "j2", tenantId: "t1", status: "paused", steps: linear };
    const run2 = { ...RUN, id: "run-2", journeyId: "j2" };
    const { db } = makeDb({
      selectQueue: [
        [RUN, run2],        // due runs
        [journey],          // journey for run-1
        [CUSTOMER],         // customer for run-1
        [pausedJourney],    // journey for run-2
      ],
      executeQueue: [GRANTED, { rows: [{ settings: {} }] }, { rows: [] }],
    });
    const sendTemplate = vi.fn(async () => ({}));
    const summary = await runDueJourneySteps(NOW, db, { sendTemplate });
    expect(summary.processed).toBe(2);
    expect(summary.skipped).toBe(1);
    expect(summary.done).toBe(1);
    expect(sendTemplate).toHaveBeenCalledTimes(1);
  });

  it("returns a zero summary without throwing when the db is missing", async () => {
    const summary = await runDueJourneySteps(NOW, null as any);
    expect(summary).toEqual({ processed: 0, sent: 0, deferred: 0, done: 0, exited: 0, failed: 0, skipped: 0 });
  });
});
