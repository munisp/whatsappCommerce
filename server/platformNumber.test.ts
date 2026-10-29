/**
 * W50 platformNumber pure-predicate tests: config gating + home-command +
 * ref normalization. resolveShopRef (DB) is covered by the sim journey.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  isGreeting,
  isHomeCommand,
  isPlatformNumber,
  normalizeShopRef,
  resolvePlatformWaCredentials,
} from "./services/platformNumber";

const PNID = process.env.WHATSAPP_PLATFORM_NUMBER_ID;
const TOK = process.env.WHATSAPP_PLATFORM_TOKEN;
afterEach(() => {
  if (PNID === undefined) delete process.env.WHATSAPP_PLATFORM_NUMBER_ID;
  else process.env.WHATSAPP_PLATFORM_NUMBER_ID = PNID;
  if (TOK === undefined) delete process.env.WHATSAPP_PLATFORM_TOKEN;
  else process.env.WHATSAPP_PLATFORM_TOKEN = TOK;
});

describe("isPlatformNumber (inert unless configured)", () => {
  it("is false for every number when WHATSAPP_PLATFORM_NUMBER_ID is unset", () => {
    delete process.env.WHATSAPP_PLATFORM_NUMBER_ID;
    expect(isPlatformNumber("pn_123")).toBe(false);
    expect(isPlatformNumber("")).toBe(false);
    expect(isPlatformNumber(null)).toBe(false);
  });
  it("matches only the configured id", () => {
    process.env.WHATSAPP_PLATFORM_NUMBER_ID = "pn_platform";
    expect(isPlatformNumber("pn_platform")).toBe(true);
    expect(isPlatformNumber(" pn_platform ")).toBe(true);
    expect(isPlatformNumber("pn_other")).toBe(false);
    expect(isPlatformNumber(null)).toBe(false);
  });
});

describe("resolvePlatformWaCredentials", () => {
  it("is null unless BOTH id and token are set", () => {
    delete process.env.WHATSAPP_PLATFORM_NUMBER_ID;
    delete process.env.WHATSAPP_PLATFORM_TOKEN;
    expect(resolvePlatformWaCredentials()).toBeNull();
    process.env.WHATSAPP_PLATFORM_NUMBER_ID = "pn_platform";
    expect(resolvePlatformWaCredentials()).toBeNull(); // token still missing
    process.env.WHATSAPP_PLATFORM_TOKEN = "tok";
    expect(resolvePlatformWaCredentials()).toEqual({ phoneNumberId: "pn_platform", accessToken: "tok" });
  });
});

describe("isHomeCommand", () => {
  it("recognizes the return-to-directory words, case/space-insensitive", () => {
    for (const w of ["home", "Shops", " back ", "EXIT", "menu", "start"]) {
      expect(isHomeCommand(w)).toBe(true);
    }
  });
  it("is false for a shop name or product query", () => {
    expect(isHomeCommand("meridian")).toBe(false);
    expect(isHomeCommand("toothpaste")).toBe(false);
    expect(isHomeCommand("")).toBe(false);
    expect(isHomeCommand(null)).toBe(false);
  });
});

describe("normalizeShopRef", () => {
  it("trims + lowercases", () => {
    expect(normalizeShopRef("  Meridian ")).toBe("meridian");
    expect(normalizeShopRef(null)).toBe("");
  });
});

describe("isGreeting (gets the directory prompt, not a product search)", () => {
  it("is true for greetings / noise", () => {
    for (const w of ["hi", "Hello", "hey", "hello there", "Good morning", "ok", "thanks"]) {
      expect(isGreeting(w)).toBe(true);
    }
  });
  it("is false for a real product search", () => {
    expect(isGreeting("toothpaste")).toBe(false);
    expect(isGreeting("phone charger")).toBe(false);
    expect(isGreeting("")).toBe(false);
    expect(isGreeting(null)).toBe(false);
  });
});
