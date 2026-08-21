/**
 * W28 odoo-sync router — tenant-guarded Odoo ERP connection + sync surface:
 * save connection config (api key encrypted at rest), test connection,
 * sync mode + account mapping, outbox/reconciliation queue, retry, sync now.
 * All procedures are scoped to the session tenant (ctx.user.tenantId —
 * never caller-supplied), mirroring bookkeeping.ts.
 */
import { z } from "zod";
import { eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure } from "../_core/trpc";
import { getDb } from "../db";
import { odooConfigs, odooSyncOutbox } from "../../drizzle/schema";
import { encryptSecret } from "../services/crypto/secrets";
import { adapterForConnectionTest } from "../services/odoo/adapter";
import { listOutbox, outboxStats, retryOutboxRow, syncNow } from "../services/odoo/sync";

const tenantScopedProcedure = protectedProcedure.use(async ({ ctx, next }) => {
  if (!ctx.user.tenantId) {
    throw new TRPCError({ code: "FORBIDDEN", message: "No tenant associated with this account" });
  }
  return next({ ctx: { ...ctx, tenantId: ctx.user.tenantId } });
});

async function requireDb() {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
  return db;
}

const syncModeSchema = z.enum(["push", "batch", "ondemand"]);
const urlSchema = z.string().min(1).max(255).refine(
  (u) => u.startsWith("https://") || u.startsWith("http://") || u.startsWith("mock://"),
  "url must be http(s):// or mock://",
);

function publicConfig(row: typeof odooConfigs.$inferSelect) {
  // Never leak the (encrypted) api key to the client.
  const { apiKey: _omit, ...rest } = row;
  return { ...rest, hasApiKey: Boolean(row.apiKey) };
}

export const odooSyncRouter = router({
  /** Current config (api key redacted) + outbox stats. */
  getConfig: tenantScopedProcedure.query(async ({ ctx }) => {
    const db = await requireDb();
    const [row] = await db.select().from(odooConfigs).where(eq(odooConfigs.tenantId, ctx.tenantId)).limit(1);
    const stats = await outboxStats(db, ctx.tenantId);
    return { config: row ? publicConfig(row) : null, stats };
  }),

  /** Create or update the connection. apiKey is encrypted on write; omit to keep. */
  saveConfig: tenantScopedProcedure
    .input(z.object({
      url: urlSchema,
      db: z.string().min(1).max(128),
      username: z.string().max(128).optional(),
      apiKey: z.string().max(500).optional(),
      syncMode: syncModeSchema.optional(),
      accountMapping: z.record(z.string(), z.unknown()).optional(),
      enabled: z.boolean().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await requireDb();
      const values: Partial<typeof odooConfigs.$inferInsert> = {
        url: input.url,
        db: input.db,
        username: input.username ?? null,
        updatedAt: new Date(),
      };
      if (input.apiKey !== undefined) values.apiKey = input.apiKey ? encryptSecret(input.apiKey) : null;
      if (input.syncMode !== undefined) values.syncMode = input.syncMode;
      if (input.accountMapping !== undefined) values.accountMapping = input.accountMapping;
      if (input.enabled !== undefined) values.enabled = input.enabled;

      const [row] = await db.insert(odooConfigs)
        .values({ ...(values as typeof odooConfigs.$inferInsert), tenantId: ctx.tenantId })
        .onConflictDoUpdate({ target: odooConfigs.tenantId, set: values })
        .returning();
      return { config: publicConfig(row) };
    }),

  /** Test a connection (saved or ad-hoc) without persisting anything new. */
  testConnection: tenantScopedProcedure
    .input(z.object({
      url: urlSchema.optional(),
      db: z.string().min(1).max(128).optional(),
      username: z.string().max(128).optional(),
      apiKey: z.string().max(500).optional(),
    }).optional())
    .mutation(async ({ ctx, input }) => {
      const db = await requireDb();
      let url = input?.url;
      let dbName = input?.db;
      let username = input?.username ?? null;
      let apiKey = input?.apiKey ?? null;
      if (!url || !dbName) {
        const [row] = await db.select().from(odooConfigs).where(eq(odooConfigs.tenantId, ctx.tenantId)).limit(1);
        if (!row) throw new TRPCError({ code: "BAD_REQUEST", message: "No saved Odoo config to test" });
        url = url ?? row.url;
        dbName = dbName ?? row.db;
        username = username ?? row.username;
        if (apiKey == null && row.apiKey) {
          const { decryptSecret } = await import("../services/crypto/secrets");
          apiKey = decryptSecret(row.apiKey);
        }
      }
      let ok = false;
      let error: string | null = null;
      let uid: number | null = null;
      try {
        const adapter = adapterForConnectionTest({ url: url!, db: dbName!, username, apiKey });
        uid = (await adapter.authenticate()).uid;
        ok = true;
      } catch (e: any) {
        error = String(e?.message ?? e).slice(0, 500);
      }
      // Record the test result on the saved config when one exists.
      await db.update(odooConfigs)
        .set({ lastTestedAt: new Date(), lastTestOk: ok, lastTestError: error, updatedAt: new Date() })
        .where(eq(odooConfigs.tenantId, ctx.tenantId));
      return { ok, uid, error };
    }),

  setEnabled: tenantScopedProcedure
    .input(z.object({ enabled: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const db = await requireDb();
      const updated = await db.update(odooConfigs)
        .set({ enabled: input.enabled, updatedAt: new Date() })
        .where(eq(odooConfigs.tenantId, ctx.tenantId))
        .returning({ id: odooConfigs.id });
      if (updated.length === 0) throw new TRPCError({ code: "NOT_FOUND", message: "No Odoo config" });
      return { ok: true };
    }),

  setSyncMode: tenantScopedProcedure
    .input(z.object({ syncMode: syncModeSchema }))
    .mutation(async ({ ctx, input }) => {
      const db = await requireDb();
      const updated = await db.update(odooConfigs)
        .set({ syncMode: input.syncMode, updatedAt: new Date() })
        .where(eq(odooConfigs.tenantId, ctx.tenantId))
        .returning({ id: odooConfigs.id });
      if (updated.length === 0) throw new TRPCError({ code: "NOT_FOUND", message: "No Odoo config" });
      return { ok: true };
    }),

  setAccountMapping: tenantScopedProcedure
    .input(z.object({ accountMapping: z.record(z.string(), z.unknown()) }))
    .mutation(async ({ ctx, input }) => {
      const db = await requireDb();
      const updated = await db.update(odooConfigs)
        .set({ accountMapping: input.accountMapping, updatedAt: new Date() })
        .where(eq(odooConfigs.tenantId, ctx.tenantId))
        .returning({ id: odooConfigs.id });
      if (updated.length === 0) throw new TRPCError({ code: "NOT_FOUND", message: "No Odoo config" });
      return { ok: true };
    }),

  /** Outbox listing / reconciliation queue. */
  outbox: router({
    list: tenantScopedProcedure
      .input(z.object({
        status: z.enum(["pending", "sending", "sent", "failed"]).optional(),
        limit: z.number().int().min(1).max(500).optional(),
      }).optional())
      .query(async ({ ctx, input }) => {
        const db = await requireDb();
        const rows = await listOutbox(db, ctx.tenantId, input ?? {});
        const stats = await outboxStats(db, ctx.tenantId);
        return { rows, stats };
      }),

    retry: tenantScopedProcedure
      .input(z.object({ id: z.string().uuid() }))
      .mutation(async ({ ctx, input }) => {
        const db = await requireDb();
        const ok = await retryOutboxRow(db, ctx.tenantId, input.id);
        if (!ok) throw new TRPCError({ code: "NOT_FOUND", message: "No failed outbox row with that id" });
        return { ok };
      }),

    retryAllFailed: tenantScopedProcedure.mutation(async ({ ctx }) => {
      const db = await requireDb();
      const updated = await db.update(odooSyncOutbox)
        .set({ status: "pending", attempts: 0, lastError: null, updatedAt: new Date() })
        .where(eq(odooSyncOutbox.tenantId, ctx.tenantId))
        .returning({ id: odooSyncOutbox.id });
      return { requeued: updated.length };
    }),
  }),

  /** Sweep + drain now (portal "sync now" button). */
  syncNow: tenantScopedProcedure.mutation(async ({ ctx }) => {
    const db = await requireDb();
    return syncNow(db, ctx.tenantId);
  }),
});
