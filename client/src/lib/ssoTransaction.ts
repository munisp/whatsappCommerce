/**
 * QA-039: browser side of the tenant-portal SSO (Keycloak) login transaction.
 *
 * Why this exists: /portal/sso-callback used to complete a login for ANY `code` + `state` in its URL. The `state` it
 * sent out was `btoa({tenantId, returnTo})` — guessable, and never stored anywhere, so nothing tied the callback to
 * the browser that started the login. That is login CSRF: someone with their own valid realm login can hand a victim a
 * crafted callback link and the victim's browser ends up holding a portal session for the attacker's identity.
 *
 * The fix is the standard pair, and both halves have to live HERE, because the browser is the only party that can
 * remember something across the redirect to Keycloak and back:
 *   - `state`: an unguessable per-transaction value, stored in this tab's sessionStorage and compared on return;
 *   - PKCE (RFC 7636, S256): the verifier never leaves this tab except in the final token request, and Keycloak
 *     refuses to exchange a code whose challenge does not match it.
 *
 * sessionStorage (not localStorage, not a cookie) on purpose: it is per-tab, so two logins in two tabs cannot clobber
 * each other, and it is not sent to any server.
 */

export const SSO_TX_KEY = "wa_sso_tx";
/** A login the user abandoned at Keycloak's form must not stay redeemable forever. */
export const SSO_TX_TTL_MS = 10 * 60 * 1000;

type StoredTransaction = { state: string; codeVerifier: string; tenantId: string; createdAt: number };

export type BegunSsoTransaction = { state: string; codeChallenge: string };

export type ConsumedSsoTransaction =
  | { ok: true; tenantId: string; codeVerifier: string }
  | { ok: false; reason: "no_transaction" | "malformed" | "expired" | "state_mismatch" };

const enc = new TextEncoder();

function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomBytes(n: number): Uint8Array {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return a;
}

/**
 * Start a transaction: generate + remember the state and verifier, return what goes to the server (state, challenge).
 * Overwrites any earlier transaction in this tab — the latest login the user started is the one that counts.
 */
export async function beginSsoTransaction(tenantId: string, now: number = Date.now()): Promise<BegunSsoTransaction> {
  const nonce = base64url(randomBytes(32)); // 256 bits
  const codeVerifier = base64url(randomBytes(48)); // 64 chars, inside RFC 7636's 43-128
  const codeChallenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(codeVerifier))));
  // The state stays an opaque, self-describing string (handy in a Keycloak log) — but nothing trusts what is INSIDE it:
  // the tenant used at exchange time comes from the stored transaction, and the whole string is compared as-is.
  const state = base64url(enc.encode(JSON.stringify({ tenantId, nonce, returnTo: "/portal" })));
  const tx: StoredTransaction = { state, codeVerifier, tenantId, createdAt: now };
  sessionStorage.setItem(SSO_TX_KEY, JSON.stringify(tx));
  return { state, codeChallenge };
}

/**
 * Finish a transaction from the callback URL's `state`. SINGLE USE: the stored transaction is removed before anything
 * is checked, so a mismatched or replayed callback cannot be retried against it. (A crafted link can therefore cancel
 * the victim's in-progress login — they sign in again; the alternative is letting an attacker retry.)
 */
export function consumeSsoTransaction(returnedState: string | null, now: number = Date.now()): ConsumedSsoTransaction {
  let raw: string | null = null;
  try {
    raw = sessionStorage.getItem(SSO_TX_KEY);
    sessionStorage.removeItem(SSO_TX_KEY);
  } catch {
    return { ok: false, reason: "no_transaction" };
  }
  if (!raw) return { ok: false, reason: "no_transaction" };

  let tx: StoredTransaction;
  try {
    tx = JSON.parse(raw) as StoredTransaction;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (
    typeof tx?.state !== "string" || typeof tx.codeVerifier !== "string" ||
    typeof tx.tenantId !== "string" || typeof tx.createdAt !== "number" ||
    !tx.state || !tx.codeVerifier || !tx.tenantId
  ) return { ok: false, reason: "malformed" };

  if (now - tx.createdAt > SSO_TX_TTL_MS || now < tx.createdAt) return { ok: false, reason: "expired" };
  // No state on the URL, or a different one: this callback was not produced by the login THIS tab started.
  if (!returnedState || returnedState !== tx.state) return { ok: false, reason: "state_mismatch" };

  return { ok: true, tenantId: tx.tenantId, codeVerifier: tx.codeVerifier };
}

/** What to tell the user. Deliberately vague about WHICH check failed — the reason is for logs and tests, not attackers. */
export function ssoFailureMessage(reason: Extract<ConsumedSsoTransaction, { ok: false }>["reason"]): string {
  return reason === "expired"
    ? "Your SSO sign-in took too long. Please start it again."
    : "This SSO sign-in was not started from this browser tab, or it has already been used. Please start it again from the portal.";
}
