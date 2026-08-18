import { OAUTH_STATE_COOKIE, encodeOAuthState } from "@shared/const";
export { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";

/**
 * Start the Keycloak OIDC login flow.
 *
 * Uses PKCE (Proof Key for Code Exchange) for security.
 * Redirects to Keycloak's authorization endpoint.
 *
 * Call this from an event handler: `onClick={() => startLogin()}`
 * Do NOT call during render — it has side effects (cookie write + navigation).
 */
export const startLogin = () => {
  const keycloakUrl = import.meta.env.VITE_KEYCLOAK_URL ?? "http://localhost:8080";
  const keycloakRealm = import.meta.env.VITE_KEYCLOAK_REALM ?? "wacommerce";
  const clientId = import.meta.env.VITE_KEYCLOAK_CLIENT_ID ?? "wacommerce-app";
  const redirectUri = `${window.location.origin}/api/auth/callback`;
  // Land back on whichever app/page the user actually started from — the
  // callback previously always defaulted to "/", which stranded logins
  // initiated from ui/platform-admin or ui/tenant-portal on the legacy
  // combined client instead of returning to the app they were in.
  const returnTo = `${window.location.pathname}${window.location.search}`;

  // Generate PKCE code verifier and challenge
  const nonce = crypto.randomUUID();
  const codeVerifier = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");

  // Store code verifier in sessionStorage for callback
  sessionStorage.setItem("pkce_code_verifier", codeVerifier);
  sessionStorage.setItem("oauth_nonce", nonce);

  // Write state cookie for CSRF protection
  const state = encodeOAuthState({ redirectUri, nonce, returnTo });
  document.cookie = `${OAUTH_STATE_COOKIE}=${nonce}; Path=/; Max-Age=600; SameSite=Lax`;

  // Build Keycloak authorization URL
  const authUrl = new URL(
    `${keycloakUrl}/realms/${keycloakRealm}/protocol/openid-connect/auth`
  );
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", "openid profile email");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("nonce", nonce);

  window.location.href = authUrl.toString();
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
  const keycloakUrl = import.meta.env.VITE_KEYCLOAK_URL ?? "http://localhost:8080";
  const keycloakRealm = import.meta.env.VITE_KEYCLOAK_REALM ?? "wacommerce";
  const clientId = import.meta.env.VITE_KEYCLOAK_CLIENT_ID ?? "wacommerce-app";
  // Land back in whichever app (legacy "/", tenant-portal, platform-admin)
  // the user was actually signing out of, not always the bare origin.
  const postLogoutUri = `${window.location.origin}${import.meta.env.BASE_URL}`;

  const logoutUrl = new URL(
    `${keycloakUrl}/realms/${keycloakRealm}/protocol/openid-connect/logout`
  );
  logoutUrl.searchParams.set("client_id", clientId);
  logoutUrl.searchParams.set("post_logout_redirect_uri", postLogoutUri);

  window.location.href = logoutUrl.toString();
};
