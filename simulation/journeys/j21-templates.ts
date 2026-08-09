/**
 * J21 — Templates: statusSync pulls APPROVED/PENDING from the Meta mock into
 * the cache; create submits to Meta (PENDING); the approved-only list is the
 * broadcast picker data.
 */
import { setTemplates } from "../metaMock";
import { TENANT_ID, WABA_ID, assert, assertIncludes, type World } from "../world";
import type { Journey } from "../runner";
import { adminCaller } from "./helpers";

export const journey: Journey = {
  id: "J21",
  name: "template sync + create",
  feature: "waTemplates statusSync/create/picker",
  async run(world) {
    const caller = await adminCaller();

    // Meta (mock) currently serves one APPROVED + one PENDING template.
    setTemplates(WABA_ID, [
      { id: "tpl-approved-1", name: "sim_broadcast", category: "UTILITY", language: "en_US", status: "APPROVED", components: [{ type: "BODY", text: "Hello {{1}}, {{2}}" }] },
      { id: "tpl-pending-1", name: "sim_promo_blast", category: "MARKETING", language: "en_US", status: "PENDING", components: [{ type: "BODY", text: "Promo for {{1}}" }] },
    ]);

    // ── statusSync via list(sync=true) ───────────────────────────────────
    const list = await caller.waTemplates.list({ tenantId: TENANT_ID, sync: true });
    const names = list.templates.map((t: any) => `${t.name}:${t.status}`);
    assert(names.includes("sim_broadcast:APPROVED"), `APPROVED template pulled (got ${names})`);
    assert(names.includes("sim_promo_blast:PENDING"), "PENDING template pulled");

    // The sync hit the Meta mock's message_templates endpoint.
    const syncCalls = world.outbound.all().filter((c) => c.url.includes("/message_templates") && c.method === "GET");
    assert(syncCalls.length >= 1, "GET /message_templates observed on the mock");

    // ── Broadcast picker data = approved-only list ───────────────────────
    const approvedOnly = await caller.waTemplates.list({ tenantId: TENANT_ID, approvedOnly: true });
    assert(approvedOnly.templates.length === 1 && approvedOnly.templates[0].name === "sim_broadcast", "picker shows only APPROVED templates");

    // ── create submits to Meta and lands as PENDING ──────────────────────
    const created = await caller.waTemplates.create({
      tenantId: TENANT_ID,
      name: "sim_restock_alert",
      category: "UTILITY",
      language: "en_US",
      body: "Good news {{1}} — {{2}} is back in stock!",
    });
    assert(created, "create returned");
    const createCalls = world.outbound.all().filter((c) => c.url.includes("/message_templates") && c.method === "POST");
    assert(createCalls.length === 1, "POST /message_templates observed");
    assertIncludes(JSON.stringify(createCalls[0].body), "sim_restock_alert", "create payload carries the template name");

    // Re-sync: the new template appears as PENDING.
    const relist = await caller.waTemplates.list({ tenantId: TENANT_ID, sync: true });
    const restock = relist.templates.find((t: any) => t.name === "sim_restock_alert");
    assert(restock?.status === "PENDING", "newly created template syncs back as PENDING");
    const approvedAfter = await caller.waTemplates.list({ tenantId: TENANT_ID, approvedOnly: true });
    assert(approvedAfter.templates.length === 1, "PENDING template stays out of the picker");
  },
};
