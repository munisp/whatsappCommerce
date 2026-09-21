/**
 * QA-039: the admin portal must not offer a way to hand-make TigerBeetle accounts. The button used to call an endpoint
 * that could only ever have created random-id, overdraft-unprotected, PERMANENT accounts in the shared ledger (and
 * never worked anyway). A regression that puts the button back would be silent — nothing else fails — so it is pinned.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(__dirname, "AdminPortal.tsx"), "utf8");

describe("AdminPortal Finance tab — TigerBeetle accounts card", () => {
  it("has no 'Provision' action and never references the provisioning mutation", () => {
    expect(src).not.toMatch(/provisionTbAccount/);
    expect(src).not.toMatch(/Provision Float Account/);
  });

  it("tells the operator why instead (accounts are created automatically on first use)", () => {
    expect(src).toContain('data-testid="tb-accounts-note"');
    expect(src).toMatch(/created automatically the first time a tenant transacts/);
  });

  it("still lists the accounts it knows about", () => {
    expect(src).toContain("trpc.infra.listTbAccounts.useQuery");
  });
});
