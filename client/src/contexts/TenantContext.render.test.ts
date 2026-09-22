/**
 * QA-043: the tenant context under a REAL provider. The bugs it pins: pages got "tenant-001" (the context default) — from a missing
 * provider in ui/tenant-portal, from a stale localStorage value left by another account, and from the first render before an
 * effect corrected it — and the server refused every one with a 403.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const auth: { user: any } = { user: null };
vi.mock("@/_core/hooks/useAuth", () => ({ useAuth: () => ({ user: auth.user, loading: false }) }));

const store = new Map<string, string>();
beforeEach(() => {
  store.clear(); auth.user = null;
  vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) });
});

async function seenByPage(withProvider = true): Promise<string> {
  const { TenantProvider, useActiveTenant } = await import("./TenantContext");
  const Probe = () => React.createElement("span", { id: "t" }, JSON.stringify(useActiveTenant().activeTenantId));
  const tree = withProvider ? React.createElement(TenantProvider, null, React.createElement(Probe)) : React.createElement(Probe);
  return /<span id="t">(.*?)<\/span>/.exec(renderToStaticMarkup(tree))![1].replace(/&quot;/g, '"');
}

describe("TenantProvider", () => {
  it("gives a merchant their own tenant on the VERY FIRST render — not a default that an effect fixes later", async () => {
    auth.user = { role: "user", tenantId: "t-acme" };
    expect(await seenByPage()).toBe('"t-acme"');
  });

  it("ignores a stale selection left in localStorage by another account on the same browser", async () => {
    store.set("active-tenant-id", "t-somebody-else");
    auth.user = { role: "user", tenantId: "t-acme" };
    expect(await seenByPage()).toBe('"t-acme"');
  });

  it("gives a newly registered user (no tenant) NO tenant — pages must not fire queries for the demo tenant", async () => {
    auth.user = { role: "user", tenantId: null };
    expect(await seenByPage()).toBe('""');
  });

  it("gives a signed-out visitor no tenant", async () => {
    expect(await seenByPage()).toBe('""');
  });

  it("lets a platform admin's stored selection through, defaulting to the seeded demo tenant ONLY for admins", async () => {
    auth.user = { role: "admin", tenantId: null };
    expect(await seenByPage()).toBe('"tenant-001"');
    store.set("active-tenant-id", "t-picked");
    expect(await seenByPage()).toBe('"t-picked"');
  });

  it("with NO provider (how ui/tenant-portal used to run) the default is 'no tenant', not the demo tenant", async () => {
    auth.user = { role: "user", tenantId: "t-acme" };
    expect(await seenByPage(false)).toBe('""');
  });
});
