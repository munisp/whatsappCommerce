/** A web store link on the shared number must reach the right shop. Simulated inbound only: nothing is sent. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ active: new Map<string, string>(), shops: new Map<string, { tenantId: string; slug: string; name: string }>(), rows: new Map<string, object>(), sent: [] as string[] }));

vi.mock("./services/platformNumber", async (original) => ({
  ...(await original<typeof import("./services/platformNumber")>()),
  resolveShopRef: async (ref: string) => state.shops.get(ref) ?? null,
  getActiveShop: async (phone: string) => state.active.get(phone) ?? null,
  setActiveShop: async (phone: string, id: string) => void state.active.set(phone, id),
  clearActiveShop: async (phone: string) => void state.active.delete(phone),
  resolvePlatformWaCredentialsFull: async () => null,
}));
/** Finds the tenant id inside a drizzle condition by walking it. */
function idIn(node: unknown, seen = new Set<unknown>()): string | null {
  if (typeof node === "string") return state.rows.has(node) ? node : null;
  if (!node || typeof node !== "object" || seen.has(node)) return null;
  seen.add(node);
  for (const value of Object.values(node)) {
    const hit = idIn(value, seen);
    if (hit) return hit;
  }
  return null;
}
vi.mock("./db", () => ({
  getDb: async () => ({
    select: () => ({ from: () => ({ where: (w: unknown) => ({ limit: async () => { const id = idIn(w); return id ? [state.rows.get(id)] : []; } }) }) }),
  }),
}));

import { platformActiveShop } from "./services/platformInbound";

const PHONE = "2348000000999";
const row = (id: string) => ({ id, status: "active", whatsappPhoneNumberId: null });

describe("store links on the shared number", () => {
  beforeEach(() => {
    state.active.clear(); state.shops.clear(); state.rows.clear();
    for (const [id, slug] of [["tenant-a", "shop-a"], ["tenant-b", "shop-b"]] as const) {
      state.shops.set(slug, { tenantId: id, slug, name: slug });
      state.rows.set(id, row(id));
    }
  });

  it("takes the customer to the named shop, with only their own words", async () => {
    const out = await platformActiveShop({ customerPhone: PHONE, text: "Shop: shop-b\nI'd like the Ankara gown" });
    expect(out?.shopRow.id).toBe("tenant-b");
    expect(out?.text).toBe("I'd like the Ankara gown");
    expect(state.active.get(PHONE)).toBe("tenant-b");
  });

  it("moves a customer who was chatting with another shop", async () => {
    state.active.set(PHONE, "tenant-a");
    const out = await platformActiveShop({ customerPhone: PHONE, text: "Shop: shop-b\nHello" });
    expect(out?.shopRow.id).toBe("tenant-b");
    expect(state.active.get(PHONE)).toBe("tenant-b");
  });

  it("an empty message still opens the conversation", async () => {
    expect((await platformActiveShop({ customerPhone: PHONE, text: "Shop: shop-a" }))?.text).toBe("Hi");
  });

  it("an unknown shop falls back to the directory and leaves the customer where they were", async () => {
    state.active.set(PHONE, "tenant-a");
    expect(await platformActiveShop({ customerPhone: PHONE, text: "Shop: nope\nHello" })).toBeNull();
    expect(state.active.get(PHONE)).toBe("tenant-a");
  });

  it("ordinary messages keep going to the shop they're already in", async () => {
    state.active.set(PHONE, "tenant-a");
    const out = await platformActiveShop({ customerPhone: PHONE, text: "2 of the blue one please" });
    expect(out?.shopRow.id).toBe("tenant-a");
    expect(out?.text).toBeUndefined();
  });

  it("someone outside any shop stays in the directory", async () => {
    expect(await platformActiveShop({ customerPhone: PHONE, text: "toothpaste" })).toBeNull();
  });
});
