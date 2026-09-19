// === W47 stakeholders ===
/**
 * J449 — ONB-S-3 / ONB-TOK-1 / ONB-S-4 / ONB-S-5 / ONB-S-15:
 *   - tenantInvite.resend preserves the boundPhone (row AND JWT payload)
 *     and writes an audit row — a resent link is never an unbound bearer;
 *   - minting REFUSES when the tenant has no settings.adminPhone;
 *   - invites are revocable and listable; a revoked invite never redeems;
 *   - the portal URL carries the token in the FRAGMENT, not the query.
 */
import jwt from "jsonwebtoken";
import { and, eq } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { adminCaller, expectTrpcError, publicCaller } from "./helpers";
// W47 MERGER: ENV must be imported LAZILY inside run() — a static import
// evaluates server/_core/env BEFORE the sim world's setEnv boot, freezing
// LLM_BASE_URL/PAYSTACK keys at their pre-boot defaults and breaking every
// payment/LLM journey in the shared module graph.

const PHONE = "+2348099700449";

export const journey: Journey = {
  id: "J449",
  name: "invite resend keeps phone binding; revocation; fragment URL",
  feature: "W47 stakeholders: ONB-S-3/4/5 + ONB-TOK-1 invite hardening",
  async run(world: World) {
    const { ENV } = await import("../../server/_core/env");
    const schema = await import("../../drizzle/schema");
    const admin = await adminCaller();
    const pub = await publicCaller();
    const proof = jwt.sign({ type: "phone_identity", phone: PHONE }, ENV.jwtSecret, { expiresIn: "15m" });

    // ── 1. Resend preserves the binding + is audited ────────────────────
    const tenantId = (await admin.onboarding.start({ name: "J449 Bound" })).tenantId;
    await world.db.update(schema.tenants).set({ settings: { adminPhone: PHONE } })
      .where(eq(schema.tenants.id, tenantId));
    const created = await admin.tenantInvite.create({ tenantId });
    const resent = await admin.tenantInvite.resend({ tenantId });
    const resentToken = resent.portalUrl.split("token=")[1];
    const payload = jwt.verify(resentToken, ENV.jwtSecret) as any;
    assert(payload.boundPhone === PHONE, "ONB-S-3: resent JWT carries boundPhone");
    const [row] = await world.db.select().from(schema.tenantInviteTokens)
      .where(eq(schema.tenantInviteTokens.jti, payload.jti));
    assert(row?.boundPhone === PHONE, "ONB-S-3: resent registry row carries boundPhone");
    // Bare link (no proof) refused → binding holds after resend.
    const bare = await pub.tenantInvite.validate({ token: resentToken });
    assert(bare.valid === false, "resent link without phone proof is refused");

    const audits = await world.db.select().from(schema.auditLogs)
      .where(and(eq(schema.auditLogs.tenantId, tenantId)));
    assert(audits.some((a: any) => a.action === "tenantInvite.create"), "create audited");
    const resendAudit = audits.find((a: any) => a.action === "tenantInvite.resend");
    assert(resendAudit && (resendAudit.after as any)?.boundPhone === PHONE, "ONB-TOK-1: resend audited with jti + boundPhone");

    // ── 2. No adminPhone → minting refuses (no new unbound invites) ─────
    const bare2 = (await admin.onboarding.start({ name: "J449 Unbound" })).tenantId;
    await expectTrpcError(
      admin.tenantInvite.create({ tenantId: bare2 }),
      "PRECONDITION_FAILED",
      "ONB-S-4: create refuses a tenant without an admin phone",
    );
    await expectTrpcError(
      admin.tenantInvite.resend({ tenantId: bare2 }),
      "PRECONDITION_FAILED",
      "ONB-S-4: resend refuses a tenant without an admin phone",
    );

    // ── 3. Revocation kills an outstanding invite ───────────────────────
    const createdJti = (jwt.verify(created.token, ENV.jwtSecret) as any).jti;
    const rev = await admin.tenantInvite.revoke({ tenantId, jti: createdJti });
    assert(rev.revoked === true, "invite revoked");
    const afterRevoke = await pub.tenantInvite.validate({ token: created.token, identityProof: proof });
    assert(afterRevoke.valid === false && /revoked/i.test(afterRevoke.error ?? ""), "revoked invite never redeems");
    const list = await admin.tenantInvite.list({ tenantId });
    assert(list.some((t: any) => t.jti === createdJti && t.revokedAt), "list shows revokedAt");
    assert(list.some((t: any) => t.jti === payload.jti && !t.revokedAt && !t.consumedAt), "list shows the live resent invite");

    // ── 4. Fragment URL (ONB-S-15) ──────────────────────────────────────
    assert(created.portalUrl.includes("#token=") && !created.portalUrl.includes("?token="),
      "ONB-S-15: portal URL carries the token in the fragment");
    assert(resent.portalUrl.includes("#token="), "resent URL uses the fragment too");
  },
};
