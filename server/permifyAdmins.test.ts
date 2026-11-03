import { describe, expect, it } from "vitest";
import { adminChanges, PERMIFY_SCHEMA } from "./services/permifyAdmins";

describe("adminChanges", () => {
  it("adds new admins and removes former ones", () => {
    expect(adminChanges(["1", "2"], ["2", "3"])).toEqual({ add: ["3"], remove: ["1"] });
  });
  it("changes nothing when they already match", () => {
    expect(adminChanges(["1"], ["1"])).toEqual({ add: [], remove: [] });
  });
});

describe("PERMIFY_SCHEMA", () => {
  it("defines the one permission adminProcedure asks about", () => {
    expect(PERMIFY_SCHEMA).toContain("entity system");
    expect(PERMIFY_SCHEMA).toContain("permission manage = admin");
  });
});
