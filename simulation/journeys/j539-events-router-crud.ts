// === W53 EVENTS ===
/**
 * J539 — Merchant events router: create → publish (claim-first) → ticket
 * types → public storefront listing → sales board. Authz: cross-tenant
 * callers are FORBIDDEN; re-publish is an honest CONFLICT; the public
 * projection is PII-scrubbed (no metadata/createdBy).
 */
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { tenantCaller, publicCaller, expectTrpcError } from "./helpers";

export const journey: Journey = {
  id: "J539",
  name: "events router: create/publish/ticket-types/list/sales + authz",
  feature: "W53 events: merchant CRUD via tRPC",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const userId = 5391;
    await world.db.insert(schema.tenantMemberships).values({
      tenantId: TENANT_ID, userId: String(userId), role: "owner",
    }).onConflictDoNothing();
    try {
      const caller = await tenantCaller(TENANT_ID, { userId });
      const startsAt = new Date(Date.now() + 14 * 86_400_000);

      const ev = await caller.events.createEvent({
        tenantId: TENANT_ID,
        title: "W53 J539 Launch Night",
        description: "Router-created event",
        venue: "Civic Centre, VI",
        startsAt,
        capacity: 100,
      });
      assert(ev.id && ev.status === "draft", `event created as draft (got ${ev.status})`);

      // Public listing hides drafts.
      const pub = await publicCaller();
      let listed = await pub.events.listPublished({ tenantId: TENANT_ID });
      assert(!listed.some((e: any) => e.eventId === ev.id), "draft not publicly listed");

      // Publish (claim-first) — replay is an honest CONFLICT.
      const published = await caller.events.publishEvent({ tenantId: TENANT_ID, eventId: ev.id });
      assert(published.status === "published", "event published");
      await expectTrpcError(
        caller.events.publishEvent({ tenantId: TENANT_ID, eventId: ev.id }),
        "CONFLICT", "re-publish",
      );

      // Ticket types (money-adjacent — owner membership passes).
      const ga = await caller.events.addTicketType({
        tenantId: TENANT_ID, eventId: ev.id, name: "General",
        priceCents: 150_000, currency: "NGN", quantity: 60,
      });
      assert(ga.priceCents === 150_000 && ga.soldCount === 0, "ticket type minted in integer cents");

      // Public storefront: listed + PII-scrubbed projection.
      listed = await pub.events.listPublished({ tenantId: TENANT_ID });
      const row = listed.find((e: any) => e.eventId === ev.id);
      assert(row, "published event publicly listed");
      assert(row.title === "W53 J539 Launch Night", "public projection carries title");
      assert(!("metadata" in row) && !("createdBy" in row), "public projection is PII-scrubbed");
      const types = await pub.events.ticketTypes({ tenantId: TENANT_ID, eventId: ev.id });
      assert(types.length === 1 && types[0].remaining === 60 && types[0].priceCents === 150_000,
        `public ticket types (got ${JSON.stringify(types)})`);

      // Merchant board.
      const mine = await caller.events.listEvents({ tenantId: TENANT_ID });
      assert(mine.some((e: any) => e.id === ev.id), "merchant list shows the event");
      const sales = await caller.events.sales({ tenantId: TENANT_ID, eventId: ev.id });
      assert(sales.revenueCents === 0 && sales.tickets.length === 0 && sales.ticketTypes.length === 1,
        "sales board renders empty event");

      // Authz: another tenant's caller cannot touch the event.
      const stranger = await tenantCaller("tenant-j539-stranger", { userId: 5392 });
      await expectTrpcError(
        stranger.events.publishEvent({ tenantId: TENANT_ID, eventId: ev.id }),
        "FORBIDDEN", "cross-tenant publish",
      );
      await expectTrpcError(
        stranger.events.sales({ tenantId: TENANT_ID, eventId: ev.id }),
        "FORBIDDEN", "cross-tenant sales",
      );
    } finally {
      await world.db.delete(schema.tenantMemberships);
    }
  },
};
