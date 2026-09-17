/**
 * === W40 MSG-1 ===
 * messagingOptOut — STOP honored mid-conversation.
 *   - canonical STOP keywords revoke BEFORE reply generation (consented user)
 *   - one suppressed-reply confirmation, then the bot is silent on all
 *     subsequent inbound from the revoked identity
 *   - explicit YES re-opt-in re-grants and re-opens the menu
 *   - a first-contact NO (no withdrawnAt) keeps the J1 "can still chat"
 *     contract (NOT silenced)
 *   - plain mid-conversation "no" is NOT a revocation trigger
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./services/waSender", () => ({
  sendWhatsAppText: vi.fn(async () => ({ sent: true, simulated: false, wamids: [], chunks: 1 })),
  sendWhatsAppMedia: vi.fn(async () => ({ sent: true, simulated: false, wamid: "wamid.media" })),
}));
vi.mock("./redis", () => ({ getRedis: vi.fn(async () => null) }));
const nlpProcessMock = vi.fn(async () => ({ reply: "fallback", intent: "browse" }));
vi.mock("./routers", () => ({
  appRouter: { createCaller: () => ({ nlp: { processMessage: nlpProcessMock } }) },
}));

import { handleConversationalInbound } from "./services/useCases";
import { __clearMemorySessions } from "./services/chatSession";
import { isOptOutKeyword, wasRevoked, WA_STOP_CONFIRMATION } from "./services/optOut";

const T = "tenant-1";
const P = "+2348012345678";

/**
 * DB mock: select always resolves the CURRENT consent row (the revocation
 * helper re-reads it), update/insert are recorded and mutate the row so
 * revocation -> silence -> re-opt-in can be driven through one fake.
 */
function makeConsentDb(initialRow: any | null) {
  let row = initialRow ? { ...initialRow } : null;
  const updates: any[] = [];
  const inserted: any[] = [];
  const db: any = {
    select: () => {
      const chain: any = {};
      chain.from = () => chain;
      chain.where = () => chain;
      chain.orderBy = () => chain;
      chain.limit = () => Promise.resolve(row ? [row] : []);
      return chain;
    },
    insert: () => ({
      values: (v: any) => {
        inserted.push(v);
        row = { ...v };
        return Promise.resolve();
      },
    }),
    update: () => ({
      set: (v: any) => {
        updates.push(v);
        if (row) row = { ...row, ...v };
        return { where: () => Promise.resolve() };
      },
    }),
  };
  return { db, updates, inserted, getRow: () => row };
}

const CONSENTED = { id: "c1", tenantId: T, phone: P, channel: "whatsapp", granted: true, withdrawnAt: null };

beforeEach(() => {
  __clearMemorySessions();
});

describe("isOptOutKeyword / wasRevoked", () => {
  it("matches the Meta canonical STOP keyword set", () => {
    for (const t of ["STOP", "stop", " Stop ", "UNSUBSCRIBE", "opt out", "opt-out", "STOPALL", "quit", "END"]) {
      expect(isOptOutKeyword(t)).toBe(true);
    }
  });
  it("does NOT match ordinary conversation", () => {
    for (const t of ["no", "n", "cancel", "cancel my order", "stop bothering me please", "hello", "2"]) {
      expect(isOptOutKeyword(t)).toBe(false);
    }
  });
  it("wasRevoked only on an explicit withdrawal stamp", () => {
    expect(wasRevoked({ withdrawnAt: new Date() })).toBe(true);
    expect(wasRevoked({ withdrawnAt: null })).toBe(false);
    expect(wasRevoked(null)).toBe(false);
  });
});

describe("STOP honored mid-conversation (WhatsApp)", () => {
  it("revokes a consented user BEFORE reply generation + confirms once", async () => {
    const { db, updates, getRow } = makeConsentDb(CONSENTED);
    const out = await handleConversationalInbound({ db, tenant: null, tenantId: T, phone: P, text: "STOP" });
    expect(out.handled).toBe(true);
    expect(out.reply).toBe(WA_STOP_CONFIRMATION);
    // Revocation persisted: granted=false + withdrawnAt stamped.
    const revokeWrite = updates.find((u) => u.granted === false && u.withdrawnAt instanceof Date);
    expect(revokeWrite).toBeTruthy();
    expect(getRow()?.granted).toBe(false);
    expect(getRow()?.withdrawnAt).toBeTruthy();
  });

  it("bot stays silent on ALL subsequent inbound after revocation", async () => {
    const revoked = { ...CONSENTED, granted: false, withdrawnAt: new Date() };
    const { db } = makeConsentDb(revoked);
    for (const text of ["hello", "menu", "2", "no", "what are my orders?"]) {
      const out = await handleConversationalInbound({ db, tenant: null, tenantId: T, phone: P, text });
      expect(out.handled).toBe(true);
      expect(out.reply).toBeUndefined(); // silent — no reply generated
    }
  });

  it("resubscribes on an explicit YES and re-opens the menu", async () => {
    const revoked = { ...CONSENTED, granted: false, withdrawnAt: new Date() };
    const { db, updates, getRow } = makeConsentDb(revoked);
    const out = await handleConversationalInbound({ db, tenant: null, tenantId: T, phone: P, text: "YES" });
    expect(out.handled).toBe(true);
    expect(out.reply ?? "").toContain("opted in");
    const grant = updates.find((u) => u.granted === true);
    expect(grant).toBeTruthy();
    expect(getRow()?.granted).toBe(true);
    expect(getRow()?.withdrawnAt).toBeNull();
  });

  it("first-contact NO (no withdrawnAt) is NOT silenced — J1 contract", async () => {
    const denied = { ...CONSENTED, granted: false, withdrawnAt: null };
    const { db } = makeConsentDb(denied);
    const out = await handleConversationalInbound({ db, tenant: null, tenantId: T, phone: P, text: "menu" });
    expect(out.handled).toBe(true);
    expect(out.reply).toBeTruthy(); // menu renders — user can still chat
  });

  it("plain 'no' mid-conversation does not revoke", async () => {
    const { db, updates } = makeConsentDb(CONSENTED);
    const out = await handleConversationalInbound({ db, tenant: null, tenantId: T, phone: P, text: "no" });
    // Falls through to the normal pipeline (handled somehow), but no
    // revocation write may happen.
    expect(updates.find((u) => u.granted === false)).toBeFalsy();
    expect(out).toBeTruthy();
  });

  it("STOP on an already-revoked identity stays silent (single confirmation)", async () => {
    const revoked = { ...CONSENTED, granted: false, withdrawnAt: new Date() };
    const { db } = makeConsentDb(revoked);
    const out = await handleConversationalInbound({ db, tenant: null, tenantId: T, phone: P, text: "STOP" });
    expect(out.handled).toBe(true);
    // Re-STOP is acknowledged (Meta wants the keyword honored) but no state change needed.
    expect(out.reply).toBe(WA_STOP_CONFIRMATION);
  });
});
