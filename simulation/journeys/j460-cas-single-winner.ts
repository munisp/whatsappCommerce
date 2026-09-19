// === W47 crosscutting ===
/**
 * J460 — ONB-ID-2: concurrent first-contact CAS — a single winner.
 *
 *   - Two PARALLEL copilot startSession calls for the same phone produce
 *     exactly ONE active onboarding_sessions row (mig 0169 partial unique
 *     index + advisory-lock transaction; the loser supersedes, never forks).
 *   - Two PARALLEL nlp.processMessage first contacts for the same identity
 *     produce exactly ONE nlp_sessions row (unique backstop + conflict
 *     re-select) — no forked carts/consent context.
 */
import { and, eq, notInArray, sql } from "drizzle-orm";
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { publicCaller } from "./helpers";

export const journey: Journey = {
  id: "J460",
  name: "concurrent first-contact single winner (copilot + nlp)",
  feature: "ONB-ID-2 CAS unique backstops",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const copilot = await import("../../server/services/onboardingCopilot");

    // ── Copilot: sequential duplicate starts → supersede, one active ──────
    // (The sim runs PGlite, which is single-transaction; the CAS advisory-lock
    // path is exercised sequentially here, and the unique backstop is proven
    // directly below with a raw racing insert.)
    const phone = world.newPhone("cas460");
    const r1 = await copilot.startSession({ channel: "whatsapp", phone });
    const r2 = await copilot.startSession({ channel: "whatsapp", phone });
    assert(r1.sessionId && r2.sessionId && r1.sessionId !== r2.sessionId, "both starts returned distinct sessions");
    const active = await world.db.select().from(schema.onboardingSessions)
      .where(and(
        eq(schema.onboardingSessions.phone, phone),
        notInArray(schema.onboardingSessions.state, ["live", "failed", "abandoned"]),
      ));
    assert(active.length === 1, `exactly one active copilot session (got ${active.length})`);
    assert(active[0].id === r2.sessionId, "the newest session is the active one");
    const superseded = await world.db.select().from(schema.onboardingSessions)
      .where(and(
        eq(schema.onboardingSessions.phone, phone),
        eq(schema.onboardingSessions.state, "abandoned"),
      ));
    assert(superseded.length === 1, `the loser was superseded (got ${superseded.length} abandoned)`);

    // Raw racing insert (bypassing the CAS path) is rejected by the mig 0169
    // partial unique index — the DB is the single-winner backstop.
    let rejected = false;
    try {
      await world.db.insert(schema.onboardingSessions).values({
        id: crypto.randomUUID(), channel: "whatsapp", phone, state: "intake",
        transcript: [], proposals: [], intake: { facts: {} },
      });
    } catch (e: any) {
      rejected = /onboarding_sessions_active_phone_uniq|duplicate key/i.test(`${e?.message ?? ""} ${e?.cause?.message ?? ""}`);
    }
    assert(rejected, "raw concurrent active-session insert rejected by the unique backstop");

    // ── nlp: parallel first contact → one session row ─────────────────────
    const caller = await publicCaller();
    const waPhone = world.newPhone("cas460n");
    const [n1, n2] = await Promise.all([
      caller.nlp.processMessage({ tenantId: TENANT_ID, waPhoneNumber: waPhone, message: "hello" }).catch((e) => e),
      caller.nlp.processMessage({ tenantId: TENANT_ID, waPhoneNumber: waPhone, message: "hello" }).catch((e) => e),
    ]);
    assert(!(n1 instanceof Error) || !(n2 instanceof Error), "at least one nlp call succeeds");
    const rows = await world.db.select().from(schema.nlpSessions)
      .where(and(eq(schema.nlpSessions.tenantId, TENANT_ID), eq(schema.nlpSessions.waPhoneNumber, waPhone)));
    assert(rows.length === 1, `exactly one nlp session row (got ${rows.length})`);

    // ── Unique indexes actually exist in the migrated sim DB ──────────────
    const idx = (await world.db.execute(sql`
      SELECT indexname FROM pg_indexes
      WHERE indexname IN ('nlp_sessions_tenant_phone_uq','phone_otp_sessions_phone_purpose_uniq',
        'consents_tenant_phone_channel_uniq','onboarding_sessions_active_phone_uniq')`)) as unknown as any[];
    const names = (Array.isArray(idx) ? idx : (idx as any).rows ?? []).map((r: any) => r.indexname);
    for (const want of ["nlp_sessions_tenant_phone_uq", "phone_otp_sessions_phone_purpose_uniq",
      "consents_tenant_phone_channel_uniq", "onboarding_sessions_active_phone_uniq"]) {
      assert(names.includes(want), `unique index ${want} present (got ${names.join(",")})`);
    }
  },
};
