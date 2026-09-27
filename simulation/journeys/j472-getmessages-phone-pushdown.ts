// === W48 api-db ===
/**
 * J472 — PERF-API-11: conversation.getMessages phone filter is pushed INTO
 * SQL (or(eq(fromAddress), eq(toAddress))) instead of fetching the tenant's
 * latest 60 rows and filtering in JS.
 *
 * The old shape could return ZERO of a customer's messages when a busy
 * tenant's latest 60 rows were all other customers'. Seeds 65 newer messages
 * from other phones + 3 older messages from the target phone, then proves
 * the pushed-down query still returns all 3 target messages with limit=60.
 */
import { TENANT_ID, assert, type World } from "../world";
import type { Journey } from "../runner";
import { tenantCaller } from "./helpers";

export const journey: Journey = {
  id: "J472",
  name: "getMessages phone filter SQL pushdown (PERF-API-11)",
  feature: "WHERE tenantId AND (fromAddress=phone OR toAddress=phone) ORDER BY createdAt DESC LIMIT n",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const target = "+23480555j472".replace("j", "7"); // +234805557472
    const base = Date.now();
    // Older: 3 messages for the target phone.
    for (let i = 0; i < 3; i++) {
      await world.db.insert(schema.channelMessages).values({
        channel: "whatsapp",
        direction: i % 2 === 0 ? "inbound" : "outbound",
        fromAddress: i % 2 === 0 ? target : "biz-phone",
        toAddress: i % 2 === 0 ? "biz-phone" : target,
        tenantId: TENANT_ID,
        body: `J472 target ${i}`,
        createdAt: new Date(base - (100 - i) * 1000),
      });
    }
    // Newer: 65 messages for OTHER phones (would bury the target under the
    // old fetch-60-then-filter-in-JS shape).
    for (let i = 0; i < 65; i++) {
      await world.db.insert(schema.channelMessages).values({
        channel: "whatsapp",
        direction: "inbound",
        fromAddress: `+23480666${String(1000 + i).slice(1)}`,
        toAddress: "biz-phone",
        tenantId: TENANT_ID,
        body: `J472 noise ${i}`,
        createdAt: new Date(base - i * 100),
      });
    }

    const caller = await tenantCaller(TENANT_ID);
    const rows = await caller.conversation.getMessages({ tenantId: TENANT_ID, customerPhone: target, limit: 60 });
    assert(rows.length === 3, `SQL pushdown returns all 3 target messages (got ${rows.length})`);
    assert(rows.every((r: any) => r.fromAddress === target || r.toAddress === target), "every row matches the phone predicate");

    // No filter → tenant-wide latest page still works.
    const all = await caller.conversation.getMessages({ tenantId: TENANT_ID, limit: 60 });
    assert(all.length === 60, "unfiltered path returns the latest 60");
    assert(all.every((r: any) => r.tenantId === TENANT_ID), "unfiltered rows are tenant-scoped");
  },
};
