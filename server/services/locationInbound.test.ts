/**
 * W25 locationInbound tests — pin → discovery menu flow.
 *
 * Hermetic: ../db is mocked with the generic in-memory drizzle fake and
 * ./geoDiscovery is vi.mock'ed so no real DB or geo data is touched.
 *
 * Covers:
 *  - pin with results → sponsored-first menu + lastDiscovery persisted
 *  - zero results → save-as-default fallback unchanged
 *  - awaiting-address checkout path untouched (no discovery, coords patched)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeSoc2FakeDb } from "./testUtils/soc2FakeDb";
import { nlpSessions, orders } from "../../drizzle/schema";

vi.mock("./geoDiscovery", () => ({
  defaultRadiusKm: () => 5,
  discoverNearby: vi.fn(),
}));

vi.mock("../db", () => ({ getDb: vi.fn() }));

vi.mock("../routers", () => ({
  appRouter: {
    createCaller: () => ({ nlp: { processMessage: processMessageMock } }),
  },
}));
const processMessageMock = vi.fn();

import { getDb } from "../db";
import { discoverNearby } from "./geoDiscovery";
import { handleInboundLocationMessage } from "./locationInbound";

const discoverNearbyMock = vi.mocked(discoverNearby);

const PIN = { latitude: 6.5244, longitude: 3.3792, name: null, address: null };

function seed(rows: { sessions?: any[]; orders?: any[] }) {
  const store = new Map<any, any[]>([
    [nlpSessions, rows.sessions ?? []],
    [orders, rows.orders ?? []],
  ]);
  const db = makeSoc2FakeDb(store);
  vi.mocked(getDb).mockResolvedValue(db);
  return { db, store };
}

function discoverItem(partial: Record<string, unknown>) {
  return {
    tenantId: "t1",
    businessName: "Shop",
    category: "Food",
    distanceKm: 1,
    sponsored: false,
    trustScore: null,
    rating: null,
    openNow: null,
    score: 0,
    ...partial,
  };
}

beforeEach(() => {
  discoverNearbyMock.mockReset();
  processMessageMock.mockReset();
});

describe("pin → discovery menu", () => {
  it("returns a sponsored-first menu and persists lastDiscovery + deliveryCoords", async () => {
    const { store } = seed({
      sessions: [{
        id: "s1", tenantId: "t1", waPhoneNumber: "234800",
        state: "browse", context: {}, messageHistory: [],
        lastActivityAt: new Date("2025-01-01"),
      }],
    });
    discoverNearbyMock.mockResolvedValue({
      items: [
        discoverItem({ tenantId: "t-org", businessName: "Organic Spot", distanceKm: 0.3 }),
        discoverItem({ tenantId: "t-ad", businessName: "Paid Place", sponsored: true, distanceKm: 1.2 }),
      ],
      total: 2, page: 0, pageSize: 20, hasMore: false, radiusKm: 5,
    });

    const outcome = await handleInboundLocationMessage({
      tenantId: "t1", waPhoneNumber: "234800", location: PIN,
    });

    expect(outcome.handled).toBe(true);
    expect(outcome.discoveryOffered).toBe(true);
    expect(outcome.savedAsDefault).toBeUndefined();
    expect(discoverNearbyMock).toHaveBeenCalledWith(
      { lat: PIN.latitude, lng: PIN.longitude, radiusKm: 5 },
      expect.anything(),
    );
    const rows = outcome.reply!.split("\n");
    expect(rows[0]).toContain("within 5 km");
    expect(rows[1]).toContain("★ Sponsored: Paid Place");
    expect(rows[2]).toContain("Organic Spot");
    expect(outcome.reply).toContain("Reply with a category to filter");

    const session = (store.get(nlpSessions) as any[]).find((s) => s.id === "s1");
    expect(session.context.lastDiscovery).toEqual({ lat: PIN.latitude, lng: PIN.longitude, radiusKm: 5 });
    expect(session.context.deliveryCoords).toEqual({ latitude: PIN.latitude, longitude: PIN.longitude });
    expect(session.context.deliveryAddress).toBe("6.524400, 3.379200");
  });

  it("creates a session when none exists and still offers discovery", async () => {
    const { store } = seed({});
    discoverNearbyMock.mockResolvedValue({
      items: [discoverItem({ businessName: "Solo Shop" })],
      total: 1, page: 0, pageSize: 20, hasMore: false, radiusKm: 5,
    });
    const outcome = await handleInboundLocationMessage({
      tenantId: "t1", waPhoneNumber: "234800", location: PIN, customerName: "Ada",
    });
    expect(outcome.discoveryOffered).toBe(true);
    const sessions = store.get(nlpSessions) as any[];
    expect(sessions).toHaveLength(1);
    expect(sessions[0].context.lastDiscovery).toEqual({ lat: PIN.latitude, lng: PIN.longitude, radiusKm: 5 });
  });
});

describe("zero results → save-as-default fallback", () => {
  it("keeps the original default-address behavior", async () => {
    const { store } = seed({});
    discoverNearbyMock.mockResolvedValue({
      items: [], total: 0, page: 0, pageSize: 20, hasMore: false, radiusKm: 5,
    });
    const outcome = await handleInboundLocationMessage({
      tenantId: "t1", waPhoneNumber: "234800", location: PIN,
    });
    expect(outcome.handled).toBe(true);
    expect(outcome.savedAsDefault).toBe(true);
    expect(outcome.discoveryOffered).toBeUndefined();
    expect(outcome.reply).toContain("default delivery address");
    const sessions = store.get(nlpSessions) as any[];
    expect(sessions).toHaveLength(1);
    expect(sessions[0].context.deliveryCoords).toEqual({ latitude: PIN.latitude, longitude: PIN.longitude });
    expect(sessions[0].context.lastDiscovery).toBeUndefined();
  });
});

describe("awaiting-address checkout path", () => {
  it("feeds the pin through checkout unchanged and does not run discovery", async () => {
    const { store } = seed({
      sessions: [{
        id: "s1", tenantId: "t1", waPhoneNumber: "234800",
        state: "checkout_address", context: { awaitingAddress: true },
        messageHistory: [], lastActivityAt: new Date("2025-01-01"),
      }],
      orders: [{ id: "o1", metadata: {}, shippingAddress: {} }],
    });
    processMessageMock.mockResolvedValue({
      reply: "Order created!",
      orderCard: { orderId: "o1", orderNumber: "ORD-1", paymentUrl: null },
    });

    const outcome = await handleInboundLocationMessage({
      tenantId: "t1", waPhoneNumber: "234800",
      location: { ...PIN, name: "Home", address: "12 Broad St" },
    });

    expect(discoverNearbyMock).not.toHaveBeenCalled();
    expect(processMessageMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: "t1",
      message: "Home, 12 Broad St",
    }));
    expect(outcome.orderCard).toEqual({ orderId: "o1", orderNumber: "ORD-1", paymentUrl: null });
    expect(outcome.discoveryOffered).toBeUndefined();
    expect(outcome.savedAsDefault).toBeUndefined();
  });
});
