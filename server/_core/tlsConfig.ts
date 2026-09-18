/**
 * server/_core/tlsConfig.ts — W42 (PLT-14) TLS verification policy for
 * outbound infra clients (PG / Redis / OpenSearch).
 *
 * Previously every client set `rejectUnauthorized: false`, silently
 * accepting ANY certificate (MITM-able). The policy is now:
 *
 *   - DEFAULT: rejectUnauthorized = true (full chain verification).
 *   - CA bundle override: set `<PREFIX>_TLS_CA` to the PEM bundle inline or
 *     to a file path containing it (for self-signed / private-CA deployments
 *     — the honest fix instead of disabling verification).
 *   - Emergency/dev opt-out: `<PREFIX>_TLS_REJECT_UNAUTHORIZED=false`
 *     restores the old insecure behavior with a loud warning. NEVER use in
 *     production; see docs/TLS.md.
 *
 * Misconfiguration fails honestly: an unreadable/empty CA override throws a
 * descriptive error instead of silently connecting without verification.
 */
import { readFileSync, existsSync } from "node:fs";

export interface TlsClientOptions {
  rejectUnauthorized: boolean;
  ca?: string;
}

/**
 * Build TLS options for one client.
 * @param label  human name for logs/errors ("Postgres", "Redis", …)
 * @param prefix env prefix ("PG", "REDIS", "OPENSEARCH")
 */
export function buildTlsOptions(label: string, prefix: string): TlsClientOptions {
  const caValue = process.env[`${prefix}_TLS_CA`] ?? "";
  const caRaw = caValue.trim();
  const insecureRaw = (process.env[`${prefix}_TLS_REJECT_UNAUTHORIZED`] ?? "").trim().toLowerCase();

  let ca: string | undefined;
  if (caRaw) {
    if (caRaw.includes("-----BEGIN")) {
      ca = caValue; // inline PEM bundle (preserve exact formatting)
    } else if (existsSync(caRaw)) {
      try {
        ca = readFileSync(caRaw, "utf8");
      } catch (e: any) {
        throw new Error(
          `[tls] ${label}: ${prefix}_TLS_CA points at "${caRaw}" but it cannot be read ` +
            `(${e?.message ?? e}). Fix the path or unset it — refusing to connect.`,
        );
      }
    } else {
      throw new Error(
        `[tls] ${label}: ${prefix}_TLS_CA is neither an inline PEM bundle nor an existing ` +
          `file path ("${caRaw.slice(0, 80)}"). Provide the CA PEM or a readable path — ` +
          `refusing to connect (see docs/TLS.md).`,
      );
    }
    if (!ca!.includes("-----BEGIN CERTIFICATE-----")) {
      throw new Error(
        `[tls] ${label}: ${prefix}_TLS_CA did not yield a PEM certificate bundle — ` +
          `refusing to connect with an empty trust store.`,
      );
    }
  }

  if (insecureRaw === "false" || insecureRaw === "0") {
    console.warn(
      `[tls] WARNING: ${label} TLS certificate verification DISABLED via ` +
        `${prefix}_TLS_REJECT_UNAUTHORIZED=false — vulnerable to MITM. Use ` +
        `${prefix}_TLS_CA with your private CA bundle instead (docs/TLS.md).`,
    );
    return { rejectUnauthorized: false, ca };
  }
  return { rejectUnauthorized: true, ca };
}
