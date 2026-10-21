import { describe, expect, it } from "vitest";
import { extractFactsFallback } from "./services/onboardingCopilot/agent";
import { proposalCardText } from "./services/onboardingCopilot/cardText";
import type { Proposal } from "./services/onboardingCopilot/session";

describe("onboarding: the business is read from the first message", () => {
  it("reads a labelled, multi-line first message (name, what they sell, where they are)", () => {
    const f = extractFactsFallback("name : Tanisty toys\nI sell children toys\nI’m currently based in AKOKA Lagos Nigeria", {});
    expect(f.businessName).toBe("Tanisty toys");
    expect(f.industry).toBe("children toys");
    expect(f.city).toBe("Lagos");
  });

  it.each(["Business name: Mama Put Kitchen", "Shop - Mama Put Kitchen", "My business is called Mama Put Kitchen"])("%s", (msg) => {
    expect(extractFactsFallback(msg, {}).businessName).toBe("Mama Put Kitchen");
  });

  it.each(["Hi", "hello!", "Good morning", "SELL", "ok", "thanks"])("a greeting or command is not a name: %s", (msg) => {
    expect(extractFactsFallback(msg, {}).businessName).toBeUndefined();
  });

  it("still takes a short first message as the name", () => {
    expect(extractFactsFallback("Kano Spice House", {}).businessName).toBe("Kano Spice House");
  });

  it("a city outside the known list, from 'based in'", () => {
    expect(extractFactsFallback("Tunde Prints, based in Abeokuta.", {}).city).toBe("Abeokuta");
  });
});

describe("onboarding: proposal cards read as text, not JSON", () => {
  const facts = { businessName: "Tanisty toys" };
  const card = (kind: Proposal["kind"], summary: string, payload: unknown): string =>
    proposalCardText({ id: "p1", kind, summary, payload, status: "pending" }, facts);

  it("menu: the greeting with the shop's name, and the options customers see", () => {
    const text = card("waMenu", "WhatsApp menu (template): greeting + top use cases", {
      greeting: "Welcome to {businessName}! How can we help you today?",
      useCases: [
        { id: "shop", label: "Shop products", enabled: true, order: 1 },
        { id: "track", label: "Track my order", enabled: true, order: 2 },
        { id: "booking", label: "Book", enabled: false, order: 3 },
      ],
    });
    expect(text).toContain("“Welcome to Tanisty toys! How can we help you today?”");
    expect(text).toContain("• Shop products\n• Track my order");
    expect(text).not.toContain("Book");
    expect(text).not.toMatch(/[{}"]\s*$|"useCases"|\{\s*\n/);
  });

  it("brand kit: colours and tagline, never the base64 logo", () => {
    const text = card("branding", "Brand kit", {
      primaryColor: "#9A9A42", secondaryColor: "#7485A4", tagline: "Quality you can count on",
      logoSvgDataUri: "data:image/svg+xml;base64,PHN2Zz4=",
    });
    expect(text).toContain("Colours: #9A9A42 and #7485A4");
    expect(text).toContain("Tagline: “Quality you can count on”");
    expect(text).not.toContain("base64");
  });

  it("integrations: what each is for, and that nothing is connected yet", () => {
    const text = card("integrations", "Suggested integrations", {
      providers: [{ provider: "twenty", reason: "CRM to track customer conversations and follow-ups" }],
    });
    expect(text).toContain("• Twenty (customer CRM) — CRM to track customer conversations and follow-ups");
    expect(text).toContain("Nothing is connected now");
  });

  it("use cases: labels, not ids", () => {
    const text = card("useCases", "What customers do first", { ranked: ["shop", "track", "support"] });
    expect(text).toContain("1. Shop products");
    expect(text).not.toContain('"ranked"');
  });
});
