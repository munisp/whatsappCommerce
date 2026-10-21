export { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";

/**
 * Start the Keycloak OIDC login flow.
 *
 * Navigates to the SERVER-driven `GET /api/auth/login`, which does the parts a browser cannot do safely: it mints the
 * PKCE verifier/challenge (S256) and the OIDC nonce, keeps them in a signed httpOnly cookie, and builds the Keycloak URL.
 * `/api/auth/callback` then refuses any callback that does not carry that cookie — that is what stops login CSRF (QA-020).
 *
 * This used to build the Keycloak URL in the browser: it generated a "PKCE verifier" it never sent, wrote a
 * `__Host-` state cookie without `Secure` (browsers discard those), and the server never read it — so nothing bound a
 * login to the browser that began it. Do not reintroduce a client-built authorization URL: the server now rejects it.
 *
 * All three front-ends (merchant SPA, platform-admin, tenant-portal) share this file and are served from one origin
 * (dev servers proxy /api), so one relative URL is enough. The server sanitises `redirect` to a same-origin path.
 *
 * Call this from an event handler: `onClick={() => startLogin()}`
 * Do NOT call during render — it navigates.
 *
 * Debounced: main.tsx's global "UNAUTHORIZED => log in" listener fires once per FAILED QUERY, so a page with six parallel
 * queries calls this six times in one tick. Each call would hit /api/auth/login and be handed a NEW transaction cookie;
 * the responses race, and the cookie the browser ends up holding can belong to a different login than the one it then
 * follows to Keycloak — the callback would reject it. (Harmless before the callback verified the cookie.) One login at a
 * time; the window is short enough that a deliberate second click, or coming back via bfcache, still works.
 */
const LOGIN_DEBOUNCE_MS = 3000;
let lastLoginStartedAt = -Infinity;

export const startLogin = () => {
  const now = Date.now();
  if (now - lastLoginStartedAt < LOGIN_DEBOUNCE_MS) return;
  lastLoginStartedAt = now;
  // Land back on whichever app/page the user actually started from (ui/platform-admin and ui/tenant-portal live under
  // sub-paths of the same origin).
  const returnTo = `${window.location.pathname}${window.location.search}`;
  window.location.assign(`/api/auth/login?redirect=${encodeURIComponent(returnTo)}`);
};

/**
 * True while a deliberate sign-out is in flight. main.tsx's global
 * "redirect to login on any UNAUTHORIZED query error" listener checks this
 * so it doesn't race an intentional logout — other still-mounted queries
 * failing right after the session cookie clears would otherwise trigger an
 * unwanted startLogin() call moments before startLogout() itself navigates
 * away, sometimes winning the race.
 */
let loggingOut = false;
export const setLoggingOut = (v: boolean) => { loggingOut = v; };
export const isLoggingOut = () => loggingOut;

/**
 * Start the Keycloak logout flow.
 * Ends the Keycloak SSO session and redirects back into the current app.
 *
 * This app's own session cookie is a long-lived, self-signed JWT — it is
 * NOT invalidated by ending the Keycloak session, so callers must clear it
 * separately (e.g. via the auth.logout mutation) before calling this. Without
 * this step, "signing out" only cleared this app's cookie while Keycloak's
 * own SSO session stayed alive, so the very next login attempt (deliberate,
 * or via the auto-redirect-on-401 listener above) silently re-authenticated
 * the user with no credential prompt — indistinguishable from sign-out
 * simply not working.
 */
export const startLogout = () => {
  // The server does all of it (/api/auth/sign-out, server/_core/oauth.ts): revokes the session, clears the cookies
  // and sends the browser to Keycloak's logout with the Keycloak address it knows at run time. Building that URL here
  // from VITE_ build-time values broke when they were set but empty: "/realms//protocol/…" threw, and the Keycloak
  // session survived. A form POST, so it passes the CSRF origin check. Lands back in whichever app (legacy "/",
  // tenant-portal, platform-admin) the user signed out of.
  const form = document.createElement("form");
  form.method = "POST";
  form.action = "/api/auth/sign-out";
  const back = document.createElement("input");
  back.type = "hidden";
  back.name = "redirect";
  back.value = import.meta.env.BASE_URL || "/";
  form.appendChild(back);
  document.body.appendChild(form);
  form.submit();
};
