/**
 * QA follow-up: storage keys are built from user-influenced segments (e.g. a
 * merchant-chosen product class name in productImages.ts). normalizeStorageKey
 * rejects traversal-shaped keys for every storagePut/Get/Delete/Serve caller
 * instead of relying on each caller (and the object store) to be careful.
 */
import { describe, it, expect } from "vitest";
import { normalizeStorageKey } from "./storage";

describe("normalizeStorageKey", () => {
  it("strips leading slashes and keeps ordinary nested keys intact", () => {
    expect(normalizeStorageKey("/uc-docs/tenant-1/statement.pdf")).toBe("uc-docs/tenant-1/statement.pdf");
    expect(normalizeStorageKey("product-images/coca_cola/171-abc.jpg")).toBe("product-images/coca_cola/171-abc.jpg");
  });

  it.each([
    "../secrets/x",
    "product-images/../../etc/passwd",
    "a/./b",
    "a/..",
    "..",
    "a\\..\\b",
    "a\0b",
    "",
    "///",
  ])("rejects %j", (bad) => {
    expect(() => normalizeStorageKey(bad)).toThrow(/invalid storage key/);
  });

  it("leaves a lone backslash in an ordinary filename alone (not traversal on an object store)", () => {
    expect(normalizeStorageKey("whatsapp-media/t1/id-C:\\fakepath\\photo.png")).toBe("whatsapp-media/t1/id-C:\\fakepath\\photo.png");
  });

  it("does not reject names that merely contain dots", () => {
    expect(normalizeStorageKey("evidence/d1/uuid-my..file.name.png")).toBe("evidence/d1/uuid-my..file.name.png");
  });
});
