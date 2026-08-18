/**
 * W19 SOC2 — auditChain service unit tests: canonicalization, hash linkage,
 * append/verify roundtrip on an in-memory db, tamper detection, scope
 * isolation. These tests fail if the hashing or verification is reverted.
 */
import { describe, expect, it } from "vitest";
import { auditChain } from "../../drizzle/schema";
import {
  appendAuditEventTx,
  canonicalize,
  computeAuditHash,
  GENESIS_HASH,
  verifyAuditChain,
} from "./auditChain";
import { makeSoc2FakeDb } from "./testUtils/soc2FakeDb";

function dbWith(rows: any[] = []) {
  const store = new Map<any, any[]>([[auditChain, rows]]);
  return { db: makeSoc2FakeDb(store), rows };
}

describe("canonicalize", () => {
  it("sorts object keys recursively and is whitespace-free", () => {
    expect(canonicalize({ b: 1, a: { d: 2, c: [3, { z: null, y: "x" }] } }))
      .toBe('{"a":{"c":[3,{"y":"x","z":null}],"d":2},"b":1}');
  });
  it("is key-order independent", () => {
    expect(canonicalize({ a: 1, b: 2 })).toBe(canonicalize({ b: 2, a: 1 }));
  });
  it("maps undefined/null to null", () => {
    expect(canonicalize(undefined)).toBe("null");
    expect(canonicalize(null)).toBe("null");
  });
});

describe("computeAuditHash", () => {
  it("is sha256(prevHash + '|' + canonical)", () => {
    const h = computeAuditHash(GENESIS_HASH, '{"a":1}');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).toBe(computeAuditHash(GENESIS_HASH, '{"a":1}'));
    expect(h).not.toBe(computeAuditHash(GENESIS_HASH, '{"a":2}'));
    expect(h).not.toBe(computeAuditHash("1".repeat(64), '{"a":1}'));
  });
});

describe("appendAuditEventTx + verifyAuditChain", () => {
  it("chains three events from the genesis hash and verifies", async () => {
    const { db, rows } = dbWith();
    const r1 = await appendAuditEventTx(db, { tenantId: "t1", eventType: "incident_created", actorId: "7", payload: { a: 1 } });
    expect(r1.prevHash).toBe(GENESIS_HASH);
    expect(r1.hash).toMatch(/^[0-9a-f]{64}$/);
    const r2 = await appendAuditEventTx(db, { tenantId: "t1", eventType: "incident_updated", actorId: "7" });
    expect(r2.prevHash).toBe(r1.hash);
    const r3 = await appendAuditEventTx(db, { tenantId: "t1", eventType: "retention_purge" });
    expect(r3.prevHash).toBe(r2.hash);
    expect(rows.length).toBe(3);

    const v = await verifyAuditChain(db, { tenantId: "t1" });
    expect(v).toEqual({ ok: true, rowsChecked: 3, firstBrokenId: null });
  });

  it("detects a tampered payload at exactly the broken row", async () => {
    const { db, rows } = dbWith();
    await appendAuditEventTx(db, { tenantId: "t1", eventType: "e1" });
    const r2 = await appendAuditEventTx(db, { tenantId: "t1", eventType: "e2", payload: { x: 1 } });
    await appendAuditEventTx(db, { tenantId: "t1", eventType: "e3" });
    rows[1].payload = { x: 999 }; // attacker edits history
    const v = await verifyAuditChain(db, { tenantId: "t1" });
    expect(v.ok).toBe(false);
    expect(v.rowsChecked).toBe(1);
    expect(v.firstBrokenId).toBe(r2.id);
  });

  it("detects a broken prev_hash link", async () => {
    const { db, rows } = dbWith();
    const r1 = await appendAuditEventTx(db, { tenantId: "t1", eventType: "e1" });
    await appendAuditEventTx(db, { tenantId: "t1", eventType: "e2" });
    rows[0].hash = "f".repeat(64); // rewrite first row's hash → link breaks at row 2... but row1's own hash check fires first
    const v = await verifyAuditChain(db, { tenantId: "t1" });
    expect(v.ok).toBe(false);
    expect(v.firstBrokenId).toBe(r1.id);
  });

  it("keeps per-tenant scopes independent (genesis per scope)", async () => {
    const { db } = dbWith();
    const a1 = await appendAuditEventTx(db, { tenantId: "tA", eventType: "e" });
    const b1 = await appendAuditEventTx(db, { tenantId: "tB", eventType: "e" });
    expect(a1.prevHash).toBe(GENESIS_HASH);
    expect(b1.prevHash).toBe(GENESIS_HASH);
    expect((await verifyAuditChain(db, { tenantId: "tA" })).rowsChecked).toBe(1);
    expect((await verifyAuditChain(db, { tenantId: "tB" })).rowsChecked).toBe(1);
  });

  it("verifies an empty chain as ok with 0 rows", async () => {
    const { db } = dbWith();
    expect(await verifyAuditChain(db, { tenantId: "nobody" }))
      .toEqual({ ok: true, rowsChecked: 0, firstBrokenId: null });
  });

  it("null tenantId (platform scope) chains separately", async () => {
    const { db } = dbWith();
    const p1 = await appendAuditEventTx(db, { eventType: "platform_boot" });
    expect(p1.prevHash).toBe(GENESIS_HASH);
    await appendAuditEventTx(db, { tenantId: "t1", eventType: "e" });
    expect((await verifyAuditChain(db)).rowsChecked).toBe(1);
  });
});
