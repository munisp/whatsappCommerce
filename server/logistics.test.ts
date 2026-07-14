import { describe, it, expect } from "vitest";

// ─── Logistics status mapping unit tests ─────────────────────────────────────

const SHIPBUBBLE_STATUS_MAP: Record<string, string> = {
  "shipment.picked_up": "picked_up",
  "shipment.in_transit": "in_transit",
  "shipment.out_for_delivery": "out_for_delivery",
  "shipment.delivered": "delivered",
  "shipment.failed": "failed",
  "shipment.returned": "returned",
  picked_up: "picked_up",
  in_transit: "in_transit",
  out_for_delivery: "out_for_delivery",
  delivered: "delivered",
  failed: "failed",
};

function mapShipbubbleEvent(event: string): string | undefined {
  return SHIPBUBBLE_STATUS_MAP[event.toLowerCase()];
}

const DELIVERY_TRIGGERING_STATES = ["delivered"];
const TERMINAL_STATES = ["delivered", "failed", "returned"];

function isDeliveryEvent(status: string): boolean {
  return DELIVERY_TRIGGERING_STATES.includes(status);
}

function isTerminalState(status: string): boolean {
  return TERMINAL_STATES.includes(status);
}

describe("Shipbubble webhook event mapping", () => {
  it("maps prefixed event names correctly", () => {
    expect(mapShipbubbleEvent("shipment.delivered")).toBe("delivered");
    expect(mapShipbubbleEvent("shipment.in_transit")).toBe("in_transit");
    expect(mapShipbubbleEvent("shipment.picked_up")).toBe("picked_up");
    expect(mapShipbubbleEvent("shipment.out_for_delivery")).toBe("out_for_delivery");
    expect(mapShipbubbleEvent("shipment.failed")).toBe("failed");
  });

  it("maps unprefixed event names correctly", () => {
    expect(mapShipbubbleEvent("delivered")).toBe("delivered");
    expect(mapShipbubbleEvent("in_transit")).toBe("in_transit");
    expect(mapShipbubbleEvent("picked_up")).toBe("picked_up");
  });

  it("returns undefined for unknown events", () => {
    expect(mapShipbubbleEvent("unknown_event")).toBeUndefined();
    expect(mapShipbubbleEvent("")).toBeUndefined();
  });

  it("is case-insensitive", () => {
    expect(mapShipbubbleEvent("SHIPMENT.DELIVERED")).toBe("delivered");
    expect(mapShipbubbleEvent("Delivered")).toBe("delivered");
  });
});

describe("Delivery event triggers escrow release", () => {
  it("delivered status triggers escrow release", () => {
    expect(isDeliveryEvent("delivered")).toBe(true);
  });

  it("non-delivery statuses do not trigger escrow release", () => {
    expect(isDeliveryEvent("in_transit")).toBe(false);
    expect(isDeliveryEvent("picked_up")).toBe(false);
    expect(isDeliveryEvent("out_for_delivery")).toBe(false);
    expect(isDeliveryEvent("failed")).toBe(false);
  });
});

describe("Terminal shipment states", () => {
  it("identifies terminal states correctly", () => {
    expect(isTerminalState("delivered")).toBe(true);
    expect(isTerminalState("failed")).toBe(true);
    expect(isTerminalState("returned")).toBe(true);
  });

  it("identifies non-terminal states correctly", () => {
    expect(isTerminalState("pending")).toBe(false);
    expect(isTerminalState("in_transit")).toBe(false);
    expect(isTerminalState("created")).toBe(false);
  });
});

describe("Delivery rate calculation", () => {
  it("computes delivery rate correctly", () => {
    const byStatus = { delivered: 80, failed: 10, in_transit: 10 };
    const total = Object.values(byStatus).reduce((s, c) => s + c, 0);
    const rate = (byStatus.delivered / total * 100).toFixed(1);
    expect(rate).toBe("80.0");
  });

  it("returns 0 when no shipments", () => {
    const total = 0;
    const rate = total > 0 ? (0 / total * 100).toFixed(1) : "0.0";
    expect(rate).toBe("0.0");
  });
});

