import { describe, expect, it } from "vitest";
import { isSellIntent } from "./services/platformNumber";

describe("shared number: a business owner asking to set up a shop", () => {
  it("recognises what people actually sent (2026-10/11)", () => {
    for (const t of ["I want to create a store", "Create Shop", "Ok create shop", "How do I create a shop", "SELL", "sell",
      "I want to sell", "I'd like to open a shop", "register my business", "how can I set up my store", "become a vendor",
      "I want to start selling", "open my boutique", "can I list my business here?"]) {
      expect(isSellIntent(t), t).toBe(true);
    }
  });
  it("leaves buyers alone", () => {
    for (const t of ["start shopping", "show me stores", "which shop has milo", "add to cart", "Perfume", "home", "hi",
      "Which available item is around me", "shop", "Akoka Mega Mart", "do you sell rice", "who sells perfume near me", ""]) {
      expect(isSellIntent(t), t).toBe(false);
    }
  });
});
