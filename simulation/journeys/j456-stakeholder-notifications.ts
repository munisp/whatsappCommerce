// === W47 stakeholders ===
/**
 * J456 — ONB-S-9/S-12/S-16 (residual P2s):
 *   - staff add + remove NOTIFY the affected user (notification log rows);
 *   - supplier profile activation notifies the supplier's admin phone;
 *   - agents can query their own commission statements with a phone proof.
 */
import { randomUUID } from "crypto";
import jwt from "jsonwebtoken";
import { and, eq } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { approveKyb, tenantCaller } from "./helpers";
// W47 MERGER: ENV must be imported LAZILY inside run() — a static import
// evaluates server/_core/env BEFORE the sim world's setEnv boot, freezing
// LLM_BASE_URL/PAYSTACK keys at their pre-boot defaults and breaking every
// payment/LLM journey in the shared module graph.

const T = "j456-notify";
const STAFF_PHONE = "+2348099900456";
const ADMIN_PHONE = "+2348099910456";
const AGENT_PHONE = "2348040002456";

export const journey: Journey = {
  id: "J456",
  name: "secondary-role notifications + agent statement surface",
  feature: "W47 stakeholders: ONB-S-9/S-12/S-16 notifications",
  async run(world: World) {
    const { ENV } = await import("../../server/_core/env");
    const schema = await import("../../drizzle/schema");
    await world.db.insert(schema.tenants).values({
      id: T, name: "J456 Notify", slug: T, status: "active",
      settings: { adminPhone: ADMIN_PHONE },
    }).onConflictDoNothing();
    await world.db.update(schema.tenants).set({ settings: { adminPhone: ADMIN_PHONE } })
      .where(eq(schema.tenants.id, T));
    await world.db.insert(schema.tenantMemberships).values({
      tenantId: T, userId: "4561", role: "owner",
    }).onConflictDoNothing();
    const owner = await tenantCaller(T, { userId: 4561 });

    // ── 1. Staff add/remove notifications (ONB-S-16) ────────────────────
    const [staffUser] = await world.db.insert(schema.users).values({
      openId: `j456-staff-${randomUUID().slice(0, 8)}`, name: "J456 Staff", loginMethod: "keycloak",
      role: "user", phone: STAFF_PHONE, phoneVerified: true, lastSignedIn: new Date(),
    }).returning();
    await owner.membership.add({ tenantId: T, userId: staffUser.id, role: "catalog" });
    await owner.membership.remove({ tenantId: T, userId: staffUser.id });
    const notifRows = await world.db.select().from(schema.whatsappNotificationLog)
      .where(and(eq(schema.whatsappNotificationLog.tenantId, T), eq(schema.whatsappNotificationLog.phone, STAFF_PHONE.replace("+", ""))));
    const types = notifRows.map((r: any) => r.notifType);
    assert(types.includes("staff_membership_added"), `add notice logged (got ${JSON.stringify(types)})`);
    assert(types.includes("staff_membership_removed"), "remove notice logged");

    // ── 2. Supplier activation notice (ONB-S-9) ─────────────────────────
    await approveKyb(world, T);
    await owner.procurement.upsertSupplierProfile({ tenantId: T, moqCents: 0 });
    const supNotif = await world.db.select().from(schema.whatsappNotificationLog)
      .where(and(eq(schema.whatsappNotificationLog.tenantId, T), eq(schema.whatsappNotificationLog.notifType, "supplier_profile_active")));
    assert(supNotif.length >= 1, "supplier activation notice logged");

    // ── 3. Agent statement surface (ONB-S-12) ───────────────────────────
    const svc = await import("../../server/services/agents");
    const { agent } = await svc.upsertAgent(world.db, {
      tenantId: T, name: "Agent Ngozi", phone: AGENT_PHONE, code: "AGT-456", commissionBps: 1000,
    });
    const stId = randomUUID();
    await world.db.insert(schema.agentCommissionStatements).values({
      id: stId, tenantId: T, agentId: agent.id,
      periodStart: new Date(Date.now() - 86400_000), periodEnd: new Date(),
      currency: "NGN", commissionCount: 1, totalCents: 10000, status: "paid",
    });
    const proof = jwt.sign({ type: "phone_identity", phone: AGENT_PHONE }, ENV.jwtSecret, { expiresIn: "15m" });
    const { publicCaller } = await import("./helpers");
    const pub = await publicCaller();
    const mine = await pub.ucDocs.agentMyStatements({ tenantId: T, identityProof: proof });
    assert(mine.agent?.code === "AGT-456", "agent resolves by proof phone");
    assert(mine.statements.length === 1 && mine.statements[0].totalCents === 10000, "agent sees their statement");
    // A stranger's proof sees nothing.
    const stranger = await pub.ucDocs.agentMyStatements({
      tenantId: T,
      identityProof: jwt.sign({ type: "phone_identity", phone: "2348000000000" }, ENV.jwtSecret, { expiresIn: "15m" }),
    });
    assert(stranger.agent === null && stranger.statements.length === 0, "stranger proof sees nothing");
  },
};
