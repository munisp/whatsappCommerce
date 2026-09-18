// === W46 inventory-depth ===
/**
 * J415 — ORD-20: delivery_claims entity + resolution state machine.
 * open → under_review → approved → resolved (with resolution); illegal
 * transitions (open→resolved, resolved→anything) are refused; claims are
 * tenant-scoped; photos + type persisted.
 */
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J415",
  name: "delivery claim lifecycle + state machine guards",
  feature: "ORD-20 delivery_claims",
  async run(world: World) {
    const { appRouter } = await import("../../server/routers");
    const caller = appRouter.createCaller({
      user: { id: 0, role: "user", tenantId: TENANT_ID, name: "j415" },
    } as any);
    const shipmentId = `shp-w46-j415-${Date.now().toString(36)}`;

    const { id } = await caller.inventoryDepth.createClaim({
      tenantId: TENANT_ID,
      shipmentId,
      type: "damaged",
      photos: ["https://cdn.example.com/claims/j415-1.jpg", "https://cdn.example.com/claims/j415-2.jpg"],
      description: "Box crushed, two units broken in transit",
    });
    assert(id, "claim created");

    let [claim] = await caller.inventoryDepth.listClaims({ tenantId: TENANT_ID, shipmentId });
    assert(claim.status === "open" && claim.type === "damaged", "claim opens in 'open'");
    assert(Array.isArray(claim.photos) && claim.photos.length === 2, "photos persisted");

    // Illegal: open → resolved skips review.
    let illegal = false;
    try {
      await caller.inventoryDepth.transitionClaim({ tenantId: TENANT_ID, claimId: id, to: "resolved", resolution: "refund" });
    } catch (e: any) {
      illegal = e?.code === "PRECONDITION_FAILED";
    }
    assert(illegal, "open→resolved refused by the state machine");

    // Legal path: open → under_review → approved → resolved(replacement).
    await caller.inventoryDepth.transitionClaim({ tenantId: TENANT_ID, claimId: id, to: "under_review" });
    await caller.inventoryDepth.transitionClaim({ tenantId: TENANT_ID, claimId: id, to: "approved" });
    // Resolving without a resolution is refused.
    let needRes = false;
    try {
      await caller.inventoryDepth.transitionClaim({ tenantId: TENANT_ID, claimId: id, to: "resolved" });
    } catch {
      needRes = true;
    }
    assert(needRes, "resolve requires a resolution");
    await caller.inventoryDepth.transitionClaim({ tenantId: TENANT_ID, claimId: id, to: "resolved", resolution: "replacement" });

    [claim] = await caller.inventoryDepth.listClaims({ tenantId: TENANT_ID, shipmentId });
    assert(claim.status === "resolved" && claim.resolution === "replacement", "claim resolved with resolution");
    assert(claim.resolvedAt, "resolvedAt stamped");

    // Terminal: resolved → anything refused.
    let terminal = false;
    try {
      await caller.inventoryDepth.transitionClaim({ tenantId: TENANT_ID, claimId: id, to: "open" });
    } catch (e: any) {
      terminal = e?.code === "PRECONDITION_FAILED";
    }
    assert(terminal, "resolved is terminal");

    // Reject path on a second claim: open → rejected → resolved(none).
    const c2 = await caller.inventoryDepth.createClaim({ tenantId: TENANT_ID, shipmentId, type: "lost" });
    await caller.inventoryDepth.transitionClaim({ tenantId: TENANT_ID, claimId: c2.id, to: "rejected" });
    await caller.inventoryDepth.transitionClaim({ tenantId: TENANT_ID, claimId: c2.id, to: "resolved", resolution: "none" });
    const rejected = await caller.inventoryDepth.listClaims({ tenantId: TENANT_ID, shipmentId });
    assert(rejected.length === 2 && rejected.every((c) => c.status === "resolved"), "both claims resolved");
  },
};
// === END W46 inventory-depth ===
