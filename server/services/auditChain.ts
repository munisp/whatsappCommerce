/**
 * W19 SOC2 — tamper-evident audit chain.
 *
 * Each audit_chain row carries `hash = sha256(prevHash + "|" + canonical(fields))`
 * where canonical(fields) is a stable (sorted-key) JSON serialization of
 * { actorId, createdAt, eventType, payload, tenantId }. `prevHash` links to the
 * previous row in the SAME scope (one chain per tenantId, plus one chain for
 * tenantId=null platform events); the first row in a scope links to
 * GENESIS_HASH. Any edit, delete, or reorder of history breaks the chain and
 * is surfaced by verifyAuditChain().
 *
 * Appends happen inside the caller's transaction (appendAuditEventTx) so the
 * audit row commits or rolls back with the mutation it records.
 */
import { createHash } from "crypto";
import { asc, desc, eq, isNull } from "drizzle-orm";
import { auditChain, type AuditChainRow } from "../../drizzle/schema";

export const GENESIS_HASH = "0".repeat(64);

export interface AuditEventInput {
  tenantId?: string | null;
  eventType: string;
  actorId?: string | null;
  payload?: unknown;
}

export interface AuditChainVerification {
  ok: boolean;
  rowsChecked: number;
  firstBrokenId: string | null;
}

/** Stable JSON stringify: object keys sorted recursively, no whitespace;
 *  undefined object values are dropped (JSON.stringify semantics). */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(",")}}`;
}

/** Canonical field string for a row (or row-to-be). */
export function canonicalEventFields(fields: {
  tenantId: string | null;
  eventType: string;
  actorId: string | null;
  payload: unknown;
  createdAt: Date;
}): string {
  return canonicalize({
    actorId: fields.actorId ?? null,
    createdAt: fields.createdAt.toISOString(),
    eventType: fields.eventType,
    payload: fields.payload ?? null,
    tenantId: fields.tenantId ?? null,
  });
}

export function computeAuditHash(prevHash: string, canonicalFields: string): string {
  return createHash("sha256").update(`${prevHash}|${canonicalFields}`, "utf8").digest("hex");
}

/** Hash of a persisted row (recomputed during verification). */
export function hashRow(row: AuditChainRow): string {
  return computeAuditHash(row.prevHash, canonicalEventFields(row));
}

type DbLike = {
  select: (...args: any[]) => any;
  insert: (...args: any[]) => any;
};

/**
 * Append an event to the chain for its scope. Must be called with the
 * transaction handle (or a plain db handle for non-transactional paths).
 * Returns the inserted row.
 */
export async function appendAuditEventTx(db: DbLike, event: AuditEventInput): Promise<AuditChainRow> {
  const tenantId = event.tenantId ?? null;
  const scopeCond = tenantId === null ? isNull(auditChain.tenantId) : eq(auditChain.tenantId, tenantId);
  const [last] = await db
    .select()
    .from(auditChain)
    .where(scopeCond)
    .orderBy(desc(auditChain.createdAt), desc(auditChain.id))
    .limit(1);
  const prevHash: string = last?.hash ?? GENESIS_HASH;
  // Chain order is (created_at, id); guarantee strictly increasing created_at
  // within a scope so same-millisecond appends can never interleave.
  let createdAt = new Date();
  if (last?.createdAt && createdAt.getTime() <= new Date(last.createdAt).getTime()) {
    createdAt = new Date(new Date(last.createdAt).getTime() + 1);
  }
  const row = {
    tenantId,
    eventType: event.eventType,
    actorId: event.actorId ?? null,
    payload: (event.payload ?? null) as any,
    prevHash,
    hash: computeAuditHash(
      prevHash,
      canonicalEventFields({
        tenantId,
        eventType: event.eventType,
        actorId: event.actorId ?? null,
        payload: event.payload ?? null,
        createdAt,
      }),
    ),
    createdAt,
  };
  const inserted = await db.insert(auditChain).values(row).returning();
  return (Array.isArray(inserted) ? inserted[0] : inserted) as AuditChainRow;
}

/**
 * Walk a scope's chain in append order and re-verify every link and hash.
 * Returns the first broken row id (if any) so operators can bound the damage.
 */
export async function verifyAuditChain(
  db: DbLike,
  opts: { tenantId?: string | null } = {},
): Promise<AuditChainVerification> {
  const tenantId = opts.tenantId ?? null;
  const scopeCond = tenantId === null ? isNull(auditChain.tenantId) : eq(auditChain.tenantId, tenantId);
  const rows: AuditChainRow[] = await db
    .select()
    .from(auditChain)
    .where(scopeCond)
    .orderBy(asc(auditChain.createdAt), asc(auditChain.id));
  let expectedPrev = GENESIS_HASH;
  let rowsChecked = 0;
  for (const row of rows) {
    if (row.prevHash !== expectedPrev || row.hash !== hashRow(row)) {
      return { ok: false, rowsChecked, firstBrokenId: row.id };
    }
    expectedPrev = row.hash;
    rowsChecked += 1;
  }
  return { ok: true, rowsChecked, firstBrokenId: null };
}
