/**
 * scripts/fix-keycloak-post-logout-uris.ts — Allow the app's three
 * post-logout redirect targets on the wacommerce-app Keycloak client.
 *
 * client/src/const.ts's startLogout() redirects to
 * `${origin}${import.meta.env.BASE_URL}` after ending the Keycloak SSO
 * session — "/" for the legacy client, "/tenant-portal/" and
 * "/platform-admin/" for the two standalone apps. Keycloak rejects any
 * post_logout_redirect_uri not on the client's allowlist ("We are sorry...
 * Invalid redirect uri"). The client's `post.logout.redirect.uris` attribute
 * was "+" — a sentinel meaning "reuse Valid Redirect URIs" — which only ever
 * contained the OAuth callback URL, not any of these three. This sets an
 * explicit list instead (Keycloak's own "##"-separated multi-value format).
 *
 * Same admin-cli auth pattern as scripts/enable-keycloak-registration.ts.
 *
 * Usage:
 *   KEYCLOAK_URL=https://keycloak-servers.newfire.app \
 *   KEYCLOAK_ADMIN_PASSWORD=*** \
 *   npx tsx scripts/fix-keycloak-post-logout-uris.ts [--dry-run]
 */

export interface FixPostLogoutUrisOptions {
  keycloakUrl: string;
  realm: string;
  clientId: string;
  adminUsername: string;
  adminPassword: string;
  postLogoutRedirectUris: string[];
  dryRun?: boolean;
  log?: (msg: string) => void;
}

async function fetchAdminToken(opts: FixPostLogoutUrisOptions): Promise<string> {
  const params = new URLSearchParams();
  params.append("grant_type", "password");
  params.append("client_id", "admin-cli");
  params.append("username", opts.adminUsername);
  params.append("password", opts.adminPassword);

  const res = await fetch(`${opts.keycloakUrl}/realms/master/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  if (!res.ok) {
    throw new Error(`admin token request failed: HTTP ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

export async function fixPostLogoutUris(
  opts: FixPostLogoutUrisOptions,
): Promise<"already-set" | "dry-run" | "fixed"> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const token = await fetchAdminToken(opts);
  const authHeaders = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const getRes = await fetch(
    `${opts.keycloakUrl}/admin/realms/${opts.realm}/clients?clientId=${opts.clientId}`,
    { headers: authHeaders },
  );
  if (!getRes.ok) {
    throw new Error(`GET client "${opts.clientId}" failed: HTTP ${getRes.status} ${await getRes.text()}`);
  }
  const clients = (await getRes.json()) as Array<{ id: string; attributes?: Record<string, string> }>;
  const client = clients[0];
  if (!client) throw new Error(`client "${opts.clientId}" not found in realm "${opts.realm}"`);

  const wanted = opts.postLogoutRedirectUris.join("##");
  const current = client.attributes?.["post.logout.redirect.uris"];

  log(`[fix-keycloak-post-logout-uris] current post.logout.redirect.uris: ${current ?? "(unset)"}`);
  log(`[fix-keycloak-post-logout-uris] wanted:  ${wanted}`);

  if (current === wanted) {
    log("[fix-keycloak-post-logout-uris] already set — nothing to do");
    return "already-set";
  }

  if (opts.dryRun) {
    log("[fix-keycloak-post-logout-uris] --dry-run: would update post.logout.redirect.uris (no changes made)");
    return "dry-run";
  }

  const putRes = await fetch(`${opts.keycloakUrl}/admin/realms/${opts.realm}/clients/${client.id}`, {
    method: "PUT",
    headers: authHeaders,
    body: JSON.stringify({
      ...client,
      attributes: { ...client.attributes, "post.logout.redirect.uris": wanted },
    }),
  });
  if (!putRes.ok) {
    throw new Error(`PUT client "${opts.clientId}" failed: HTTP ${putRes.status} ${await putRes.text()}`);
  }

  log("[fix-keycloak-post-logout-uris] updated");
  return "fixed";
}

// ─── CLI entry ──────────────────────────────────────────────────────────────
const invokedAsScript = !!process.argv[1] && /fix-keycloak-post-logout-uris(\.ts)?$/.test(process.argv[1]);
if (invokedAsScript) {
  const keycloakUrl = process.env.KEYCLOAK_URL;
  const realm = process.env.KEYCLOAK_REALM ?? "wacommerce";
  const clientId = process.env.KEYCLOAK_CLIENT_ID ?? "wacommerce-app";
  const adminUsername = process.env.KEYCLOAK_ADMIN_USERNAME ?? "admin";
  const adminPassword = process.env.KEYCLOAK_ADMIN_PASSWORD;
  const appOrigin = process.env.APP_ORIGIN ?? "https://wa-app.newfire.app";
  const dryRun = process.argv.includes("--dry-run");

  if (!keycloakUrl || !adminPassword) {
    console.error(
      "[fix-keycloak-post-logout-uris] FATAL: KEYCLOAK_URL and KEYCLOAK_ADMIN_PASSWORD must be set",
    );
    process.exit(1);
  }

  fixPostLogoutUris({
    keycloakUrl,
    realm,
    clientId,
    adminUsername,
    adminPassword,
    postLogoutRedirectUris: [
      `${appOrigin}/`,
      `${appOrigin}/tenant-portal/`,
      `${appOrigin}/platform-admin/`,
    ],
    dryRun,
  }).catch((err) => {
    console.error("[fix-keycloak-post-logout-uris] FAILED:", err?.message ?? err);
    process.exit(1);
  });
}
