import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, asc, eq, inArray } from "drizzle-orm";
import { adminProcedure, protectedProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import { featureRollouts, tenantFeatureOverrides, tenants } from "../../drizzle/schema";
import { ALWAYS_ON_FEATURES, NEW_BADGE_DAYS, ROLLOUT_STATES, featureVisible } from "../../shared/featureRollout";
import { writeAuditLog } from "./audit";

const featureKey = z.string().regex(/^\/[a-z0-9/-]{1,118}$/).refine((key) => !ALWAYS_ON_FEATURES.includes(key), "This feature is always on");

async function database() {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
  return db;
}

const isRecent = (at: Date | null | undefined, now: number) => !!at && now - new Date(at).getTime() < NEW_BADGE_DAYS * 86_400_000;

export const featureRolloutRouter = router({
  /** What the signed-in person's shop can see. Only decided features are listed; the rest stay visible. */
  mine: protectedProcedure.query(async ({ ctx }) => {
    const tenantId = ctx.user.tenantId;
    if (!tenantId) return { hidden: [] as string[], fresh: [] as string[] };
    const db = await database();
    const [rollouts, overrides] = await Promise.all([
      db.select().from(featureRollouts),
      db.select().from(tenantFeatureOverrides).where(eq(tenantFeatureOverrides.tenantId, tenantId)),
    ]);
    const states = new Map(rollouts.map((row) => [row.featureKey, row]));
    const mineByKey = new Map(overrides.map((row) => [row.featureKey, row]));
    const now = Date.now();
    const hidden: string[] = [];
    const fresh: string[] = [];
    for (const key of Array.from(new Set(Array.from(states.keys()).concat(Array.from(mineByKey.keys()))))) {
      const rollout = states.get(key);
      const override = mineByKey.get(key);
      if (!featureVisible(key, rollout?.state, override?.enabled)) hidden.push(key);
      else if (isRecent(rollout?.releasedAt, now) || (override?.enabled && isRecent(override.updatedAt, now))) fresh.push(key);
    }
    return { hidden, fresh };
  }),

  overview: adminProcedure.query(async () => {
    const db = await database();
    const [rollouts, overrides, shops] = await Promise.all([
      db.select().from(featureRollouts),
      db.select({ tenantId: tenantFeatureOverrides.tenantId, featureKey: tenantFeatureOverrides.featureKey, enabled: tenantFeatureOverrides.enabled }).from(tenantFeatureOverrides),
      db.select({ id: tenants.id, name: tenants.name, status: tenants.status }).from(tenants).orderBy(asc(tenants.name)),
    ]);
    return { rollouts, overrides, shops, alwaysOn: ALWAYS_ON_FEATURES };
  }),

  setState: adminProcedure
    .input(z.object({ keys: z.array(featureKey).min(1).max(200), state: z.enum(ROLLOUT_STATES) }))
    .mutation(async ({ ctx, input }) => {
      const db = await database();
      const now = new Date();
      const existing = await db.select().from(featureRollouts).where(inArray(featureRollouts.featureKey, input.keys));
      const before = new Map(existing.map((row) => [row.featureKey, row]));
      for (const key of input.keys) {
        const previous = before.get(key);
        // Only a feature coming back from hidden counts as new to shops.
        const released = input.state !== "off" && previous?.state === "off" ? now : previous?.releasedAt ?? null;
        await db
          .insert(featureRollouts)
          .values({ featureKey: key, state: input.state, releasedAt: released, updatedBy: String(ctx.user.id), updatedAt: now })
          .onConflictDoUpdate({ target: featureRollouts.featureKey, set: { state: input.state, releasedAt: released, updatedBy: String(ctx.user.id), updatedAt: now } });
      }
      await writeAuditLog({
        actorId: String(ctx.user.id),
        actorRole: ctx.user.role,
        action: "feature_rollout.state_set",
        entityType: "feature_rollout",
        entityId: input.keys.length === 1 ? input.keys[0] : `${input.keys.length} features`,
        summary: `${input.keys.length} feature(s) set to ${input.state}`,
        after: { keys: input.keys, state: input.state },
      }).catch(() => {});
      return { updated: input.keys.length };
    }),

  /** enabled: true opts a shop in, false opts it out, null clears the exception. */
  setShopOverride: adminProcedure
    .input(z.object({ tenantId: z.string().min(1).max(36), key: featureKey, enabled: z.boolean().nullable() }))
    .mutation(async ({ ctx, input }) => {
      const db = await database();
      const [shop] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, input.tenantId)).limit(1);
      if (!shop) throw new TRPCError({ code: "NOT_FOUND", message: "Shop not found" });
      const match = and(eq(tenantFeatureOverrides.tenantId, input.tenantId), eq(tenantFeatureOverrides.featureKey, input.key));
      if (input.enabled === null) {
        await db.delete(tenantFeatureOverrides).where(match);
      } else {
        const now = new Date();
        await db
          .insert(tenantFeatureOverrides)
          .values({ tenantId: input.tenantId, featureKey: input.key, enabled: input.enabled, updatedBy: String(ctx.user.id), updatedAt: now })
          .onConflictDoUpdate({
            target: [tenantFeatureOverrides.tenantId, tenantFeatureOverrides.featureKey],
            set: { enabled: input.enabled, updatedBy: String(ctx.user.id), updatedAt: now },
          });
      }
      await writeAuditLog({
        actorId: String(ctx.user.id),
        actorRole: ctx.user.role,
        action: "feature_rollout.shop_override_set",
        entityType: "feature_rollout",
        entityId: input.key,
        tenantId: input.tenantId,
        summary: `${input.key} for this shop: ${input.enabled === null ? "follows the rollout" : input.enabled ? "on" : "off"}`,
        after: { key: input.key, enabled: input.enabled },
      }).catch(() => {});
      return { ok: true };
    }),
});
