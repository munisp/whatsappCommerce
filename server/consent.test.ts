/**
 * consent — unit tests
 * YES/NO parsing, insert-vs-update persistence, and the broadcast gate
 * hasConsent(tenantId, phone) — channel 'whatsapp', fail-closed on DB outage.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

let dbImpl: any = null;
vi.mock("./db", () => ({
  getDb: vi.fn(async () => dbImpl),
}));

import { hasConsent, parseConsentReply, recordConsent, getConsent } from "./services/consent";

function makeDb(selectResults: any[][] = []) {
  const inserted: any[] = [];
  const updates: any[] = [];
  const db: any = {
    select: () => {
      const result = selectResults.length > 0 ? selectResults.shift()! : [];
      const chain: any = {};
      chain.from = () => chain;
      chain.where = () => chain;
      chain.orderBy = () => chain;
      chain.limit = () => Promise.resolve(result);
      return chain;
    },
    insert: () => ({
      values: (v: any) => {
        inserted.push(v);
        return Promise.resolve();
      },
    }),
    update: () => ({
      set: (v: any) => {
        updates.push(v);
        return { where: () => Promise.resolve() };
      },
    }),
  };
  return { db, inserted, updates };
}

const T = "tenant-1";
const P = "+2348012345678";

beforeEach(() => {
  dbImpl = null;
});

describe("parseConsentReply", () => {
  it("parses affirmative replies", () => {
    for (const t of ["YES", "yes", " y ", "ok", "agree"]) expect(parseConsentReply(t)).toBe(true);
  });
  it("parses negative replies", () => {
    for (const t of ["NO", "n", "stop", "opt out", "decline"]) expect(parseConsentReply(t)).toBe(false);
  });
  it("returns null for anything else", () => {
    expect(parseConsentReply("maybe later")).toBeNull();
    expect(parseConsentReply("2")).toBeNull();
  });
});

describe("recordConsent", () => {
  it("inserts a new row (channel whatsapp) when none exists", async () => {
    const { db, inserted } = makeDb([[]]); // getConsent → none
    await recordConsent(db, { tenantId: T, phone: P, granted: true });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ tenantId: T, phone: P, channel: "whatsapp", granted: true });
  });

  it("updates the existing row on re-consent / opt-out flip", async () => {
    const { db, inserted, updates } = makeDb([[{ id: "c9", granted: true }]]);
    await recordConsent(db, { tenantId: T, phone: P, granted: false });
    expect(inserted).toHaveLength(0);
    expect(updates[0]).toMatchObject({ granted: false });
  });
});

describe("hasConsent — broadcast gate", () => {
  it("returns true only when a granted whatsapp consent row exists", async () => {
    dbImpl = makeDb([[{ id: "c1", granted: true }]]).db;
    expect(await hasConsent(T, P)).toBe(true);

    dbImpl = makeDb([[{ id: "c1", granted: false }]]).db;
    expect(await hasConsent(T, P)).toBe(false);

    dbImpl = makeDb([[]]).db; // no row
    expect(await hasConsent(T, P)).toBe(false);
  });

  it("fails CLOSED (false) when the DB is unavailable", async () => {
    dbImpl = null;
    expect(await hasConsent(T, P)).toBe(false);
  });
});

describe("getConsent", () => {
  it("returns the matching row or null", async () => {
    const row = { id: "c1", tenantId: T, phone: P, channel: "whatsapp", granted: true };
    const { db } = makeDb([[row]]);
    expect(await getConsent(db, T, P)).toEqual(row);
    const { db: db2 } = makeDb([[]]);
    expect(await getConsent(db2, T, P)).toBeNull();
  });
});
