/**
 * QA-020: startLogin() must hand the login to the SERVER (/api/auth/login), never build a Keycloak URL in the browser.
 * A client-built authorization URL is what /api/auth/callback now refuses (it carries no signed transaction cookie), so
 * a regression here would break login for everyone — and one that "fixed" it by re-adding a client-built URL would
 * reopen login CSRF. Both are pinned.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { startLogin } from "./const";

function browserAt(pathname: string, search = "") {
  const assign = vi.fn();
  const doc = { cookie: "" };
  const session = { setItem: vi.fn(), getItem: vi.fn() };
  vi.stubGlobal("window", { location: { pathname, search, assign, href: "unchanged" } });
  vi.stubGlobal("document", doc);
  vi.stubGlobal("sessionStorage", session);
  return { assign, doc, session, href: () => (globalThis as any).window.location.href as string };
}

afterEach(() => vi.unstubAllGlobals());

describe("startLogin", () => {
  it.each([
    ["/", "", "/api/auth/login?redirect=%2F"],
    ["/dashboard", "", "/api/auth/login?redirect=%2Fdashboard"],
    ["/tenant-portal/orders", "?tab=open&page=2", "/api/auth/login?redirect=%2Ftenant-portal%2Forders%3Ftab%3Dopen%26page%3D2"],
    ["/platform-admin/", "", "/api/auth/login?redirect=%2Fplatform-admin%2F"],
  ])("from %s%s it navigates to the server-driven login with the return path", (pathname, search, expected) => {
    const b = browserAt(pathname, search);
    startLogin();
    expect(b.assign).toHaveBeenCalledTimes(1);
    expect(b.assign).toHaveBeenCalledWith(expected);
  });

  it("navigates to a same-origin RELATIVE url — never to Keycloak, and never with a client-built state/nonce/challenge", () => {
    const b = browserAt("/x");
    startLogin();
    const url = String(b.assign.mock.calls[0][0]);
    expect(url.startsWith("/api/auth/login?")).toBe(true);
    for (const forbidden of ["openid-connect", "http", "state=", "nonce=", "code_challenge", "client_id"]) expect(url, forbidden).not.toContain(forbidden);
  });

  it("does not park a fake 'PKCE verifier' or a __Host- state cookie in the browser any more (they protected nothing)", () => {
    const b = browserAt("/x");
    startLogin();
    expect(b.session.setItem).not.toHaveBeenCalled();
    expect(b.doc.cookie).toBe("");
  });

  it("encodes the return path so it cannot smuggle extra query parameters into the login URL", () => {
    const b = browserAt("/a", "?x=1&redirect=https://evil.example");
    startLogin();
    const url = new URL(String(b.assign.mock.calls[0][0]), "https://app.example");
    expect([...url.searchParams.keys()]).toEqual(["redirect"]);
    expect(url.searchParams.get("redirect")).toBe("/a?x=1&redirect=https://evil.example"); // one opaque value; the server sanitises it
  });
});
