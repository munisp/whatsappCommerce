/**
 * Pages a signed-in person with NO business yet must be able to use (tenantAccess NO_BUSINESS_ALLOWED_PATHS) must
 * never put up an Owner/Operator wall: nobody holds a shop role before their shop exists. "Set up shop" did exactly
 * that from 2026-09-24 to 2026-11-09 and turned every new merchant away with "Access Restricted".
 *
 * Each allowed path is resolved to its page through App.tsx's own routes (so a page added to the list later is checked
 * too), then rendered for real (react-dom/server) with only data hooks mocked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { NO_BUSINESS_ALLOWED_PATHS } from "@/lib/tenantAccess";
import { ALWAYS_ON_FEATURES, featureVisible } from "@shared/featureRollout";

const state: { user: any; loading: boolean; role: string | null } = { user: null, loading: false, role: null };

// Any tRPC hook answers "nothing yet": no data, not loading, no error. Enough for a page to render its first frame.
const hookResult = () => ({ data: undefined, isLoading: false, isFetching: false, isError: false, error: null, refetch: vi.fn(), mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false, isSuccess: false, reset: vi.fn() });
const proxy: any = new Proxy(function () {}, {
  get: (_t, key: string) => {
    if (key === "membership") return { myRole: { useQuery: () => ({ ...hookResult(), data: { role: state.role } }) } };
    if (["useQuery", "useMutation", "useInfiniteQuery", "useSuspenseQuery"].includes(key)) return hookResult;
    if (key === "useUtils" || key === "useContext") return () => proxy;
    if (key === "then") return undefined;
    return proxy;
  },
  apply: () => proxy,
});
vi.mock("@/lib/trpc", () => ({ trpc: proxy }));
vi.mock("@/_core/hooks/useAuth", () => ({ useAuth: () => ({ user: state.user, loading: state.loading, refresh: vi.fn(), logout: vi.fn(), isAuthenticated: Boolean(state.user) }) }));
vi.mock("@/contexts/TenantContext", () => ({ useActiveTenant: () => ({ activeTenantId: "", setActiveTenantId: vi.fn() }) }));
vi.mock("wouter", () => ({ useLocation: () => ["/onboarding-wizard", vi.fn()], useSearch: () => "", Link: ({ children }: any) => children }));
// The shell has its own tests (DashboardLayout.render.test.ts); here only the page's own gate matters.
vi.mock("@/components/DashboardLayout", () => ({ default: ({ children }: any) => React.createElement("main", null, children) }));

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) });
  state.user = null; state.loading = false; state.role = null;
});

// path -> page module, read from App.tsx: <Route path="/x" component={Name} /> and const Name = lazy(() => import("./pages/File")).
const APP = readFileSync(join(__dirname, "..", "App.tsx"), "utf8");
function pageModuleFor(path: string): string {
  const route = APP.match(new RegExp(`<Route\\s+path="${path.replace(/[/-]/g, (c) => "\\" + c)}"\\s+component=\\{(\\w+)\\}`));
  if (!route) throw new Error(`App.tsx has no route for ${path}`);
  const lazyImport = APP.match(new RegExp(`const ${route[1]} = lazy\\(\\(\\) => import\\("\\./([^"]+)"\\)`));
  if (!lazyImport) throw new Error(`App.tsx has no lazy import for ${route[1]}`);
  return lazyImport[1];
}

async function renderPage(path: string) {
  const mod = await import(/* @vite-ignore */ "../" + pageModuleFor(path));
  return renderToStaticMarkup(React.createElement(mod.default));
}

const newMerchant = { id: 99, role: "user", tenantId: null, name: "New Merchant", email: "new@example.com" };

describe("pages for people with no business yet", () => {
  it("the list isn't empty (else the checks below would prove nothing)", () => {
    expect(NO_BUSINESS_ALLOWED_PATHS.length).toBeGreaterThan(0);
  });

  it.each([...NO_BUSINESS_ALLOWED_PATHS])("%s opens for a signed-in user with no business and no shop role", async (path) => {
    state.user = newMerchant; state.role = null;
    const html = await renderPage(path);
    expect(html).not.toContain("Access Restricted");
    expect(html).not.toMatch(/This page requires/);
    expect(html.length).toBeGreaterThan(200); // the page itself rendered, not just a spinner
  });
});

describe("pages that create a business stay reachable once it exists", () => {
  // The other half of the same dead end: on 2026-11-03 every shop feature was switched off in rollout, Set up shop
  // included, so a new merchant was thrown out of it the moment their shop was created, before WhatsApp, verification
  // (KYB) or go-live. A rollout switch must never be able to do that again.
  it.each([...NO_BUSINESS_ALLOWED_PATHS])("%s can't be hidden by feature rollout", (path) => {
    expect(ALWAYS_ON_FEATURES).toContain(path);
    expect(featureVisible(path, "off", false)).toBe(true);
    expect(featureVisible(path, "selected", null)).toBe(true);
  });
});

describe("Set up shop still protects existing businesses", () => {
  it("someone in a business without an Owner or Operator role is turned away", async () => {
    state.user = { ...newMerchant, tenantId: "t-acme" }; state.role = "analyst";
    expect(await renderPage("/onboarding-wizard")).toContain("Access Restricted");
  });

  it("an Owner of a business gets in", async () => {
    state.user = { ...newMerchant, tenantId: "t-acme" }; state.role = "owner";
    expect(await renderPage("/onboarding-wizard")).not.toContain("Access Restricted");
  });

  it("a platform admin gets in (they configure businesses they manage)", async () => {
    state.user = { ...newMerchant, role: "admin" }; state.role = null;
    expect(await renderPage("/onboarding-wizard")).not.toContain("Access Restricted");
  });
});
