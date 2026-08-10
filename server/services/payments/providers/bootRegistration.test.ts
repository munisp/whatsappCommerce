/**
 * bootRegistration.test.ts — wave-11 P2/P3 boot wiring:
 *  - registerAdapterPack() makes flutterwave/stripe/monnify resolve via the
 *    registry catalog (what the server boot call wires up)
 *  - idempotent (safe to call twice, matching the non-blocking boot call)
 *  - the "custom" adapter self-registers on import (settings catalog)
 */
import { describe, it, expect } from "vitest";
import { registerAdapterPack } from "./registerAll";
import { listProviderAdapters, getProviderAdapter } from "./registry";
import "./custom";

describe("registerAdapterPack boot wiring", () => {
  it("catalog includes flutterwave, stripe and monnify after registration", () => {
    registerAdapterPack();
    const ids = listProviderAdapters().map((a) => a.id);
    expect(ids).toContain("paystack");
    expect(ids).toContain("manual");
    expect(ids).toContain("flutterwave");
    expect(ids).toContain("stripe");
    expect(ids).toContain("monnify");
  });

  it("is idempotent — a second call does not throw or duplicate", () => {
    registerAdapterPack();
    const before = listProviderAdapters().length;
    registerAdapterPack();
    expect(listProviderAdapters().length).toBe(before);
  });

  it("registered adapters resolve by id via getProviderAdapter", () => {
    registerAdapterPack();
    for (const id of ["flutterwave", "stripe", "monnify"]) {
      expect(getProviderAdapter(id)?.displayName).toBeTruthy();
    }
  });

  it("custom gateway adapter self-registers for the settings catalog", () => {
    expect(listProviderAdapters().map((a) => a.id)).toContain("custom");
  });
});
