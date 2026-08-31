/**
 * === W33 embedded-api (Coder C) — Embedded AP-as-a-feature client service ===
 *
 * Partner-platform credentials for the /api/embedded/v1/* Express surface.
 * Security contract:
 *   - API keys are 32-byte random urlsafe strings; ONLY the SHA-256 hex
 *     digest is stored (embedded_clients.api_key_hash). The plaintext key is
 *     returned exactly once from createClient/rotateKey and never persisted.
 *   - Key verification hashes the presented key and timing-safe-compares it
 *     against the stored digest (length-guarded — timingSafeEqual throws on
 *     length mismatch).
 *   - Every client is bound to exactly ONE tenant (per-merchant clients).
 *     The embedded tenant context is ALWAYS this binding — request params /
 *     headers claiming a tenant are ignored.
 *   - status 'suspended' fails authentication honestly (401).
 *
 * This service owns ONLY credential lifecycle + auth resolution. All money
 * behavior stays in the existing W31 services (vendorBills, scheduledPayments,
 * arInvoices, approvals) — the Express surface is a thin pass-through.
 */
import crypto from "crypto";
import { eq } from "drizzle-orm";
import { embeddedClients, type EmbeddedClient } from "../../drizzle/schema";

type Db = any;

export const EMBEDDED_SCOPES = [
  "bills:read",
  "bills:write",
  "payments:read",
  "payments:write",
  "invoices:read",
  "invoices:write",
] as const;
export type EmbeddedScope = (typeof EMBEDDED_SCOPES)[number];

export function isValidScope(s: string): s is EmbeddedScope {
  return (EMBEDDED_SCOPES as readonly string[]).includes(s);
}

/** SHA-256 hex digest — the ONLY representation of a key we ever store. */
export function hashApiKey(plaintext: string): string {
  return crypto.createHash("sha256").update(plaintext, "utf8").digest("hex");
}

/** Generate a new plaintext API key (shown to the caller exactly once). */
export function generateApiKey(): string {
  return `emb_${crypto.randomBytes(32).toString("base64url")}`;
}

/** Length-guarded constant-time comparison (timingSafeEqual throws on length mismatch). */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/**
 * Resolve an API key to its client. Returns the client row only when the
 * digest matches (timing-safe) AND the client is active; otherwise null.
 * Callers map null → 401 (unknown key and suspended client are deliberately
 * indistinguishable at the HTTP layer beyond the honest status code).
 */
export async function resolveApiKey(db: Db, plaintext: string): Promise<{ client: EmbeddedClient; suspended: boolean } | null> {
  if (!plaintext || typeof plaintext !== "string") return null;
  const digest = hashApiKey(plaintext);
  const [row] = await db.select().from(embeddedClients).where(eq(embeddedClients.apiKeyHash, digest));
  // Timing-safe compare even though the DB lookup was by digest: a mismatched
  // row (collation/encoding surprises) can never authenticate.
  if (!row || !timingSafeEqualStr(row.apiKeyHash, digest)) return null;
  if (row.status !== "active") return { client: row, suspended: true };
  // Best-effort last_used_at touch — never blocks the request.
  db.update(embeddedClients).set({ lastUsedAt: new Date() })
    .where(eq(embeddedClients.id, row.id))
    .catch(() => {});
  return { client: row, suspended: false };
}

export function clientHasScope(client: EmbeddedClient, scope: EmbeddedScope): boolean {
  return Array.isArray(client.scopes) && client.scopes.includes(scope);
}

/** Actor label stamped on every embedded mutation (audit + bill events). */
export function embeddedActor(client: EmbeddedClient): string {
  return `embedded:${client.id}`;
}

// ─── Admin lifecycle (called from the adminProcedure router) ────────────────

export async function createClient(
  db: Db,
  input: { partnerName: string; tenantId: string; scopes: string[]; createdBy: string },
): Promise<{ client: EmbeddedClient; apiKey: string }> {
  const apiKey = generateApiKey();
  const [client] = await db.insert(embeddedClients).values({
    id: crypto.randomUUID(),
    partnerName: input.partnerName.slice(0, 160),
    apiKeyHash: hashApiKey(apiKey),
    scopes: input.scopes,
    tenantId: input.tenantId,
    status: "active",
    createdBy: input.createdBy.slice(0, 64),
    createdAt: new Date(),
  }).returning();
  return { client, apiKey };
}

export async function suspendClient(db: Db, clientId: string): Promise<EmbeddedClient | null> {
  const [row] = await db.update(embeddedClients)
    .set({ status: "suspended" })
    .where(eq(embeddedClients.id, clientId))
    .returning();
  return row ?? null;
}

/** Rotate: new key, new digest, old key immediately invalid. Returns plaintext once. */
export async function rotateKey(db: Db, clientId: string): Promise<{ client: EmbeddedClient; apiKey: string } | null> {
  const apiKey = generateApiKey();
  const [row] = await db.update(embeddedClients)
    .set({ apiKeyHash: hashApiKey(apiKey) })
    .where(eq(embeddedClients.id, clientId))
    .returning();
  if (!row) return null;
  return { client: row, apiKey };
}

export async function listClients(db: Db, tenantId?: string): Promise<Array<Omit<EmbeddedClient, "apiKeyHash">>> {
  const rows = tenantId
    ? await db.select().from(embeddedClients).where(eq(embeddedClients.tenantId, tenantId))
    : await db.select().from(embeddedClients);
  // NEVER expose digests on the admin list surface.
  return rows.map(({ apiKeyHash: _hash, ...rest }: EmbeddedClient) => rest);
}
