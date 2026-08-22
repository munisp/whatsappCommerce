/**
 * W28 odoo-sync — WhatsApp ODOO command parsing + admin-phone resolution
 * (pure parts; the db-backed handler runs end-to-end in journeys).
 */
import { describe, it, expect } from "vitest";
import { parseOdooCommand, resolveAdminPhone } from "./odooWhatsApp";

describe("parseOdooCommand", () => {
  it("parses bare ODOO / ODOO STATUS as status", () => {
    expect(parseOdooCommand("odoo")).toEqual({ cmd: "status" });
    expect(parseOdooCommand("ODOO STATUS")).toEqual({ cmd: "status" });
    expect(parseOdooCommand("  odoo   status  ")).toEqual({ cmd: "status" });
  });
  it("parses ODOO SYNC / ODOO SYNC NOW as sync", () => {
    expect(parseOdooCommand("odoo sync")).toEqual({ cmd: "sync" });
    expect(parseOdooCommand("ODOO SYNC NOW")).toEqual({ cmd: "sync" });
    expect(parseOdooCommand("odoo sync   now")).toEqual({ cmd: "sync" });
  });
  it("ignores non-odoo text and lookalikes", () => {
    expect(parseOdooCommand("hello")).toBeNull();
    expect(parseOdooCommand("odyssey")).toBeNull();
    expect(parseOdooCommand("ODOOFOO")).toBeNull();
    expect(parseOdooCommand("odoo explode")).toBeNull();
  });
});

describe("resolveAdminPhone", () => {
  it("follows the chatDispute resolution chain", () => {
    expect(resolveAdminPhone({ adminPhone: "2348000000001" })).toBe("2348000000001");
    expect(resolveAdminPhone({ whatsapp: { adminPhone: "2348000000002" } })).toBe("2348000000002");
    expect(resolveAdminPhone({ notifications: { adminPhone: "2348000000003" } })).toBe("2348000000003");
    expect(resolveAdminPhone({})).toBeNull();
    expect(resolveAdminPhone(null)).toBeNull();
  });
});
