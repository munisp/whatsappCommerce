/**
 * Sign-out (server/_core/oauth.ts POST /api/auth/sign-out) — the server ends the app session AND sends the browser to
 * Keycloak's logout with the Keycloak address it knows at run time. The browser used to build that URL from build-time
 * VITE_ values; set-but-empty values gave "/realms//protocol/…", the navigation threw, and the Keycloak session lived
 * on, so the next sign-in skipped the password. Runs the real express route over a socket.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { registerOAuthRoutes } from "./oauth";
import { ENV } from "./env";

let base = "";
let server: Server;
beforeAll(async () => {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  registerOAuthRoutes(app);
  await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const signOut = (body: string, cookie = "") =>
  fetch(`${base}/api/auth/sign-out`, {
    method: "POST", redirect: "manual", body,
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...(cookie ? { Cookie: cookie } : {}) },
  });

describe("POST /api/auth/sign-out", () => {
  it("clears the session cookies and redirects to Keycloak's logout with the runtime address and the ID token hint", async () => {
    const res = await signOut("redirect=%2Fportal", "wa_session=not-a-real-token; wa_idt=ID.TOKEN.VALUE");
    expect(res.status).toBe(303);
    const to = new URL(res.headers.get("location")!);
    expect(`${to.origin}${to.pathname}`).toBe(`${ENV.keycloakUrl}/realms/${ENV.keycloakRealm}/protocol/openid-connect/logout`);
    expect(to.pathname).not.toContain("/realms//");
    expect(to.searchParams.get("client_id")).toBe(ENV.keycloakClientId);
    expect(to.searchParams.get("post_logout_redirect_uri")).toBe(new URL("/portal", ENV.appUrl).toString());
    expect(to.searchParams.get("id_token_hint")).toBe("ID.TOKEN.VALUE");
    const cleared = (res.headers.getSetCookie?.() ?? [res.headers.get("set-cookie") ?? ""]).join("\n");
    expect(cleared).toMatch(/wa_session=;/);
    expect(cleared).toMatch(/wa_idt=;[^\n]*Path=\/api\/auth/);
  });

  it("never sends the browser back to another site", async () => {
    for (const bad of ["https%3A%2F%2Fevil.example", "%2F%2Fevil.example", "javascript%3Aalert(1)"]) {
      const to = new URL((await signOut(`redirect=${bad}`)).headers.get("location")!);
      expect(to.searchParams.get("post_logout_redirect_uri")).toBe(new URL("/", ENV.appUrl).toString());
    }
  });

  it("works without an ID token (Keycloak then asks to confirm) and without any session", async () => {
    const res = await signOut("");
    expect(res.status).toBe(303);
    const to = new URL(res.headers.get("location")!);
    expect(to.searchParams.has("id_token_hint")).toBe(false);
    expect(to.searchParams.get("post_logout_redirect_uri")).toBe(new URL("/", ENV.appUrl).toString());
  });
});
