/**
 * W26 security wave — unit tests for the authorization hardening:
 *  F8/F10: internalProcedure shared-secret gate (nlp.processMessage,
 *          channels.processUssd/Sms/Telegram, temporal.recordRun/updateStatus,
 *          infra.record*, deliveryReceipts.ingestStatusUpdate,
 *          heartbeat.inventorySync).
 *  F9:     alertRules mutations are admin-only.
 *  MED:    receiptScan.scanImage requires auth or a valid evidence token.
 *  MED:    authz scanner — recursive scan + indentation-agnostic detection.
 *
 * DB note: none of these tests need a database — the authz middleware runs
 * BEFORE the resolver, so rejections are observable without a DB, and the
 * positive-gate cases assert the failure moves PAST the authz layer (to the
 * "DB unavailable" resolver error).
 */
import { describe, expect, it, beforeEach, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { appRouter } from "../../routers";
import { scanRouterDir, isTenantRelevant, isGuarded } from "./authzScan.lib";

const TEST_KEY = "w26-test-internal-key";

function httpCtx(headers: Record<string, string>, user: any = null): any {
  return {
    req: { headers, socket: { remoteAddress: "127.0.0.1" } },
    res: {},
    user,
    resolvedTenantId: "default",
  };
}

const ORIGINAL_KEY = process.env.INTERNAL_API_KEY;
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

beforeEach(() => {
  process.env.INTERNAL_API_KEY = TEST_KEY;
});

afterAll(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.INTERNAL_API_KEY;
  else process.env.INTERNAL_API_KEY = ORIGINAL_KEY;
  if (ORIGINAL_NODE_ENV === undefined) delete (process.env as any).NODE_ENV;
  else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
});

describe("F8/F10: internalProcedure API-key gate", () => {
  const internalCalls: Array<[string, (caller: any) => Promise<unknown>]> = [
    ["nlp.processMessage", (c) => c.nlp.processMessage({ tenantId: "t1", waPhoneNumber: "+2348000000000", message: "hi" })],
    ["channels.processUssd", (c) => c.channels.processUssd({ sessionId: "s1", phoneNumber: "+2348000000000", text: "" })],
    ["channels.processSms", (c) => c.channels.processSms({ from: "+2348000000000", to: "*384#", body: "hi" })],
    ["channels.processTelegram", (c) => c.channels.processTelegram({ updateId: 1, chatId: 2, from: "user" })],
    ["temporal.recordRun", (c) => c.temporal.recordRun({ workflowId: "w1", runId: "r1", workflowType: "t" })],
    ["temporal.updateStatus", (c) => c.temporal.updateStatus({ runId: "r1", status: "completed" })],
    ["infra.recordWafEvent", (c) => c.infra.recordWafEvent({})],
    ["infra.recordFluvioEvent", (c) => c.infra.recordFluvioEvent({ topic: "t", offset: 1, payload: {} })],
    ["infra.recordReconRun", (c) => c.infra.recordReconRun({ runId: "r1", discrepancies: 0, alerts: [] })],
    ["deliveryReceipts.ingestStatusUpdate", (c) => c.deliveryReceipts.ingestStatusUpdate({ tenantId: "t1", waMessageId: "m1", status: "sent" })],
    ["heartbeat.inventorySync", (c) => c.heartbeat.inventorySync({})],
  ];

  for (const [name, call] of internalCalls) {
    it(`${name}: unauthenticated HTTP request (no key) → UNAUTHORIZED (401)`, async () => {
      const caller = appRouter.createCaller(httpCtx({}));
      await expect(call(caller)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    });

    it(`${name}: wrong key → UNAUTHORIZED (401)`, async () => {
      const caller = appRouter.createCaller(httpCtx({ "x-internal-api-key": "wrong-key" }));
      await expect(call(caller)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    });

    it(`${name}: correct key passes the gate (fails later only on missing DB/services)`, async () => {
      const caller = appRouter.createCaller(httpCtx({ "x-internal-api-key": TEST_KEY }));
      // Must NOT fail with the gate's UNAUTHORIZED — any later error (DB
      // unavailable in the test sandbox) proves the middleware passed.
      const err = await call(caller).then(
        () => null,
        (e: any) => e,
      );
      if (err) expect(err.code).not.toBe("UNAUTHORIZED");
    });
  }

  it("in-process server-side caller (no req) is trusted", async () => {
    const caller = appRouter.createCaller({ user: null } as any);
    const err = await caller.nlp
      .processMessage({ tenantId: "t1", waPhoneNumber: "+2348000000000", message: "hi" })
      .then(() => null, (e: any) => e);
    if (err) expect(err.code).not.toBe("UNAUTHORIZED");
  });

  it("fails closed when INTERNAL_API_KEY is unset in staging/production", async () => {
    delete process.env.INTERNAL_API_KEY;
    (process.env as any).NODE_ENV = "staging";
    const caller = appRouter.createCaller(httpCtx({}));
    await expect(
      caller.channels.processSms({ from: "+2348000000000", to: "*384#", body: "hi" }),
    ).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR", message: "internal-api-not-configured" });
    (process.env as any).NODE_ENV = ORIGINAL_NODE_ENV ?? "test";
  });
});

describe("F9: alertRules mutations are admin-only", () => {
  const mutations: Array<[string, (c: any) => Promise<unknown>]> = [
    ["create", (c) => c.alertRules.create({ name: "r", ruleType: "low_stock", threshold: 5 })],
    ["update", (c) => c.alertRules.update({ id: "00000000-0000-0000-0000-000000000000" })],
    ["toggle", (c) => c.alertRules.toggle({ id: "00000000-0000-0000-0000-000000000000", isEnabled: false })],
    ["delete", (c) => c.alertRules.delete({ id: "00000000-0000-0000-0000-000000000000" })],
    ["seedDefaults", (c) => c.alertRules.seedDefaults()],
  ];
  for (const [name, call] of mutations) {
    it(`alertRules.${name}: non-admin authenticated user → FORBIDDEN`, async () => {
      const caller = appRouter.createCaller(httpCtx({}, { id: "u1", role: "user", tenantId: "t1" }));
      await expect(call(caller)).rejects.toMatchObject({ code: "FORBIDDEN" });
    });
    it(`alertRules.${name}: unauthenticated → FORBIDDEN`, async () => {
      const caller = appRouter.createCaller(httpCtx({}));
      await expect(call(caller)).rejects.toMatchObject({ code: "FORBIDDEN" });
    });
  }
});

describe("MED: medusa cross-tenant endpoints are admin-only", () => {
  it("medusa.listOrders: non-admin → FORBIDDEN", async () => {
    const caller = appRouter.createCaller(httpCtx({}, { id: "u1", role: "user", tenantId: "t1" }));
    await expect(caller.medusa.listOrders({})).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("medusa.getOrder: non-admin → FORBIDDEN", async () => {
    const caller = appRouter.createCaller(httpCtx({}, { id: "u1", role: "user", tenantId: "t1" }));
    await expect(caller.medusa.getOrder({ id: "o1" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("MED: receiptScan auth guard", () => {
  const img = { imageBase64: "a".repeat(120), mimeType: "image/png" as const };
  it("anonymous caller without evidence token → UNAUTHORIZED", async () => {
    const caller = appRouter.createCaller(httpCtx({}));
    await expect(caller.receiptScan.scanImage(img)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
  it("anonymous caller with an invalid evidence token → UNAUTHORIZED (token lookup misses)", async () => {
    const caller = appRouter.createCaller(httpCtx({}));
    // No DB in the sandbox → the guard throws before/at the lookup, but must
    // never reach the vision LLM with an anonymous unauthorized caller.
    const err = await caller.receiptScan.scanImage({ ...img, evidenceToken: "x".repeat(32) }).then(
      () => null,
      (e: any) => e,
    );
    expect(err).not.toBeNull();
    expect(["UNAUTHORIZED", "INTERNAL_SERVER_ERROR"]).toContain(err.code);
    if (err.code === "INTERNAL_SERVER_ERROR") expect(err.message).toBe("DB unavailable");
  });
});

describe("MED: authz scanner hardening", () => {
  it("recursive scan discovers routers in subdirectories", () => {
    const dir = mkdtempSync(join(tmpdir(), "w26-scan-"));
    try {
      mkdirSync(join(dir, "nested", "deeper"), { recursive: true });
      writeFileSync(
        join(dir, "nested", "deeper", "thing.ts"),
        `import { z } from "zod";\nexport const r = {\n  doThing: protectedProcedure\n    .input(z.object({ tenantId: z.string() }))\n    .mutation(async ({ input }: any) => input),\n};\n`,
      );
      const blocks = scanRouterDir(dir);
      const b = blocks.find((x) => x.file === "nested/deeper/thing.ts" && x.name === "doThing");
      expect(b).toBeDefined();
      expect(isTenantRelevant(b!)).toBe(true);
      expect(isGuarded(b!)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("indentation-agnostic: 6-space-indented procedure is still detected", async () => {
    const { procedureBlocksFromSource } = await import("./authzScan.lib");
    const src = `export const r = {\n  sub: {\n      oddProc: protectedProcedure\n        .input(z.object({ tenantId: z.string() }))\n        .mutation(async ({ input }: any) => input),\n  },\n};\n`;
    const blocks = procedureBlocksFromSource(src, "virtual.ts");
    const b = blocks.find((x) => x.name === "oddProc");
    expect(b).toBeDefined();
    expect(isTenantRelevant(b!)).toBe(true);
    expect(isGuarded(b!)).toBe(false);
  });
});
