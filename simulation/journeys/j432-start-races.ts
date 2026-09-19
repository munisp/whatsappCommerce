// === W47 merchant ===
/**
 * J432 — ONB-M-9 (concurrent onboarding.start cannot mint duplicate tenants)
 * + ONB-M-10 (slug check-then-insert race → suffixed retry, no raw 23505).
 */
import { eq } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { tenantCaller } from "./helpers";

export const journey: Journey = {
  id: "J432",
  name: "onboarding.start atomic claim + slug race retry (ONB-M-9/M-10)",
  feature: "W47 merchant: no duplicate tenants, no 23505 leaks",
  async run(world) {
    const schema = await import("../../drizzle/schema");

    // ── M-9: two concurrent start() calls for the SAME user → one tenant ──
    await world.db.insert(schema.users).values({
      id: 432,
      openId: "sim-user-432",
      name: "Race User",
      loginMethod: "keycloak",
      role: "user",
    }).onConflictDoNothing();
    const caller = await tenantCaller(null as any, { userId: 432 });
    const results = await Promise.allSettled([
      caller.onboarding.start({ name: "J432 Race Store" }),
      caller.onboarding.start({ name: "J432 Race Store" }),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<any>[];
    const failed = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    assert(ok.length === 1, `exactly one start succeeded (got ${ok.length})`);
    assert(failed.length === 1, "the loser was rejected");
    const code = failed[0].reason?.code ?? failed[0].reason?.data?.code;
    assert(code === "CONFLICT", `loser got CONFLICT (got ${code})`);
    const [me] = await world.db.select().from(schema.users).where(eq(schema.users.id, 432)).limit(1);
    assert(me.tenantId === ok[0].value.tenantId, "users.tenantId points at the single tenant");
    const memberships = await world.db.select().from(schema.tenantMemberships)
      .where(eq(schema.tenantMemberships.userId, 432));
    assert(memberships.length === 1 && memberships[0].role === "owner", "exactly one owner membership");

    // ── M-10: concurrent same-slug creates both succeed (suffix retry) ────
    const { createTenant } = await import("../../server/services/onboarding");
    const [t1, t2] = await Promise.all([
      createTenant({ name: "J432 Slug Race Ltd", slug: "j432-slug-race" }),
      createTenant({ name: "J432 Slug Race Ltd", slug: "j432-slug-race" }),
    ]);
    assert(t1.tenantId !== t2.tenantId, "two distinct tenants");
    assert(t1.slug !== t2.slug, `slugs differ after retry (${t1.slug} vs ${t2.slug})`);
    assert(t1.slug.startsWith("j432-slug-race") && t2.slug.startsWith("j432-slug-race"), "suffix derived from base slug");
  },
};
