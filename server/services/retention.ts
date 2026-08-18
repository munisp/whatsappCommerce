/**
 * W19 SOC2 — data retention + purge.
 *
 * retention_policies rows define, per (tenant, entity), how many days of
 * history to keep. purgePreview() reports how many rows would be deleted;
 * purgeExecute() deletes them. Rows for an entity under legal_hold are NEVER
 * purged (litigation/regulator hold) — the hold wins over retention_days.
 * Every execution is recorded on the tamper-evident audit chain.
 */
import { and, eq, lt } from "drizzle-orm";
import {
  auditLogs,
  channelMessages,
  conversations,
  customers,
  orders,
  retentionPolicies,
} from "../../drizzle/schema";
import { appendAuditEventTx } from "./auditChain";

/** Entities purge can target, mapped to their table + timestamp column. */
export const PURGEABLE_ENTITIES = {
  orders: { table: orders, tenantCol: orders.tenantId, createdCol: orders.createdAt },
  messages: { table: channelMessages, tenantCol: channelMessages.tenantId, createdCol: channelMessages.createdAt },
  conversations: { table: conversations, tenantCol: conversations.tenantId, createdCol: conversations.createdAt },
  customers: { table: customers, tenantCol: customers.tenantId, createdCol: customers.createdAt },
  audit_logs: { table: auditLogs, tenantCol: auditLogs.tenantId, createdCol: auditLogs.createdAt },
} as const;

export type PurgeableEntity = keyof typeof PURGEABLE_ENTITIES;

export function isPurgeableEntity(entity: string): entity is PurgeableEntity {
  return entity in PURGEABLE_ENTITIES;
}

export class UnknownEntityError extends Error {
  constructor(entity: string) {
    super(`Unknown purgeable entity: ${entity}`);
    this.name = "UnknownEntityError";
  }
}

export interface PurgePreviewRow {
  entity: string;
  retentionDays: number;
  legalHold: boolean;
  cutoff: string; // ISO
  candidateRows: number; // 0 when legalHold — hold always wins
  skipped: boolean; // true when legalHold prevented counting/purge
}

type DbLike = {
  select: (...args: any[]) => any;
  insert: (...args: any[]) => any;
  update: (...args: any[]) => any;
  delete: (...args: any[]) => any;
};

export async function listRetentionPolicies(db: DbLike, tenantId: string) {
  return db
    .select()
    .from(retentionPolicies)
    .where(eq(retentionPolicies.tenantId, tenantId));
}

export async function upsertRetentionPolicy(
  db: DbLike,
  input: { tenantId: string; entity: string; retentionDays: number; legalHold: boolean },
  actorId?: string | null,
) {
  if (!isPurgeableEntity(input.entity)) throw new UnknownEntityError(input.entity);
  if (!Number.isInteger(input.retentionDays) || input.retentionDays < 0) {
    throw new Error("retentionDays must be a non-negative integer");
  }
  const now = new Date();
  const existing = await db
    .select()
    .from(retentionPolicies)
    .where(and(eq(retentionPolicies.tenantId, input.tenantId), eq(retentionPolicies.entity, input.entity)))
    .limit(1);
  let row;
  if (existing[0]) {
    const updated = await db
      .update(retentionPolicies)
      .set({ retentionDays: input.retentionDays, legalHold: input.legalHold, updatedAt: now })
      .where(eq(retentionPolicies.id, existing[0].id))
      .returning();
    row = Array.isArray(updated) ? updated[0] : updated;
  } else {
    const inserted = await db
      .insert(retentionPolicies)
      .values({
        tenantId: input.tenantId,
        entity: input.entity,
        retentionDays: input.retentionDays,
        legalHold: input.legalHold,
        updatedAt: now,
      })
      .returning();
    row = Array.isArray(inserted) ? inserted[0] : inserted;
  }
  await appendAuditEventTx(db, {
    tenantId: input.tenantId,
    eventType: "retention_policy_upsert",
    actorId,
    payload: { entity: input.entity, retentionDays: input.retentionDays, legalHold: input.legalHold },
  });
  return row;
}

async function policiesFor(db: DbLike, tenantId: string, entity?: string) {
  const conds = [eq(retentionPolicies.tenantId, tenantId)];
  if (entity) conds.push(eq(retentionPolicies.entity, entity));
  return db.select().from(retentionPolicies).where(and(...conds));
}

/**
 * Count rows eligible for purge under each applicable policy. Entities under
 * legal hold are reported with candidateRows=0 and skipped=true — never counted
 * for deletion.
 */
export async function purgePreview(
  db: DbLike,
  tenantId: string,
  entity?: string,
  now: Date = new Date(),
): Promise<PurgePreviewRow[]> {
  if (entity && !isPurgeableEntity(entity)) throw new UnknownEntityError(entity);
  const policies = await policiesFor(db, tenantId, entity);
  const out: PurgePreviewRow[] = [];
  for (const p of policies) {
    if (!isPurgeableEntity(p.entity)) continue;
    const cutoff = new Date(now.getTime() - p.retentionDays * 24 * 60 * 60 * 1000);
    if (p.legalHold) {
      out.push({ entity: p.entity, retentionDays: p.retentionDays, legalHold: true, cutoff: cutoff.toISOString(), candidateRows: 0, skipped: true });
      continue;
    }
    const spec = PURGEABLE_ENTITIES[p.entity as PurgeableEntity];
    const rows = await db
      .select({ id: (spec.table as any).id })
      .from(spec.table)
      .where(and(eq(spec.tenantCol as any, tenantId), lt(spec.createdCol as any, cutoff)));
    out.push({ entity: p.entity, retentionDays: p.retentionDays, legalHold: false, cutoff: cutoff.toISOString(), candidateRows: rows.length, skipped: false });
  }
  return out;
}

export interface PurgeResultRow extends PurgePreviewRow {
  deleted: number;
}

/**
 * Execute the purge. Deletes exactly the rows purgePreview would report
 * (same cutoff basis, passed in as `now` for determinism). Legal-hold entities
 * are skipped. Appends a `retention_purge` event to the audit chain.
 */
export async function purgeExecute(
  db: DbLike,
  tenantId: string,
  opts: { entity?: string; actorId?: string | null; now?: Date } = {},
): Promise<PurgeResultRow[]> {
  const now = opts.now ?? new Date();
  const preview = await purgePreview(db, tenantId, opts.entity, now);
  const results: PurgeResultRow[] = [];
  for (const p of preview) {
    if (p.skipped || p.candidateRows === 0) {
      results.push({ ...p, deleted: 0 });
      continue;
    }
    const spec = PURGEABLE_ENTITIES[p.entity as PurgeableEntity];
    await db
      .delete(spec.table)
      .where(and(eq(spec.tenantCol as any, tenantId), lt(spec.createdCol as any, new Date(p.cutoff))));
    results.push({ ...p, deleted: p.candidateRows });
  }
  await appendAuditEventTx(db, {
    tenantId,
    eventType: "retention_purge",
    actorId: opts.actorId,
    payload: { entity: opts.entity ?? null, results: results.map((r) => ({ entity: r.entity, deleted: r.deleted, skipped: r.skipped })) },
  });
  return results;
}
