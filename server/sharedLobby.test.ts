import { describe, expect, it } from "vitest";
import {
  directoryPayload, isLeaveShopText, parseLobbyText, searchPayload, searchQueryOf, shopRow, welcomePayload,
  type DirectoryShop,
} from "./services/sharedLobby";

const shop = (i: number, extra: Partial<DirectoryShop> = {}): DirectoryShop =>
  ({ id: `t${i}`, name: `Shop number ${i}`, code: `shop${i}`, products: i, categories: ["Food"], ...extra });

describe("shared lobby: reading what the buyer typed", () => {
  it("greets on hellos, menu and help", () => {
    for (const t of ["hi", "Hello!", "hey", "Good morning", "menu", "help", "  hiii  "]) {
      expect(parseLobbyText(t)).toEqual({ kind: "greet" });
    }
  });

  it("browses on the ways people ask for the stores", () => {
    for (const t of ["stores", "Shops", "show me the shops", "list all stores", "what stores do you have?",
      "which shops are available", "browse", "see all", "all shops"]) {
      expect(parseLobbyText(t)).toEqual({ kind: "browse" });
    }
  });

  it("knows 'my shops' from 'stores'", () => {
    expect(parseLobbyText("my shops")).toEqual({ kind: "mine" });
    expect(parseLobbyText("switch")).toEqual({ kind: "mine" });
  });

  it("finds the search words in natural requests", () => {
    expect(parseLobbyText("find red sneakers")).toEqual({ kind: "search", query: "red sneakers" });
    expect(parseLobbyText("I'm looking for some rice")).toEqual({ kind: "search", query: "rice" });
    expect(parseLobbyText("who sells phones?")).toEqual({ kind: "search", query: "phones" });
    expect(parseLobbyText("shops that sell ankara fabric")).toEqual({ kind: "search", query: "ankara fabric" });
    expect(parseLobbyText("which stores sell rice")).toEqual({ kind: "search", query: "rice" });
    expect(parseLobbyText("do you have a phone charger")).toEqual({ kind: "search", query: "phone charger" });
  });

  it("leaves everything else to the next steps", () => {
    expect(parseLobbyText("lagos fresh market")).toBeNull();
    expect(parseLobbyText("jollof")).toBeNull();
    expect(searchQueryOf("  the some  rice. ")).toBe("rice");
  });

  it("inside a shop, only the explicit phrasings leave it", () => {
    for (const t of ["stores", "other shops", "leave shop", "Back to stores", "exit", "switch shop"]) {
      expect(isLeaveShopText(t)).toBe(true);
    }
    for (const t of ["find red shoes", "hi", "menu", "I want rice", "show me shoes"]) {
      expect(isLeaveShopText(t)).toBe(false);
    }
  });
});

describe("shared lobby: replies fit WhatsApp's limits", () => {
  it("rows fit 24/72 characters and say what the shop sells", () => {
    const r = shopRow(shop(1, { name: "A very long shop name that will not fit", categories: ["Fashion", "Shoes", "Bags"] }));
    expect(r.title.length).toBeLessThanOrEqual(24);
    expect(r.description).toBe("Fashion · Shoes · Bags");
    expect(r.id).toBe("shared_pick:shop1");
    expect(shopRow(shop(2, { matches: ["Jollof rice", "Rice 5kg"] })).description).toBe("Jollof rice, Rice 5kg");
    expect(shopRow(shop(3, { categories: [] })).description).toBe("3 products");
  });

  it("the welcome has two buttons, three once the buyer has visited a shop, titles within 20", () => {
    const two: any = welcomePayload("Runit", { visited: false });
    const three: any = welcomePayload("Runit", { visited: true });
    expect(two.interactive.action.buttons).toHaveLength(2);
    expect(three.interactive.action.buttons).toHaveLength(3);
    for (const b of three.interactive.action.buttons) expect(b.reply.title.length).toBeLessThanOrEqual(20);
  });

  it("the directory never passes 10 rows, puts recent shops first once, and pages on", () => {
    const recent = [shop(1), shop(2)];
    const page = [shop(1), shop(3), shop(4), shop(5), shop(6), shop(7), shop(8)]; // 9 - 2 recent = 7
    const p: any = directoryPayload("Runit", page, 25, 0, recent);
    const rows = p.interactive.action.sections.flatMap((s: any) => s.rows);
    expect(rows.length).toBeLessThanOrEqual(10);
    expect(p.interactive.action.sections[0].title).toBe("Recently visited");
    expect(rows.filter((r: any) => r.id === "shared_pick:shop1")).toHaveLength(1);
    expect(rows[rows.length - 1].id).toBe("shared_more:7");
    expect(new Set(rows.map((r: any) => r.id)).size).toBe(rows.length);
  });

  it("the last page has no 'more', and an empty directory gives nothing to send", () => {
    const p: any = directoryPayload("Runit", [shop(10), shop(11)], 11, 9);
    const rows = p.interactive.action.sections.flatMap((s: any) => s.rows);
    expect(rows.some((r: any) => r.id.startsWith("shared_more:"))).toBe(false);
    expect(directoryPayload("Runit", [], 0, 0)).toBeNull();
  });

  it("a search with no shops offers browse and search again", () => {
    const p: any = searchPayload("unicorn saddles", []);
    expect(p.interactive.type).toBe("button");
    expect(p.interactive.action.buttons.map((b: any) => b.reply.id)).toEqual(["lobby:browse", "lobby:search"]);
    const q: any = searchPayload("rice", [shop(1, { matches: ["Rice 5kg"] })]);
    expect(q.interactive.type).toBe("list");
  });
});
