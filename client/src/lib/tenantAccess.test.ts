/** QA-043: the rules behind "which business am I looking at" and "what does the shell show me". Pure, so no rendering can fool them. */
import { describe, it, expect } from "vitest";
import {
  accountSubtitle, displayNameFor, initialFor, isAllowedWithoutBusiness, isPlatformAdmin, needsBusinessSetup, resolveActiveTenant, NO_BUSINESS_ALLOWED_PATHS,
} from "./tenantAccess";

const merchant = { role: "user", tenantId: "t-acme", name: "Ada", email: "ada@acme.example" };
const fresh = { role: "user", tenantId: null, name: "Chidi", email: "chidi@x.example" };
const admin = { role: "admin", tenantId: null, name: "Root", email: "root@x.example" };

describe("resolveActiveTenant — never a default", () => {
  it("a merchant always gets THEIR tenant, whatever is left over in storage", () => {
    expect(resolveActiveTenant(merchant, "tenant-001")).toBe("t-acme");
    expect(resolveActiveTenant(merchant, "someone-elses-tenant")).toBe("t-acme");
  });
  it("a newly registered user gets NO tenant — never the demo tenant that used to 403 every query", () => {
    expect(resolveActiveTenant(fresh, "tenant-001")).toBe("");
  });
  it("signed out: nothing may be asked yet", () => {
    expect(resolveActiveTenant(null, "tenant-001")).toBe("");
    expect(resolveActiveTenant(undefined, "tenant-001")).toBe("");
  });
  it("a platform admin gets the tenant they picked in the switcher", () => {
    expect(resolveActiveTenant(admin, "t-picked")).toBe("t-picked");
  });
  it("a role that merely LOOKS like admin is not admin", () => {
    for (const role of ["Admin", "administrator", "admin ", "superadmin", null, undefined, ""]) {
      expect(isPlatformAdmin({ role } as any), String(role)).toBe(false);
      expect(resolveActiveTenant({ role, tenantId: "t-1" } as any, "t-picked")).toBe("t-1");
    }
  });
});

describe("needsBusinessSetup", () => {
  it("is true for a signed-in non-admin with no tenant, and only for them", () => {
    expect(needsBusinessSetup(fresh)).toBe(true);
    expect(needsBusinessSetup(merchant)).toBe(false);
    expect(needsBusinessSetup(admin)).toBe(false); // admins are tenant-less by design
    expect(needsBusinessSetup(null)).toBe(false); // signed out is a different screen
  });
  it("treats an empty-string tenant like no tenant", () => {
    expect(needsBusinessSetup({ role: "user", tenantId: "" })).toBe(true);
  });
});

describe("isAllowedWithoutBusiness", () => {
  it.each([...NO_BUSINESS_ALLOWED_PATHS, "/onboarding-wizard/step-2", "/onboarding-wizard/", "/onboarding-wizard?from=email", "/onboarding-wizard#x"])("allows %s", (p) => {
    expect(isAllowedWithoutBusiness(p)).toBe(true);
  });
  it.each(["/", "/products", "/orders", "/onboarding-wizard-evil", "/onboarding-wizardx", "/onboarding", "/portal/setup", "/portal", "/admin", ""])("does NOT allow %j (needs a business, or is not the wizard)", (p) => {
    expect(isAllowedWithoutBusiness(p)).toBe(false);
  });
});

describe("what the sidebar calls the person", () => {
  it("their name when they have one", () => expect(displayNameFor(merchant)).toBe("Ada"));
  it("else the part of the email before the @ — never the word 'User', never an internal id", () => {
    expect(displayNameFor({ name: null, email: "ada.obi@acme.example" })).toBe("ada.obi");
    expect(displayNameFor({ name: "   ", email: "ada@acme.example" })).toBe("ada");
    expect(displayNameFor({ name: null, email: null })).toBe("Account");
    expect(displayNameFor(null)).toBe("Account");
  });
  it("initial is upper-case of the first letter of that", () => {
    expect(initialFor(merchant)).toBe("A");
    expect(initialFor({ name: null, email: "zed@x.example" })).toBe("Z");
    expect(initialFor(null)).toBe("A");
  });
  it("the third line says who they are: platform admin / no business yet / their business / a fallback", () => {
    expect(accountSubtitle(admin, null)).toBe("Platform admin");
    expect(accountSubtitle(fresh, null)).toBe("No business yet");
    expect(accountSubtitle(merchant, "Acme Stores")).toBe("Acme Stores");
    expect(accountSubtitle(merchant, null)).toBe("Merchant");
    expect(accountSubtitle(merchant, "   ")).toBe("Merchant");
    expect(accountSubtitle(null, "x")).toBe("");
  });
});
