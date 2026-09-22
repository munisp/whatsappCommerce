/**
 * QA-043: what a login is allowed to write to an existing user. The bug: `upsertUser` stored `null` over a user's name and
 * email whenever a later login carried none, so a registered person's details could vanish from the sidebar after any
 * subsequent sign-in. (The old body is pinned by the "absent information does not erase" cases below.)
 */
import { describe, it, expect } from "vitest";
import { buildUserUpsert } from "./db";

const NOW = new Date("2026-09-22T10:00:00Z");
const up = (u: Parameters<typeof buildUserUpsert>[0], owner = "") => buildUserUpsert(u, owner, NOW);

describe("buildUserUpsert", () => {
  it("a first login records everything it was given", () => {
    const { values, updateSet } = up({ openId: "kc-1", name: "Ada Obi", email: "ada@x.com", loginMethod: "keycloak" });
    expect(values).toMatchObject({ openId: "kc-1", name: "Ada Obi", email: "ada@x.com", loginMethod: "keycloak" });
    expect(updateSet).toMatchObject({ name: "Ada Obi", email: "ada@x.com" });
  });

  it("a later login that carries NO name or email does not erase the stored ones", () => {
    const { values, updateSet } = up({ openId: "kc-1", name: null, email: null, loginMethod: "keycloak" });
    expect(updateSet).not.toHaveProperty("name");
    expect(updateSet).not.toHaveProperty("email");
    expect(values.name).toBeNull(); // a brand-new row still records that it had none
  });

  it.each(["", "   ", "\n"])("an empty/whitespace value (%j) is 'no information', not a request to clear", (blank) => {
    const { updateSet } = up({ openId: "kc-1", name: blank, email: blank });
    expect(updateSet).not.toHaveProperty("name");
    expect(updateSet).not.toHaveProperty("email");
  });

  it("real new information DOES update (a person renaming themselves in the identity provider)", () => {
    expect(up({ openId: "kc-1", name: "Ada O. Obi" }).updateSet).toMatchObject({ name: "Ada O. Obi" });
  });

  it("undefined leaves a field alone entirely", () => {
    const { values, updateSet } = up({ openId: "kc-1" });
    expect(values).not.toHaveProperty("name");
    expect(updateSet).not.toHaveProperty("name");
  });

  it("always records the sign-in time, even when nothing else changed", () => {
    const { updateSet } = up({ openId: "kc-1", name: null, email: null });
    expect(updateSet).toEqual({ lastSignedIn: NOW });
  });

  it("never touches the role on an ordinary login (a login must not promote or demote anyone)", () => {
    expect(up({ openId: "kc-1", name: "A" }).updateSet).not.toHaveProperty("role");
  });

  it("makes the configured owner an admin, and only the owner", () => {
    expect(up({ openId: "owner-sub", name: "O" }, "owner-sub").updateSet).toMatchObject({ role: "admin" });
    expect(up({ openId: "someone-else", name: "O" }, "owner-sub").updateSet).not.toHaveProperty("role");
  });

  it("an unset owner id matches nobody (an empty OWNER_OPEN_ID must not promote an account with an empty openId)", () => {
    expect(() => up({ openId: "" } as any, "")).toThrow(/openId is required/);
  });

  it("an explicit role is honoured", () => {
    expect(up({ openId: "kc-1", role: "admin" }).updateSet).toMatchObject({ role: "admin" });
  });
});
