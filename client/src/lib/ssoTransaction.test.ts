/**
 * QA-039: the tenant-portal SSO login transaction. What is pinned here is the property the old code lacked — a callback
 * is only accepted if THIS tab started the login — plus the PKCE maths, checked against node's own SHA-256 so the test
 * does not just agree with the implementation about what "S256" means.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  beginSsoTransaction, consumeSsoTransaction, ssoFailureMessage, SSO_TX_KEY, SSO_TX_TTL_MS,
} from "./ssoTransaction";

function fakeSessionStorage() {
  const m = new Map<string, string>();
  return {
    m,
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

let store: ReturnType<typeof fakeSessionStorage>;
beforeEach(() => { store = fakeSessionStorage(); vi.stubGlobal("sessionStorage", store); });
afterEach(() => vi.unstubAllGlobals());

const sha256b64url = (s: string) => createHash("sha256").update(s).digest("base64url");
const stored = () => JSON.parse(store.m.get(SSO_TX_KEY)!) as { state: string; codeVerifier: string; tenantId: string; createdAt: number };

describe("beginSsoTransaction", () => {
  it("returns a state and an S256 challenge that is exactly base64url(SHA-256(verifier)) of the verifier it kept", async () => {
    const { state, codeChallenge } = await beginSsoTransaction("tenant-1", 1000);
    const tx = stored();
    expect(codeChallenge).toBe(sha256b64url(tx.codeVerifier));
    expect(codeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/); // the shape the server's zod schema accepts
    expect(state).toBe(tx.state);
  });

  it("makes a verifier inside RFC 7636's 43-128 unreserved characters, and never puts it in what it returns", async () => {
    const out = await beginSsoTransaction("tenant-1");
    const { codeVerifier } = stored();
    expect(codeVerifier).toMatch(/^[A-Za-z0-9._~-]{43,128}$/);
    expect(JSON.stringify(out)).not.toContain(codeVerifier); // only the challenge may leave the tab
  });

  it("is unguessable: every transaction gets a fresh state and verifier", async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const { state } = await beginSsoTransaction("tenant-1");
      seen.add(state).add(stored().codeVerifier);
    }
    expect(seen.size).toBe(40);
  });

  it("the latest login this tab started replaces the earlier one", async () => {
    const first = await beginSsoTransaction("tenant-1", 1000);
    const second = await beginSsoTransaction("tenant-2", 2000);
    expect(consumeSsoTransaction(first.state, 3000)).toEqual({ ok: false, reason: "state_mismatch" });
    // ...and that failed attempt burned the transaction, so the second is gone too — the user simply starts again
    expect(consumeSsoTransaction(second.state, 3000)).toEqual({ ok: false, reason: "no_transaction" });
  });
});

describe("consumeSsoTransaction — the callback is only accepted if this tab started the login", () => {
  it("accepts the state this tab sent out, and hands back the tenant and verifier from the STORED transaction", async () => {
    const { state } = await beginSsoTransaction("tenant-1", 1000);
    const { codeVerifier } = stored();
    expect(consumeSsoTransaction(state, 2000)).toEqual({ ok: true, tenantId: "tenant-1", codeVerifier });
  });

  it("is single-use: replaying the same callback finds nothing", async () => {
    const { state } = await beginSsoTransaction("tenant-1", 1000);
    expect(consumeSsoTransaction(state, 2000).ok).toBe(true);
    expect(consumeSsoTransaction(state, 2000)).toEqual({ ok: false, reason: "no_transaction" });
  });

  it("THE ATTACK: a crafted callback link opened in a tab that never started a login is refused", () => {
    // Nothing stored — exactly what a victim's tab looks like when an attacker sends them ?code=<attacker's>&state=<anything>
    expect(consumeSsoTransaction("attacker-chosen-state", 1000)).toEqual({ ok: false, reason: "no_transaction" });
  });

  it("refuses a different state, and burns the transaction so the attacker cannot retry against it", async () => {
    const { state } = await beginSsoTransaction("tenant-1", 1000);
    expect(consumeSsoTransaction("someone-elses-state", 2000)).toEqual({ ok: false, reason: "state_mismatch" });
    expect(store.m.has(SSO_TX_KEY)).toBe(false);
    expect(consumeSsoTransaction(state, 2000)).toEqual({ ok: false, reason: "no_transaction" });
  });

  it.each([[null], [""]])("refuses a callback with no state at all (%j)", async (missing) => {
    await beginSsoTransaction("tenant-1", 1000);
    expect(consumeSsoTransaction(missing as any, 2000)).toEqual({ ok: false, reason: "state_mismatch" });
  });

  it("a state that merely CONTAINS the right one is not the right one (whole-string comparison)", async () => {
    const { state } = await beginSsoTransaction("tenant-1", 1000);
    expect(consumeSsoTransaction(state + "x", 2000).ok).toBe(false);
    await beginSsoTransaction("tenant-1", 1000);
    expect(consumeSsoTransaction(state.slice(0, -1), 2000).ok).toBe(false);
  });

  it("expires an abandoned login after the TTL, but not a moment before", async () => {
    const { state } = await beginSsoTransaction("tenant-1", 1000);
    expect(consumeSsoTransaction(state, 1000 + SSO_TX_TTL_MS).ok).toBe(true);
    const again = await beginSsoTransaction("tenant-1", 1000);
    expect(consumeSsoTransaction(again.state, 1000 + SSO_TX_TTL_MS + 1)).toEqual({ ok: false, reason: "expired" });
  });

  it("treats a clock that has gone backwards as expired rather than trusting it", async () => {
    const { state } = await beginSsoTransaction("tenant-1", 5000);
    expect(consumeSsoTransaction(state, 4000)).toEqual({ ok: false, reason: "expired" });
  });

  it.each([
    ["not json", "{{{"],
    ["missing verifier", JSON.stringify({ state: "s", tenantId: "t", createdAt: 1 })],
    ["empty state", JSON.stringify({ state: "", codeVerifier: "v", tenantId: "t", createdAt: 1 })],
    ["wrong type", JSON.stringify({ state: "s", codeVerifier: "v", tenantId: "t", createdAt: "1" })],
  ])("refuses a corrupt stored transaction (%s) without throwing", (_name, raw) => {
    store.m.set(SSO_TX_KEY, raw);
    const r = consumeSsoTransaction("s", 2);
    expect(r.ok).toBe(false);
    expect(store.m.has(SSO_TX_KEY)).toBe(false);
  });

  it("does not crash when sessionStorage itself is unavailable (private mode, blocked storage)", () => {
    vi.stubGlobal("sessionStorage", { getItem: () => { throw new Error("denied"); }, removeItem: () => {}, setItem: () => {} });
    expect(consumeSsoTransaction("s", 1)).toEqual({ ok: false, reason: "no_transaction" });
  });
});

describe("ssoFailureMessage", () => {
  it("says 'too long' for an expired login and something generic for every other reason (no oracle for an attacker)", () => {
    expect(ssoFailureMessage("expired")).toMatch(/too long/i);
    const generic = ssoFailureMessage("state_mismatch");
    for (const r of ["no_transaction", "malformed", "state_mismatch"] as const) expect(ssoFailureMessage(r)).toBe(generic);
  });
});

// ── wiring: the transaction only protects anything if the two pages actually use it ──────────────────────────────
describe("wiring (a regression here reopens login CSRF without failing any behavioural test)", () => {
  const src = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");

  it("SsoCallback checks the transaction before it calls the server, forwards the verifier, and no longer trusts the URL's state for the tenant", () => {
    const s = src("pages/portal/SsoCallback.tsx");
    expect(s).toContain("consumeSsoTransaction(");
    expect(s.indexOf("consumeSsoTransaction(")).toBeLessThan(s.indexOf("exchangeMutation.mutate("));
    expect(s).toContain("codeVerifier: tx.codeVerifier");
    expect(s).toContain("tenantId: tx.tenantId");
    expect(s, "decoding the tenant out of the URL's state is the old, unauthenticated behaviour").not.toMatch(/atob\(/);
  });

  it("TenantPortalLayout starts the transaction and sends the challenge, and no longer builds a guessable state", () => {
    const s = src("components/TenantPortalLayout.tsx");
    expect(s).toContain("beginSsoTransaction(");
    expect(s).toMatch(/state,\s*codeChallenge/);
    expect(s).not.toMatch(/btoa\(JSON\.stringify\(\{\s*tenantId/);
  });
});
