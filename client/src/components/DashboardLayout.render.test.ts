/**
 * QA-043: what the shell actually SHOWS each kind of user — rendered for real (react-dom/server) with only the data hooks
 * mocked, so this exercises the real DashboardLayout, sidebar, nav filtering and set-up gate rather than reading its source.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

const state: { user: any; loading: boolean; path: string; tenantName: string | null } = { user: null, loading: false, path: "/orders", tenantName: null };

vi.mock("@/_core/hooks/useAuth", () => ({ useAuth: () => ({ user: state.user, loading: state.loading, logout: vi.fn() }) }));
vi.mock("@/lib/trpc", () => ({ trpc: { tenant: { myTenant: { useQuery: () => ({ data: state.tenantName ? { name: state.tenantName, logoUrl: null, primaryColor: null } : { name: null, logoUrl: null, primaryColor: null } }) } } } }));
vi.mock("wouter", () => ({ useLocation: () => [state.path, vi.fn()], Link: ({ children }: any) => children }));
vi.mock("@/hooks/useMobile", () => ({ useIsMobile: () => false }));
vi.mock("./NotificationCenter", () => ({ default: () => null }));
vi.mock("@/const", () => ({ startLogin: vi.fn() }));

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) });
  vi.stubGlobal("document", { cookie: "" });
  state.user = null; state.loading = false; state.path = "/orders"; state.tenantName = null;
});

// Nav groups are collapsible and only the active one starts expanded, so a link in a collapsed group is absent from the
// markup for EVERYONE. Expand them all (the layout reads this very key), so "absent" below really means "not offered".
const GROUP_IDS = [...readFileSync(join(__dirname, "DashboardLayout.tsx"), "utf8").matchAll(/\bid:\s*"([a-z0-9-]+)",\s*\n\s*label:/g)].map((m) => m[1]);
function expandAllGroups() {
  localStorage.setItem("nav-expanded-groups", JSON.stringify(Object.fromEntries(GROUP_IDS.map((id) => [id, true]))));
}

async function render(): Promise<string> {
  expandAllGroups();
  const { default: DashboardLayout } = await import("./DashboardLayout");
  return renderToStaticMarkup(React.createElement(DashboardLayout, null, React.createElement("div", { "data-testid": "the-page" }, "PAGE-CONTENT")));
}
const merchant = { id: 2, role: "user", tenantId: "t-acme", name: "Ada Obi", email: "ada@acme.example" };

describe("test harness", () => {
  it("found the nav groups it expands (else 'absent' assertions would be vacuous)", () => {
    expect(GROUP_IDS.length).toBeGreaterThan(5);
    expect(GROUP_IDS).toContain("overview");
  });
});

describe("DashboardLayout — signed out", () => {
  it("asks to sign in, with no sidebar and no page", async () => {
    const html = await render();
    expect(html).toContain("Sign in to continue");
    expect(html).not.toContain("PAGE-CONTENT");
    expect(html).not.toContain("sidebar-account");
  });
});

describe("DashboardLayout — a freshly REGISTERED user (signed in, no business yet)", () => {
  beforeEach(() => { state.user = { id: 9, role: "user", tenantId: null, name: "Chidi Eze", email: "chidi@x.example" }; });

  it("gets the set-up screen INSIDE the shell instead of a tenant page that can only 403", async () => {
    state.path = "/products";
    const html = await render();
    expect(html).toContain('data-testid="no-business-yet"');
    expect(html).toContain("Welcome, Chidi Eze");
    expect(html).not.toContain("PAGE-CONTENT");
  });

  it("sees their own details in the sidebar: name, email, and that they have no business yet", async () => {
    const html = await render();
    expect(html).toMatch(/data-testid="sidebar-account-name"[^>]*>Chidi Eze</);
    expect(html).toMatch(/data-testid="sidebar-account-email"[^>]*>chidi@x\.example</);
    expect(html).toMatch(/data-testid="sidebar-account-subtitle"[^>]*>\s*No business yet\s*</);
  });

  it("the sidebar offers the one thing they can do — and none of the tenant pages that would 403", async () => {
    const html = await render();
    expect(html).toContain("Set up your business");
    for (const tenantOnly of ["Products", "Orders", "Conversations", "Payments", "Invoices"]) expect(html, tenantOnly).not.toContain(`>${tenantOnly}<`);
  });

  it("the wizard that CREATES a business renders normally", async () => {
    const path = "/onboarding-wizard";
    state.path = path;
    const html = await render();
    expect(html).toContain("PAGE-CONTENT");
    expect(html).not.toContain('data-testid="no-business-yet"');
  });

  it.each(["/onboarding", "/portal/setup"])("pages that need an existing business (%s) get the set-up screen, not a page that 403s", async (path) => {
    state.path = path;
    expect(await render()).toContain('data-testid="no-business-yet"');
  });

  it("a look-alike path is not an onboarding path", async () => {
    state.path = "/onboarding-wizard-evil";
    expect(await render()).toContain('data-testid="no-business-yet"');
  });
});

describe("DashboardLayout — a merchant (has a business)", () => {
  beforeEach(() => { state.user = merchant; state.tenantName = "Acme Stores"; });

  it("sees the page and their business name in the account block", async () => {
    const html = await render();
    expect(html).toContain("PAGE-CONTENT");
    expect(html).not.toContain('data-testid="no-business-yet"');
    expect(html).toMatch(/data-testid="sidebar-account-subtitle"[^>]*>\s*Acme Stores\s*</);
  });

  it("is NOT offered the links only admins can use (each would be a 403): Escrow and Revenue", async () => {
    const html = await render();
    expect(html).not.toContain(">Escrow<");
    expect(html).not.toContain(">Revenue<");
    expect(html).toContain(">Orders<");
    expect(html).toContain(">Products<");
  });

  it("falls back to the email's local part — never the word 'User' — when the identity provider gave no name", async () => {
    state.user = { ...merchant, name: null };
    const html = await render();
    expect(html).toMatch(/data-testid="sidebar-account-name"[^>]*>ada</);
    expect(html).not.toMatch(/sidebar-account-name"[^>]*>User</);
  });
});

describe("DashboardLayout — a platform admin", () => {
  it("is offered Escrow and Revenue, and is labelled as the platform admin", async () => {
    state.user = { id: 1, role: "admin", tenantId: null, name: "Root", email: "root@x.example" };
    const html = await render();
    expect(html).toContain(">Escrow<");
    expect(html).toContain(">Revenue<");
    expect(html).toMatch(/data-testid="sidebar-account-subtitle"[^>]*>\s*Platform admin\s*</);
  });

  it("is never gated by the no-business screen (admins are tenant-agnostic by design)", async () => {
    state.user = { id: 1, role: "admin", tenantId: null, name: "Root", email: "root@x.example" };
    state.path = "/products";
    const html = await render();
    expect(html).toContain("PAGE-CONTENT");
    expect(html).not.toContain('data-testid="no-business-yet"');
  });
});
