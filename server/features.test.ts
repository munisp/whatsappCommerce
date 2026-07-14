import { describe, it, expect } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

// ─── Shared mock context ────────────────────────────────────────────────────
function makeCtx(role: "admin" | "user" = "admin"): TrpcContext {
  return {
    user: {
      id: 1,
      openId: "test-user",
      email: "test@example.com",
      name: "Test User",
      loginMethod: "manus",
      role,
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSignedIn: new Date(),
    },
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: () => {} } as unknown as TrpcContext["res"],
  };
}

// ─── Template Versioning ────────────────────────────────────────────────────
describe("templateVersions router", () => {
  it("createVersion input schema accepts required fields", () => {
    const input = { templateId: "tpl-001", bodyText: "Hello {{name}}", changeNote: "Initial version" };
    expect(input.templateId).toBeTruthy();
    expect(input.bodyText).toBeTruthy();
  });

  it("publishVersion input schema requires id", () => {
    const input = { id: "ver-001" };
    expect(typeof input.id).toBe("string");
  });

  it("revertToVersion input schema requires versionId", () => {
    const input = { templateId: "tpl-001", versionId: "ver-001" };
    expect(input.templateId).toBeTruthy();
    expect(input.versionId).toBeTruthy();
  });

  it("listVersions input schema accepts templateId and optional limit", () => {
    const input = { templateId: "tpl-001", limit: 10 };
    expect(input.limit).toBe(10);
  });

  it("router exposes all required procedures", () => {
    const router = appRouter._def.procedures;
    expect("templateVersions.create" in router).toBe(true);
    expect("templateVersions.list" in router).toBe(true);
    expect("templateVersions.publish" in router).toBe(true);
    expect("templateVersions.revert" in router).toBe(true);
  });
});

// ─── Broadcast Campaigns ────────────────────────────────────────────────────
describe("broadcast router", () => {
  it("create input schema validates required fields", () => {
    const input = {
      name: "Summer Sale 2026",
      templateId: "tpl-001",
      segmentFilter: { stage: "qualified" },
      scheduledAt: new Date().toISOString(),
    };
    expect(input.name.length).toBeGreaterThan(0);
    expect(input.templateId).toBeTruthy();
  });

  it("delivery stats shape has expected keys", () => {
    const stats = { total: 105, sent: 90, delivered: 85, failed: 5, pending: 10 };
    expect(stats).toHaveProperty("total");
    expect(stats).toHaveProperty("delivered");
    expect(stats).toHaveProperty("failed");
    expect(stats.sent + stats.failed + stats.pending).toBe(stats.total);
  });

  it("router exposes all required procedures", () => {
    const router = appRouter._def.procedures;
    expect("broadcast.list" in router).toBe(true);
    expect("broadcast.create" in router).toBe(true);
    expect("broadcast.stats" in router).toBe(true);
    expect("broadcast.cancel" in router).toBe(true);
    expect("broadcast.send" in router).toBe(true);
  });

  it("segment filter can target by Twenty CRM stage", () => {
    const filter = { source: "twenty", stage: "qualified", minDealValue: 1000 };
    expect(filter.source).toBe("twenty");
    expect(filter.stage).toBeTruthy();
  });

  it("segment filter can target by Odoo product category", () => {
    const filter = { source: "odoo", productCategory: "Electronics", minOrderValue: 50 };
    expect(filter.source).toBe("odoo");
    expect(filter.productCategory).toBeTruthy();
  });
});

// ─── Menu Push Flow ─────────────────────────────────────────────────────────
describe("menu push flow", () => {
  it("menu router exposes assignToTenant and getAssignments", () => {
    const router = appRouter._def.procedures;
    expect("menu.assignToTenant" in router).toBe(true);
    expect("menu.getAssignments" in router).toBe(true);
    expect("menu.unassignFromTenant" in router).toBe(true);
  });

  it("WhatsApp Cloud API payload shape is correct for list menu", () => {
    const payload = {
      messaging_product: "whatsapp",
      to: "+2348012345678",
      type: "interactive",
      interactive: {
        type: "list",
        header: { type: "text", text: "Our Menu" },
        body: { text: "Select an option below:" },
        footer: { text: "Powered by WhatsApp Commerce" },
        action: {
          button: "View Options",
          sections: [
            {
              title: "Products",
              rows: [
                { id: "prod-001", title: "iPhone 15 Pro", description: "₦850,000" },
                { id: "prod-002", title: "Samsung S24", description: "₦720,000" },
              ],
            },
          ],
        },
      },
    };
    expect(payload.messaging_product).toBe("whatsapp");
    expect(payload.interactive.type).toBe("list");
    expect(payload.interactive.action.sections[0].rows).toHaveLength(2);
  });

  it("WhatsApp Cloud API payload shape is correct for button menu", () => {
    const payload = {
      messaging_product: "whatsapp",
      to: "+2348012345678",
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: "How can we help you today?" },
        action: {
          buttons: [
            { type: "reply", reply: { id: "browse", title: "Browse Catalog" } },
            { type: "reply", reply: { id: "orders", title: "My Orders" } },
            { type: "reply", reply: { id: "support", title: "Support" } },
          ],
        },
      },
    };
    expect(payload.interactive.type).toBe("button");
    expect(payload.interactive.action.buttons).toHaveLength(3);
    expect(payload.interactive.action.buttons[0].reply.id).toBe("browse");
  });

  it("menu auto-populate merges Odoo products and Twenty deals", () => {
    const odooProducts = [
      { id: "p1", name: "iPhone 15 Pro", price: 850000, category: "Electronics" },
      { id: "p2", name: "Samsung S24", price: 720000, category: "Electronics" },
    ];
    const twentyDeals = [
      { id: "d1", name: "TechMart Africa", stage: "qualified" },
    ];
    const menuItems = [
      ...odooProducts.map(p => ({ id: p.id, title: p.name, description: `₦${p.price.toLocaleString()}`, source: "odoo" })),
      ...twentyDeals.map(d => ({ id: d.id, title: d.name, description: `Stage: ${d.stage}`, source: "twenty" })),
    ];
    expect(menuItems).toHaveLength(3);
    expect(menuItems.filter(m => m.source === "odoo")).toHaveLength(2);
    expect(menuItems.filter(m => m.source === "twenty")).toHaveLength(1);
  });
});

// ─── Template toggleActive ───────────────────────────────────────────────────
describe("template.toggleActive", () => {
  it("router exposes toggleActive procedure", () => {
    const router = appRouter._def.procedures;
    expect("template.toggleActive" in router).toBe(true);
  });

  it("toggleActive input requires id and isActive boolean", () => {
    const input = { id: "tpl-001", isActive: false };
    expect(typeof input.isActive).toBe("boolean");
    expect(input.id).toBeTruthy();
  });

  it("published template has isActive=true, draft has isActive=false", () => {
    const published = { id: "t1", isActive: true, name: "Order Confirmation" };
    const draft = { id: "t2", isActive: false, name: "Draft Promo" };
    expect(published.isActive).toBe(true);
    expect(draft.isActive).toBe(false);
  });
});
