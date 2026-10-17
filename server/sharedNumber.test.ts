import { describe, expect, it } from "vitest";
import {
  applySharedEnvelope,
  isStoresCommand,
  parseShopCommand,
  shopCodeOf,
  shopLink,
  tagReplyId,
  untagReplyId,
} from "./services/sharedNumber";

const shop = { name: "Adire Atelier", code: "adire" };

describe("shared number: shop codes", () => {
  it("reads SHOP <code> in any case, with an optional @", () => {
    expect(parseShopCommand("SHOP ADIRE")).toBe("adire");
    expect(parseShopCommand("  store  @Adire-2 ")).toBe("adire-2");
    expect(parseShopCommand("shop")).toBeNull();
    expect(parseShopCommand("I want to shop adire things")).toBeNull();
    expect(parseShopCommand("shop a")).toBeNull(); // codes are at least 2 characters
  });

  it("recognises the switch-shops commands only on their own", () => {
    expect(isStoresCommand("stores")).toBe(true);
    expect(isStoresCommand("My Shops")).toBe(true);
    expect(isStoresCommand("which stores sell rice")).toBe(false);
  });

  it("falls back to the slug when no code is set", () => {
    expect(shopCodeOf({ shopCode: null, slug: "Adire-Atelier" })).toBe("adire-atelier");
    expect(shopCodeOf({ shopCode: "ADIRE", slug: "x" })).toBe("adire");
  });

  it("builds a wa.me link with the code prefilled, only when a display number exists", () => {
    const cfg = { phoneNumberId: "p", accessToken: "t", displayNumber: "2348000000000", platformName: "Market" };
    expect(shopLink("adire", cfg)).toBe("https://wa.me/2348000000000?text=SHOP%20ADIRE");
    expect(shopLink("adire", { ...cfg, displayNumber: "" })).toBeNull();
  });
});

describe("shared number: button ids carry the shop", () => {
  it("round-trips, including ids that contain dots and colons", () => {
    const tagged = tagReplyId("adire", "order_pay:abc.def", 256);
    expect(tagged).toBe("s.adire.order_pay:abc.def");
    expect(untagReplyId(tagged)).toEqual({ code: "adire", id: "order_pay:abc.def" });
  });

  it("never tags twice, and leaves an id untagged rather than truncating it", () => {
    expect(tagReplyId("adire", "s.adire.menu_1", 256)).toBe("s.adire.menu_1");
    const long = "x".repeat(195);
    expect(tagReplyId("adire", long, 200)).toBe(long);
  });

  it("does not mistake an ordinary id for a tagged one", () => {
    expect(untagReplyId("menu_1")).toBeNull();
    expect(untagReplyId("shared_pick:adire")).toBeNull();
  });
});

describe("shared number: every message names the shop", () => {
  it("prefixes text once", () => {
    const once = applySharedEnvelope(shop, { type: "text", text: { body: "Your order is confirmed" } });
    expect(once.text.body).toBe("🛍️ *Adire Atelier*\nYour order is confirmed");
    expect(applySharedEnvelope(shop, once).text.body).toBe(once.text.body);
  });

  it("names the shop on interactive bodies and tags buttons and list rows", () => {
    const p = applySharedEnvelope(shop, {
      type: "interactive",
      interactive: {
        type: "list",
        body: { text: "Pick one" },
        action: { button: "Menu", sections: [{ title: "S", rows: [{ id: "menu_1", title: "Shop" }] }] },
      },
    });
    expect(p.interactive.body.text.startsWith("🛍️ *Adire Atelier*")).toBe(true);
    expect(p.interactive.action.sections[0].rows[0].id).toBe("s.adire.menu_1");
    const b = applySharedEnvelope(shop, {
      type: "interactive",
      interactive: { type: "button", body: { text: "Pay?" }, action: { buttons: [{ type: "reply", reply: { id: "order_pay:1", title: "Pay" } }] } },
    });
    expect(b.interactive.action.buttons[0].reply.id).toBe("s.adire.order_pay:1");
  });

  it("captions media and leaves templates alone", () => {
    expect(applySharedEnvelope(shop, { type: "image", image: { link: "https://x/y.png" } }).image.caption).toBe("🛍️ *Adire Atelier*\n");
    const tpl = { type: "template", template: { name: "order_update", language: { code: "en" } } };
    expect(applySharedEnvelope(shop, tpl)).toEqual(tpl);
  });

  it("does not modify the caller's payload", () => {
    const original = { type: "text", text: { body: "hi" } };
    applySharedEnvelope(shop, original);
    expect(original.text.body).toBe("hi");
  });
});

describe("sharedClaimId", () => {
  it("fits processed_webhook_events.id (64) for a real-length Meta message id, and is stable and distinct", async () => {
    const { sharedClaimId } = await import("./services/sharedNumber");
    const wamid = "wamid.HBgNMjM0NzA3NzM0NzQyMhUCABIYFDNBNEExODg2ODE4OEUxNjQ3MzU2AA==";
    expect(sharedClaimId(wamid).length).toBeLessThanOrEqual(64);
    expect(sharedClaimId(wamid)).toBe(sharedClaimId(wamid));
    expect(sharedClaimId(wamid)).not.toBe(sharedClaimId(wamid + "x"));
    expect(sharedClaimId(wamid).startsWith("shared:")).toBe(true);
  });
});
