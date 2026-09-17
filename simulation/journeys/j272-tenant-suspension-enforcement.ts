/**
 * === W40 tenancy (Coder A, TEN-1) ===
 * J272 — suspended/churned tenant enforcement end-to-end:
 *   1. An ACTIVE tenant's authenticated tRPC calls work; its WhatsApp
 *      channel processes inbound messages (contact provisioned).
 *   2. Once the tenant is SUSPENDED:
 *      - every authenticated tRPC call from a user of that tenant fails
 *        closed with 403 tenant_suspended (requireUser gate);
 *      - WhatsApp inbound for that tenant's phone number id is DROPPED
 *        (no contact provisioning, no reply, structured log) — never
 *        processed;
 *   3. Reactivating the tenant restores both paths.
 */
import { and, eq } from "drizzle-orm";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { expectTrpcError, tenantCaller } from "./helpers";
import * as payloads from "../payloads";

const SUSP_TENANT = "sim-w40-susp";
const SUSP_PHONE_NUMBER_ID = "pn_sim_w40_susp_001";

async function customerCount(world: World, tenantId: string, phone: string): Promise<number> {
  const schema = await import("../../drizzle/schema");
  const rows = await world.db
    .select({ id: schema.customers.id })
    .from(schema.customers)
    .where(and(eq(schema.customers.tenantId, tenantId), eq(schema.customers.whatsappPhone, phone)));
  return rows.length;
}

export const journey: Journey = {
  id: "J272",
  name: "suspended tenant enforcement (TEN-1)",
  feature: "tRPC 403 tenant_suspended + WA inbound dropped + reactivation restores",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");

    // ── Seed a dedicated active tenant with its own WA channel ──────────
    await world.db.insert(schema.tenants).values({
      id: SUSP_TENANT,
      name: "W40 Suspension Test Co",
      slug: "sim-w40-susp",
      plan: "starter",
      status: "active",
      whatsappPhoneNumberId: SUSP_PHONE_NUMBER_ID,
      whatsappBusinessAccountId: "waba_sim_w40_susp",
    });

    const caller = await tenantCaller(SUSP_TENANT, { userId: 2721 });

    // ── 1. Active tenant: API works, inbound is processed ───────────────
    const listed = await caller.marketplace.listSellers({ tenantId: SUSP_TENANT });
    assert(Array.isArray(listed), "active tenant API call succeeds");

    const phoneActive = world.newPhone("j272a");
    await world.inboundFor(SUSP_PHONE_NUMBER_ID, payloads.inbound.text(SUSP_PHONE_NUMBER_ID, phoneActive, "hello"));
    assert((await customerCount(world, SUSP_TENANT, phoneActive)) === 1,
      "active tenant inbound provisions the contact");

    // ── 2. Suspend: API 403 tenant_suspended + WA inbound dropped ───────
    await world.db.update(schema.tenants)
      .set({ status: "suspended", updatedAt: new Date() })
      .where(eq(schema.tenants.id, SUSP_TENANT));

    const err = await expectTrpcError(
      caller.marketplace.listSellers({ tenantId: SUSP_TENANT }),
      "FORBIDDEN",
      "suspended tenant API call",
    );
    assert(String(err?.message ?? "").includes("tenant_suspended"),
      `403 carries tenant_suspended (got ${err?.message})`);

    const phoneSusp = world.newPhone("j272b");
    const outboundBefore = world.outbound.toPhone(phoneSusp).length;
    await world.inboundFor(SUSP_PHONE_NUMBER_ID, payloads.inbound.text(SUSP_PHONE_NUMBER_ID, phoneSusp, "hello"));
    assert((await customerCount(world, SUSP_TENANT, phoneSusp)) === 0,
      "suspended tenant inbound provisions NO contact (dropped before processing)");
    assert(world.outbound.toPhone(phoneSusp).length === outboundBefore,
      "suspended tenant inbound gets NO reply");

    // ── 3. Reactivate: both paths work again ────────────────────────────
    await world.db.update(schema.tenants)
      .set({ status: "active", updatedAt: new Date() })
      .where(eq(schema.tenants.id, SUSP_TENANT));

    const listedAfter = await caller.marketplace.listSellers({ tenantId: SUSP_TENANT });
    assert(Array.isArray(listedAfter), "reactivated tenant API call succeeds");

    const phoneBack = world.newPhone("j272c");
    await world.inboundFor(SUSP_PHONE_NUMBER_ID, payloads.inbound.text(SUSP_PHONE_NUMBER_ID, phoneBack, "hello"));
    assert((await customerCount(world, SUSP_TENANT, phoneBack)) === 1,
      "reactivated tenant inbound is processed again");

    // Cleanup: retire the dedicated tenant (churned keeps its own drop
    // semantics and cannot collide with later journeys).
    await world.db.update(schema.tenants)
      .set({ status: "churned", updatedAt: new Date() })
      .where(eq(schema.tenants.id, SUSP_TENANT));
  },
};
