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

describe("ledgerId: the dedupe ledger key fits processed_webhook_events.id (64)", () => {
  it("keeps short ids as they are and turns long ones into a stable 64-character key", async () => {
    const { ledgerId } = await import("./services/webhookDedupe");
    const nigerian = "wamid.HBgNMjM0NzA3NzM0NzQyMhUCABIYFDNCQTQzRTgwN0M1MzRFMDgyQUE1AA=="; // 66, from a +234 number
    expect(nigerian.length).toBe(66);
    expect(ledgerId(nigerian)).toHaveLength(64);
    expect(ledgerId(nigerian)).toBe(ledgerId(nigerian)); // the same message is still caught as a duplicate
    expect(ledgerId(nigerian + "x")).not.toBe(ledgerId(nigerian));
    expect(ledgerId("wamid.short")).toBe("wamid.short"); // existing rows still match
  });
});

describe("shared lobby: shops near the buyer", () => {
  it("reads 'near me' and what is wanted", async () => {
    const { isNearText, nearQueryOf } = await import("./services/sharedLobby");
    for (const t of ["who sells pepsi near me?", "shops near me", "any pharmacy around here", "closest phone shop", "stores in my area"]) {
      expect(isNearText(t), t).toBe(true);
    }
    for (const t of ["find red shoes", "do you deliver to Ikeja?", "is it nearly ready", "who sells pepsi"]) {
      expect(isNearText(t), t).toBe(false);
    }
    expect(nearQueryOf("who sells pepsi near me?")).toBe("pepsi");
    expect(nearQueryOf("shops near me")).toBe("");
    expect(nearQueryOf("stores around me that sell phone chargers")).toBe("phone chargers");
    expect(nearQueryOf("rice near me")).toBe("rice");
  });
  it("says how far a shop is", async () => {
    const { formatKm } = await import("./services/sharedLobby");
    expect(formatKm(0.34)).toBe("350 m");
    expect(formatKm(0.01)).toBe("50 m");
    expect(formatKm(2.46)).toBe("2.5 km");
    expect(formatKm(18.2)).toBe("18 km");
  });
  it("reads a WhatsApp pin", async () => {
    const { pinFromMessage } = await import("./services/shopLocation");
    expect(pinFromMessage({ type: "location", location: { latitude: 6.5, longitude: 3.4, address: " 12 Allen Ave " } }))
      .toEqual({ latitude: 6.5, longitude: 3.4, name: null, address: "12 Allen Ave" });
    expect(pinFromMessage({ type: "location", location: { latitude: 120, longitude: 3.4 } })).toBeNull();
    expect(pinFromMessage({ type: "text", text: { body: "6.5,3.4" } })).toBeNull();
  });
});

describe("chat onboarding", () => {
  it("knows a business that wants to sell from a buyer", async () => {
    const { isSellText } = await import("./services/sharedLobby");
    for (const t of ["SELL", "/sell", "I want to sell", "I want to sell my products", "how do I sell here?", "open a shop",
      "register my business", "I want to open my own store", "become a vendor", "sell on Runit", "sell on runit technologies please"]) {
      expect(isSellText(t, "Runit Technologies"), t).toBe(true);
    }
    for (const t of ["who sells rice?", "do you sell pepsi", "sell on credit", "where can I buy shoes", "shops that sell chargers",
      "I want to buy", "selling price?"]) {
      expect(isSellText(t, "Runit Technologies"), t).toBe(false);
    }
  });
  it("turns onboarding replies into Telegram messages", async () => {
    const { telegramMessageFor } = await import("./services/telegramPlatformBot");
    expect(telegramMessageFor({ type: "text", text: { body: "hi" } })).toEqual({ text: "hi" });
    const card = telegramMessageFor({ type: "interactive", interactive: { type: "button", body: { text: "Approve the menu?" },
      action: { buttons: [{ type: "reply", reply: { id: "onb_approve:p1", title: "Approve" } }, { type: "reply", reply: { id: "onb_edit:p1", title: "Edit" } }] } } });
    expect(card?.replyMarkup).toEqual({ inline_keyboard: [[{ text: "Approve", callback_data: "onb_approve:p1" }], [{ text: "Edit", callback_data: "onb_edit:p1" }]] });
    const loc = telegramMessageFor({ type: "interactive", interactive: { type: "location_request_message", body: { text: "Where are you?" }, action: { name: "send_location" } } });
    expect((loc?.replyMarkup as any)?.keyboard?.[0]?.[0]?.request_location).toBe(true);
  });
});

describe("shared number: switching", () => {
  it("reads SWITCH and its plain phrasings, never a shop's own words", async () => {
    const { isSwitchText } = await import("./services/sharedLobby");
    for (const t of ["switch", "SWITCH", "change shop", "options", "exit setup", "home", "main menu", "where am I?"]) expect(isSwitchText(t)).toBe(true);
    for (const t of ["back", "menu", "start over", "leave shop", "switch on the light", "I want to change my order"]) expect(isSwitchText(t)).toBe(false);
  });

  it("tells buying from describing the business", async () => {
    const { isBuyText } = await import("./services/sharedLobby");
    for (const t of ["I want to buy 4 palm oil", "! want to buy 4 palm oil", "buy rice", "where can I get pepsi", "I need 2 crates"]) expect(isBuyText(t)).toBe(true);
    for (const t of ["I sell children toys", "order tracking please", "do you have delivery options?", "We deliver in Lagos"]) expect(isBuyText(t)).toBe(false);
  });

  it("the menu: back to the current shop first, recent shops, stores, search, then the setup", async () => {
    const { switchPayload } = await import("./services/sharedLobby");
    const shop = (id: string, name: string) => ({ id, code: id, name, categories: [], products: 3 }) as any;
    const p: any = switchPayload("Market", { current: shop("a", "Ada Fabrics"), recent: [shop("a", "Ada Fabrics"), shop("b", "Bayo Phones")], setupName: "Tanisty toys" });
    const rows = p.interactive.action.sections[0].rows;
    expect(rows.map((r: any) => r.title)).toEqual(["Back to Ada Fabrics", "Bayo Phones", "🛍️ All stores", "🔎 Search", "🏪 My shop setup"]);
    expect(rows.at(-1).description).toBe("Carry on setting up Tanisty toys");
    expect(rows.every((r: any) => r.title.length <= 24 && r.description.length <= 72)).toBe(true);
    const none: any = switchPayload("Market", { current: null, recent: [], setupName: null });
    expect(none.interactive.action.sections[0].rows.at(-1).title).toBe("🏪 Sell here");
  });
});
