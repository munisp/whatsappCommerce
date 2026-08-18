/**
 * scripts/enable-keycloak-registration.ts — Flip on self-registration for the
 * app's Keycloak realm via the Admin REST API, instead of a manual click
 * through the Keycloak Admin Console.
 *
 * Auth pattern mirrors 54link/corebanking's KeycloakAdminApiClient: an
 * `admin-cli` Resource Owner Password grant against
 * `{KEYCLOAK_URL}/realms/master/protocol/openid-connect/token`, then calls
 * against `/admin/realms/{realm}`. Unlike corebanking's create_realm() (which
 * POSTs a brand-new realm), this reads the EXISTING realm's current config
 * and PUTs it back with only `registrationAllowed` changed — every other
 * setting on the already-live realm is left untouched.
 *
 * Requires real Keycloak admin credentials, which this script never stores —
 * it only reads them from the environment at run time. Not something Claude
 * runs on your behalf; run it yourself with the real admin password.
 *
 * Usage:
 *   KEYCLOAK_URL=https://keycloak-servers.newfire.app \
 *   KEYCLOAK_REALM=wacommerce \
 *   KEYCLOAK_ADMIN_USERNAME=admin \
 *   KEYCLOAK_ADMIN_PASSWORD=*** \
 *   npx tsx scripts/enable-keycloak-registration.ts [--dry-run]
 */

export interface KeycloakRealmConfig {
  realm: string;
  registrationAllowed?: boolean;
  [key: string]: unknown;
}

export interface EnableRegistrationOptions {
  keycloakUrl: string;
  realm: string;
  adminUsername: string;
  adminPassword: string;
  dryRun?: boolean;
  log?: (msg: string) => void;
}

export type EnableRegistrationResult =
  | { status: "already-enabled" }
  | { status: "dry-run"; wouldEnable: true }
  | { status: "enabled" };

async function fetchAdminToken(opts: EnableRegistrationOptions): Promise<string> {
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

export async function enableKeycloakRegistration(
  opts: EnableRegistrationOptions,
): Promise<EnableRegistrationResult> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const token = await fetchAdminToken(opts);
  const authHeaders = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const getRes = await fetch(`${opts.keycloakUrl}/admin/realms/${opts.realm}`, { headers: authHeaders });
  if (!getRes.ok) {
    throw new Error(`GET realm "${opts.realm}" failed: HTTP ${getRes.status} ${await getRes.text()}`);
  }
  const realmConfig = (await getRes.json()) as KeycloakRealmConfig;

  log(`[enable-keycloak-registration] realm "${opts.realm}" — registrationAllowed is currently ${realmConfig.registrationAllowed ?? false}`);

  if (realmConfig.registrationAllowed === true) {
    log("[enable-keycloak-registration] already enabled — nothing to do");
    return { status: "already-enabled" };
  }

  if (opts.dryRun) {
    log("[enable-keycloak-registration] --dry-run: would PUT registrationAllowed=true (no changes made)");
    return { status: "dry-run", wouldEnable: true };
  }

  const putRes = await fetch(`${opts.keycloakUrl}/admin/realms/${opts.realm}`, {
    method: "PUT",
    headers: authHeaders,
    body: JSON.stringify({ ...realmConfig, registrationAllowed: true }),
  });
  if (!putRes.ok) {
    throw new Error(`PUT realm "${opts.realm}" failed: HTTP ${putRes.status} ${await putRes.text()}`);
  }

  log(`[enable-keycloak-registration] registrationAllowed set to true on realm "${opts.realm}"`);
  return { status: "enabled" };
}

// ─── CLI entry ──────────────────────────────────────────────────────────────
const invokedAsScript = !!process.argv[1] && /enable-keycloak-registration(\.ts)?$/.test(process.argv[1]);
if (invokedAsScript) {
  const keycloakUrl = process.env.KEYCLOAK_URL;
  const realm = process.env.KEYCLOAK_REALM ?? "wacommerce";
  const adminUsername = process.env.KEYCLOAK_ADMIN_USERNAME ?? "admin";
  const adminPassword = process.env.KEYCLOAK_ADMIN_PASSWORD;
  const dryRun = process.argv.includes("--dry-run");

  if (!keycloakUrl || !adminPassword) {
    console.error(
      "[enable-keycloak-registration] FATAL: KEYCLOAK_URL and KEYCLOAK_ADMIN_PASSWORD must be set " +
        "(KEYCLOAK_REALM defaults to \"wacommerce\", KEYCLOAK_ADMIN_USERNAME defaults to \"admin\")",
    );
    process.exit(1);
  }

  enableKeycloakRegistration({ keycloakUrl, realm, adminUsername, adminPassword, dryRun })
    .catch((err) => {
      console.error("[enable-keycloak-registration] FAILED:", err?.message ?? err);
      process.exit(1);
    });
}
