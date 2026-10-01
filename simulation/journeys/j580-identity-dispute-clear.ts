// === W57 risk-shield ===
/**
 * J580 — Due process: subject disputes an identity flag (status →
 * 'disputed', claim-first) → admin review CLEARS it (eligibility restored,
 * audited) and on a second flag CONFIRMS it (freeze stands, audited).
 * Double-review is a claim-first no-op.
 */
import { and, eq } from "drizzle-orm";
import { assert, TENANT_ID, SUPPLIER_TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J580",
  name: "subject dispute → admin clear restores credit eligibility",
  feature: "W57 risk-shield F1: identity-flag due process",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const ig = await import("../../server/services/identityGraph");
    const reg = await import("../../server/services/creditDefaultRegistry");

    const phone = world.newPhone("580");
    await ig.recordSignupIdentity(world.db as any, {
      tenantId: SUPPLIER_TENANT_ID, subjectType: "merchant", subjectId: "merch-j580-default", phone,
    });
    await reg.recordDefault(world.db as any, {
      tenantId: SUPPLIER_TENANT_ID, accountId: `acct-j580-${phone.slice(-6)}`,
      amountCents: 80_000_00, subjectType: "merchant", subjectId: "merch-j580-default",
    });
    const buyerId = `cust-j580-${phone.slice(-6)}`;
    const chk = await ig.recordSignupIdentity(world.db as any, {
      tenantId: TENANT_ID, subjectType: "buyer", subjectId: buyerId, phone,
    });
    assert(chk.flagged && chk.flagId, "flag raised");

    // ── 1. Dispute (claim-first: active → disputed; retry is a no-op) ────
    const d1 = await ig.disputeIdentityFlag(world.db as any, { flagId: chk.flagId!, tenantId: TENANT_ID, note: "not my account" });
    assert(d1.ok && d1.status === "disputed", "flag disputed");
    const d2 = await ig.disputeIdentityFlag(world.db as any, { flagId: chk.flagId!, tenantId: TENANT_ID });
    assert(d2.ok && d2.status === "disputed", "dispute retry idempotent");
    assert(await ig.isCreditFrozen(world.db as any, TENANT_ID, "buyer", buyerId), "still frozen while disputed");

    // ── 2. Admin CLEAR → eligibility restored + audit ────────────────────
    const rev = await ig.reviewIdentityFlag(world.db as any, {
      flagId: chk.flagId!, tenantId: TENANT_ID, decision: "clear", reviewerId: "admin-j580", note: "mistaken link",
    });
    assert(rev.ok && rev.changed && rev.status === "cleared", "admin cleared the flag");
    assert(!(await ig.isCreditFrozen(world.db as any, TENANT_ID, "buyer", buyerId)), "eligibility restored after clear");
    const rev2 = await ig.reviewIdentityFlag(world.db as any, {
      flagId: chk.flagId!, tenantId: TENANT_ID, decision: "confirm", reviewerId: "admin-j580",
    });
    assert(rev2.ok && !rev2.changed && rev2.status === "cleared", "double-review is a claim-first no-op");
    const audits = await world.db.select().from(schema.auditLogs)
      .where(and(eq(schema.auditLogs.entityType, "identity_flag"), eq(schema.auditLogs.entityId, chk.flagId!)));
    assert(audits.some((a: any) => a.action === "identity.flag_disputed"), "dispute audited");
    assert(audits.some((a: any) => a.action === "identity.flag_cleared"), "clear audited");

    // ── 3. CONFIRM path: a fresh flag confirmed stays frozen ─────────────
    const chk2 = await ig.checkLinkedDefaults(world.db as any, TENANT_ID, "buyer", buyerId);
    assert(chk2.flagged && chk2.flagId && chk2.flagId !== chk.flagId, "cleared subject can be re-flagged by a new check");
    const conf = await ig.reviewIdentityFlag(world.db as any, {
      flagId: chk2.flagId!, tenantId: TENANT_ID, decision: "confirm", reviewerId: "admin-j580", note: "link verified",
    });
    assert(conf.ok && conf.changed && conf.status === "confirmed", "admin confirmed the flag");
    assert(await ig.isCreditFrozen(world.db as any, TENANT_ID, "buyer", buyerId), "confirmed flag keeps credit frozen");
  },
};
