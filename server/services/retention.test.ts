/**
 * W19 SOC2 — retention service unit tests: policy upsert, purge preview,
 * legal-hold suppression, purge execution + audit-chain recording.
 */
import { describe, expect, it } from "vitest";
import { auditChain, orders, retentionPolicies } from "../../drizzle/schema";
import {
  isPurgeableEntity,
  listRetentionPolicies,
  purgeExecute,
  purgePreview,
  UnknownEntityError,
  upsertRetentionPolicy,
} from "./retention";
import { verifyAuditChain } from "./auditChain";
import { makeSoc2FakeDb } from "./testUtils/soc2FakeDb";

const DAY = 24 * 60 * 60 * 1000;

function dbWith(seed?: { policies?: any[]; orders?: any[]; audit?: any[] }) {
  const store = new Map<any, any[]>([
    [retentionPolicies, seed?.policies ?? []],
    [orders, seed?.orders ?? []],
    [auditChain, seed?.audit ?? []],
  ]);
  return { db: makeSoc2FakeDb(store), store };
}

describe("upsertRetentionPolicy", () => {
  it("creates then updates a (tenant, entity) policy", async () => {
    const { db } = dbWith();
    const created = await upsertRetentionPolicy(db, { tenantId: "t1", entity: "orders", retentionDays: 30, legalHold: false }, "u1");
    expect(created.entity).toBe("orders");
    const updated = await upsertRetentionPolicy(db, { tenantId: "t1", entity: "orders", retentionDays: 90, legalHold: true }, "u1");
    expect(updated.id).toBe(created.id);
    expect(updated.retentionDays).toBe(90);
    expect(updated.legalHold).toBe(true);
    const all = await listRetentionPolicies(db, "t1");
    expect(all.length).toBe(1);
  });

  it("records every upsert on the audit chain", async () => {
    const { db } = dbWith();
    await upsertRetentionPolicy(db, { tenantId: "t1", entity: "orders", retentionDays: 30, legalHold: false });
    await upsertRetentionPolicy(db, { tenantId: "t1", entity: "orders", retentionDays: 60, legalHold: false });
    const v = await verifyAuditChain(db, { tenantId: "t1" });
    expect(v).toEqual({ ok: true, rowsChecked: 2, firstBrokenId: null });
  });

  it("rejects unknown entities and negative windows", async () => {
    const { db } = dbWith();
    await expect(upsertRetentionPolicy(db, { tenantId: "t1", entity: "nope", retentionDays: 30, legalHold: false }))
      .rejects.toBeInstanceOf(UnknownEntityError);
    await expect(upsertRetentionPolicy(db, { tenantId: "t1", entity: "orders", retentionDays: -1, legalHold: false }))
      .rejects.toThrow(/non-negative/);
    expect(isPurgeableEntity("orders")).toBe(true);
    expect(isPurgeableEntity("tenants")).toBe(false);
  });
});

describe("purgePreview / purgeExecute", () => {
  const oldOrder = { id: "o-old", tenantId: "t1", createdAt: new Date(Date.now() - 40 * DAY) };
  const newOrder = { id: "o-new", tenantId: "t1", createdAt: new Date() };
  const otherTenantOld = { id: "o-other", tenantId: "t2", createdAt: new Date(Date.now() - 400 * DAY) };

  it("counts only rows past the retention window for the tenant", async () => {
    const { db } = dbWith({ orders: [oldOrder, newOrder, otherTenantOld] });
    await upsertRetentionPolicy(db, { tenantId: "t1", entity: "orders", retentionDays: 30, legalHold: false });
    const preview = await purgePreview(db, "t1");
    expect(preview.length).toBe(1);
    expect(preview[0]).toMatchObject({ entity: "orders", retentionDays: 30, legalHold: false, candidateRows: 1, skipped: false });
  });

  it("legal hold suppresses candidates and deletion", async () => {
    const { db, store } = dbWith({ orders: [{ ...oldOrder }] });
    await upsertRetentionPolicy(db, { tenantId: "t1", entity: "orders", retentionDays: 30, legalHold: true });
    const preview = await purgePreview(db, "t1");
    expect(preview[0]).toMatchObject({ candidateRows: 0, skipped: true, legalHold: true });
    const exec = await purgeExecute(db, "t1", { actorId: "u1" });
    expect(exec[0].deleted).toBe(0);
    expect(store.get(orders)!.length).toBe(1); // row survives the hold
  });

  it("execute deletes exactly the previewed rows and audits the purge", async () => {
    const { db, store } = dbWith({ orders: [{ ...oldOrder }, { ...newOrder }, { ...otherTenantOld }] });
    await upsertRetentionPolicy(db, { tenantId: "t1", entity: "orders", retentionDays: 30, legalHold: false });
    const exec = await purgeExecute(db, "t1", { actorId: "u1" });
    expect(exec[0].deleted).toBe(1);
    const ids = store.get(orders)!.map((r) => r.id);
    expect(ids).toContain("o-new");
    expect(ids).toContain("o-other"); // other tenant untouched
    expect(ids).not.toContain("o-old");
    // upsert + purge = 2 audit events, chain intact
    const v = await verifyAuditChain(db, { tenantId: "t1" });
    expect(v).toEqual({ ok: true, rowsChecked: 2, firstBrokenId: null });
  });

  it("entity filter limits scope and rejects unknown entities", async () => {
    const { db } = dbWith();
    await upsertRetentionPolicy(db, { tenantId: "t1", entity: "orders", retentionDays: 30, legalHold: false });
    await upsertRetentionPolicy(db, { tenantId: "t1", entity: "messages", retentionDays: 30, legalHold: false });
    expect((await purgePreview(db, "t1", "orders")).length).toBe(1);
    await expect(purgePreview(db, "t1", "bogus")).rejects.toBeInstanceOf(UnknownEntityError);
  });
});
