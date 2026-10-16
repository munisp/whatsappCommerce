// === W57 risk-shield ===
/**
 * J581 — Cross-tenant default registry lifecycle: idempotent write, cure on
 * repayment (active→cured claim-first, retry no-op), bureauRef NULL without
 * consent (consent-gated stamp only), and the cross-tenant read exposes
 * ONLY the aggregate { hasActiveDefault, count } — no origin tenant, no
 * amounts, no account refs (privacy contract).
 */
import { eq } from "drizzle-orm";
import { assert, TENANT_ID, SUPPLIER_TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J581",
  name: "default registry write/cure lifecycle + cross-tenant privacy",
  feature: "W57 risk-shield F2: cross-tenant default registry",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const ig = await import("../../server/services/identityGraph");
    const reg = await import("../../server/services/creditDefaultRegistry");

    const phone = world.newPhone("581");
    await ig.recordSignupIdentity(world.db as any, {
      tenantId: SUPPLIER_TENANT_ID, subjectType: "merchant", subjectId: "merch-j581", phone,
    });
    const hash = ig.hashIdentityLink("phone", phone);
    const accountId = `acct-j581-${phone.slice(-6)}`;

    // ── 1. Write is idempotent (unique tenant+account) ───────────────────
    const w1 = await reg.recordDefault(world.db as any, {
      tenantId: SUPPLIER_TENANT_ID, accountId, amountCents: 42_000_00, subjectType: "merchant", subjectId: "merch-j581",
    });
    const w2 = await reg.recordDefault(world.db as any, {
      tenantId: SUPPLIER_TENANT_ID, accountId, amountCents: 42_000_00, subjectType: "merchant", subjectId: "merch-j581",
    });
    assert(w1.created === true && w2.created === false, "registry write idempotent");

    // ── 2. Cross-tenant read: aggregate ONLY ─────────────────────────────
    const agg = await reg.crossTenantDefaultStatus(world.db as any, hash);
    assert(agg.hasActiveDefault === true && agg.activeDefaults === 1, "aggregate reports the active default");
    const keys = Object.keys(agg).sort();
    assert(JSON.stringify(keys) === JSON.stringify(["activeDefaults", "hasActiveDefault"]),
      "PRIVACY: cross-tenant read carries no tenantId / amount / accountId");
    assert(!("tenantId" in agg) && !("amountCents" in agg) && !("accountId" in agg), "no financial detail leaks cross-tenant");

    // ── 3. No consent → bureauRef stays NULL (existing consent rules) ────
    const rows = await world.db.select().from(schema.creditDefaultRegistry)
      .where(eq(schema.creditDefaultRegistry.accountId, accountId));
    assert(rows.length === 1 && rows[0].bureauRef == null, "no bureau report-back without consent");

    // ── 4. Cure on full repayment: active → cured, claim-first ───────────
    const c1 = await reg.cureDefault(world.db as any, { accountId });
    const c2 = await reg.cureDefault(world.db as any, { accountId });
    assert(c1 === true && c2 === false, "cure is claim-first (second cure no-op)");
    const after = await reg.crossTenantDefaultStatus(world.db as any, hash);
    assert(after.hasActiveDefault === false && after.activeDefaults === 0, "cured default no longer counts cross-tenant");
    const [finalRow] = await world.db.select().from(schema.creditDefaultRegistry)
      .where(eq(schema.creditDefaultRegistry.accountId, accountId));
    assert(finalRow.status === "cured" && finalRow.curedAt, "registry row stamped cured");
  },
};
