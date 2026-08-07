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
  const redirectUri = `${window.location.origin}/api/oauth/callback`;

  // Generate PKCE code verifier and challenge
  const nonce = crypto.randomUUID();
  const codeVerifier = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");

  // Store code verifier in sessionStorage for callback
  sessionStorage.setItem("pkce_code_verifier", codeVerifier);
  sessionStorage.setItem("oauth_nonce", nonce);

  // Write state cookie for CSRF protection
  const state = encodeOAuthState({ redirectUri, nonce });
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
 * Start the Keycloak logout flow.
 * Clears session cookie and redirects to Keycloak logout endpoint.
 */
export const startLogout = () => {
  const keycloakUrl = import.meta.env.VITE_KEYCLOAK_URL ?? "http://localhost:8080";
  const keycloakRealm = import.meta.env.VITE_KEYCLOAK_REALM ?? "wacommerce";
  const clientId = import.meta.env.VITE_KEYCLOAK_CLIENT_ID ?? "wacommerce-app";
  const postLogoutUri = window.location.origin;

  const logoutUrl = new URL(
    `${keycloakUrl}/realms/${keycloakRealm}/protocol/openid-connect/logout`
  );
  logoutUrl.searchParams.set("client_id", clientId);
  logoutUrl.searchParams.set("post_logout_redirect_uri", postLogoutUri);

  window.location.href = logoutUrl.toString();
};
