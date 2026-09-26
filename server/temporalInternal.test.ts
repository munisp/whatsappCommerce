/**
 * temporalInternal router — the endpoints the Temporal worker's activities call.
 *
 * Hermetic checks only: what must hold BEFORE any database is touched. (1) every procedure is
 * unreachable without the shared internal key, even for a signed-in platform admin; (2) malformed
 * input is rejected at the schema. Behaviour against real data — sync, journey steps, idempotent
 * replay, closure, unknown tenants/runs — runs against a real database in simulation journey
 * J467 (worker's own HTTP client → real server → PGlite); nothing here fakes the database.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { appRouter } from "./routers";

const KEY = "temporal-internal-test-key";
const ORIGINAL_KEY = process.env.INTERNAL_API_KEY;
const ORIGINAL_DB = { DATABASE_URL: process.env.DATABASE_URL, POSTGRES_URL: process.env.POSTGRES_URL };

function httpCtx(headers: Record<string, string>, user: unknown = null): any {
  return { req: { headers, socket: { remoteAddress: "127.0.0.1" } }, res: {}, user, resolvedTenantId: "default" };
}

beforeEach(() => {
  process.env.INTERNAL_API_KEY = KEY;
  // Nothing in this file may reach a database — make an accidental reach fail loudly, not connect.
  delete process.env.DATABASE_URL;
  delete process.env.POSTGRES_URL;
});

afterAll(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.INTERNAL_API_KEY;
  else process.env.INTERNAL_API_KEY = ORIGINAL_KEY;
  for (const [k, v] of Object.entries(ORIGINAL_DB)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("temporalInternal — authorization", () => {
  const calls: Array<[string, (c: any) => Promise<unknown>]> = [
    ["listInventorySyncTenants", (c) => c.temporalInternal.listInventorySyncTenants({})],
    ["syncTenantInventory", (c) => c.temporalInternal.syncTenantInventory({ tenantId: "t1" })],
    ["journeyPlan", (c) => c.temporalInternal.journeyPlan({ journeyId: "j121-fullstack" })],
    ["runJourneyActivity", (c) => c.temporalInternal.runJourneyActivity({ runId: "r1", activityName: "a" })],
    ["finishJourney", (c) => c.temporalInternal.finishJourney({ runId: "r1", status: "completed" })],
  ];

  for (const [name, call] of calls) {
    it(`${name}: rejects a request with no internal key`, async () => {
      await expect(call(appRouter.createCaller(httpCtx({})))).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    });

    it(`${name}: rejects a wrong internal key`, async () => {
      await expect(call(appRouter.createCaller(httpCtx({ "x-internal-token": "nope" })))).rejects.toMatchObject({
        code: "UNAUTHORIZED",
      });
    });

    it(`${name}: a signed-in platform admin WITHOUT the key is still rejected`, async () => {
      const admin = { id: 1, role: "admin", tenantId: null };
      await expect(call(appRouter.createCaller(httpCtx({}, admin)))).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    });

    it(`${name}: a tenant user WITHOUT the key is still rejected`, async () => {
      const owner = { id: 2, role: "user", tenantId: "t1" };
      await expect(call(appRouter.createCaller(httpCtx({}, owner)))).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    });
  }
});

describe("temporalInternal — input schemas (checked after auth, before any database access)", () => {
  const authed = () => appRouter.createCaller(httpCtx({ "x-internal-token": KEY }));

  it("syncTenantInventory rejects an empty tenant id", async () => {
    await expect(authed().temporalInternal.syncTenantInventory({ tenantId: "" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("journeyPlan rejects an empty journey id", async () => {
    await expect(authed().temporalInternal.journeyPlan({ journeyId: "" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("runJourneyActivity rejects a missing activity name and an oversized run id", async () => {
    await expect(authed().temporalInternal.runJourneyActivity({ runId: "r1", activityName: "" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      authed().temporalInternal.runJourneyActivity({ runId: "x".repeat(129), activityName: "a" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("finishJourney only accepts the three terminal statuses (no 'running', no free text)", async () => {
    for (const status of ["running", "timed_out", "done", ""]) {
      await expect(authed().temporalInternal.finishJourney({ runId: "r1", status: status as any })).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
    }
  });

  it("finishJourney caps the error text (it is stored on the run row)", async () => {
    await expect(
      authed().temporalInternal.finishJourney({ runId: "r1", status: "failed", error: "e".repeat(2001) }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("with the key and valid input but no database, it fails loudly instead of pretending", async () => {
    await expect(authed().temporalInternal.listInventorySyncTenants({})).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
  });
});
