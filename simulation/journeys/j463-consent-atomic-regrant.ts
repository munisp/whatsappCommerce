// === W47 crosscutting ===
/**
 * J463 — ONB-TOCTOU-1: consent re-grant counter is an ATOMIC guarded UPDATE.
 *
 *   - A withdrawn identity over the 24h re-grant cap is refused
 *     (ConsentRegrantRateLimited) even under PARALLEL re-grant attempts —
 *     the read-then-write race is closed by the guarded UPDATE;
 *   - concurrent first-contact grants upsert instead of duplicating rows
 *     (consents_tenant_phone_channel_uniq);
 *   - grants stamp proofWamid + policyVersion (TEN-16 trail, now passed from
 *     the inbound wamid — source contract in useCases).
 */
import { and, eq } from "drizzle-orm";
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J463",
  name: "consent atomic re-grant guard + unique upsert",
  feature: "ONB-TOCTOU-1 consent TOCTOU",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const consent = await import("../../server/services/consent");

    // ── Over-cap re-grant refused, including under concurrency ────────────
    const capped = world.newPhone("cg463a");
    await world.db.insert(schema.consents).values({
      tenantId: TENANT_ID, phone: capped, channel: "whatsapp", granted: false,
      withdrawnAt: new Date(), source: "whatsapp_stop",
      regrantCount: 3, lastRegrantAt: new Date(), // MAX_REGRANTS_PER_DAY = 3
    });
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        consent.recordConsent(world.db, { tenantId: TENANT_ID, phone: capped, granted: true })),
    );
    for (const r of results) {
      assert(r.status === "rejected", "over-cap re-grant refused under concurrency");
      assert((r as PromiseRejectedResult).reason?.name === "ConsentRegrantRateLimited",
        `ConsentRegrantRateLimited (got ${(r as PromiseRejectedResult).reason?.name})`);
    }
    const [row0] = await world.db.select().from(schema.consents)
      .where(and(eq(schema.consents.tenantId, TENANT_ID), eq(schema.consents.phone, capped)));
    assert(row0.granted === false && row0.withdrawnAt != null, "withdrawal stands");
    assert(Number(row0.regrantCount) === 3, "counter NOT bumped by refused attempts");

    // ── Under-cap re-grant succeeds exactly once per call and bumps ───────
    const ok = world.newPhone("cg463b");
    await world.db.insert(schema.consents).values({
      tenantId: TENANT_ID, phone: ok, channel: "whatsapp", granted: false,
      withdrawnAt: new Date(), source: "whatsapp_stop",
      regrantCount: 1, lastRegrantAt: new Date(),
    });
    await consent.recordConsent(world.db, {
      tenantId: TENANT_ID, phone: ok, granted: true, proofWamid: "wamid.j463",
    });
    const [row1] = await world.db.select().from(schema.consents)
      .where(and(eq(schema.consents.tenantId, TENANT_ID), eq(schema.consents.phone, ok)));
    assert(row1.granted === true && row1.withdrawnAt == null, "under-cap re-grant honored");
    assert(Number(row1.regrantCount) === 2, "counter atomically bumped");
    assert(row1.proofWamid === "wamid.j463", "proof wamid stamped on the re-grant");

    // ── Concurrent first-contact grants: one row, no duplicates ───────────
    const first = world.newPhone("cg463c");
    await Promise.allSettled(
      Array.from({ length: 4 }, (_, i) =>
        consent.recordConsent(world.db, { tenantId: TENANT_ID, phone: first, granted: true, proofWamid: `wamid.j463.${i}` })),
    );
    const rows = await world.db.select().from(schema.consents)
      .where(and(eq(schema.consents.tenantId, TENANT_ID), eq(schema.consents.phone, first)));
    assert(rows.length === 1, `concurrent first-contact grants → single row (got ${rows.length})`);
    assert(rows[0].granted === true, "grant persisted");

    // ── wamid plumbed from the webhook (source contract) ──────────────────
    const { readFile } = await import("node:fs/promises");
    const uc = await readFile(new URL("../../server/services/useCases.ts", import.meta.url), "utf8");
    assert(uc.includes("proofWamid: opts.wamid"), "useCases passes the inbound wamid into recordConsent");
    const core = await readFile(new URL("../../server/_core/index.ts", import.meta.url), "utf8");
    assert(core.includes("wamid: typeof msg?.id"), "webhook passes msg.id as the consent evidence wamid");
  },
};
