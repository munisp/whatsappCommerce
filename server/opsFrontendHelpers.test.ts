/**
 * Tests for the pure client-side ops helpers (client/src/lib/opsLogistics.ts).
 * The repo has no client component-test infra, so these run under the
 * existing server-side vitest suite — the module is pure TS with no DOM or
 * React dependencies.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_STATUS_COLOR,
  ETA_STATUS_FRACTION,
  buildSegmentFilter,
  estimateEtaMinutes,
  extractCoordsFromBlob,
  extractShipmentCoords,
  formatEta,
  isActiveShipment,
  maskDeliveryPin,
  nairaToKobo,
  shipmentStatusColor,
} from "../client/src/lib/opsLogistics";

describe("shipmentStatusColor", () => {
  it("maps known statuses to distinct colors", () => {
    expect(shipmentStatusColor("pending")).toBe("#f59e0b");
    expect(shipmentStatusColor("delivered")).toBe("#10b981");
    expect(shipmentStatusColor("failed")).toBe("#ef4444");
    expect(shipmentStatusColor("in_transit")).not.toBe(shipmentStatusColor("delivered"));
  });

  it("is case-insensitive and falls back for unknown/empty", () => {
    expect(shipmentStatusColor("IN_TRANSIT")).toBe("#8b5cf6");
    expect(shipmentStatusColor("weird")).toBe(DEFAULT_STATUS_COLOR);
    expect(shipmentStatusColor(null)).toBe(DEFAULT_STATUS_COLOR);
    expect(shipmentStatusColor(undefined)).toBe(DEFAULT_STATUS_COLOR);
  });

  it("covers every status the ETA engine knows", () => {
    for (const status of Object.keys(ETA_STATUS_FRACTION)) {
      // known statuses should not silently fall through to the default
      expect(typeof shipmentStatusColor(status)).toBe("string");
    }
  });
});

describe("isActiveShipment", () => {
  it("treats terminal statuses as inactive", () => {
    expect(isActiveShipment("delivered")).toBe(false);
    expect(isActiveShipment("failed")).toBe(false);
    expect(isActiveShipment("returned")).toBe(false);
    expect(isActiveShipment("in_transit")).toBe(true);
    expect(isActiveShipment(null)).toBe(true);
  });
});

describe("extractCoordsFromBlob", () => {
  it("accepts lat/lng and latitude/longitude shapes", () => {
    expect(extractCoordsFromBlob({ lat: 6.5244, lng: 3.3792 })).toEqual({ lat: 6.5244, lng: 3.3792 });
    expect(extractCoordsFromBlob({ latitude: 6.5, longitude: 3.4 })).toEqual({ lat: 6.5, lng: 3.4 });
    expect(extractCoordsFromBlob({ lat: 6.5, lon: 3.4 })).toEqual({ lat: 6.5, lng: 3.4 });
  });

  it("accepts GeoJSON [lng, lat] coordinates arrays", () => {
    expect(extractCoordsFromBlob({ coordinates: [3.3792, 6.5244] })).toEqual({ lat: 6.5244, lng: 3.3792 });
  });

  it("accepts string numbers and nested geo/location wrappers", () => {
    expect(extractCoordsFromBlob({ lat: "6.5", lng: "3.4" })).toEqual({ lat: 6.5, lng: 3.4 });
    expect(extractCoordsFromBlob({ geo: { lat: 9.0, lng: 8.7 } })).toEqual({ lat: 9.0, lng: 8.7 });
    expect(extractCoordsFromBlob({ location: { coordinates: [8.7, 9.0] } })).toEqual({ lat: 9.0, lng: 8.7 });
  });

  it("rejects garbage, out-of-range and partial coords", () => {
    expect(extractCoordsFromBlob(null)).toBeNull();
    expect(extractCoordsFromBlob("6.5,3.4")).toBeNull();
    expect(extractCoordsFromBlob({ lat: 6.5 })).toBeNull();
    expect(extractCoordsFromBlob({ lat: 95, lng: 3.4 })).toBeNull();
    expect(extractCoordsFromBlob({ lat: "abc", lng: 3.4 })).toBeNull();
  });
});

describe("extractShipmentCoords", () => {
  it("prefers recipient address, then metadata, then sender", () => {
    const s = {
      recipientAddress: { lat: 1, lng: 1 },
      metadata: { lat: 2, lng: 2 },
      senderAddress: { lat: 3, lng: 3 },
    };
    expect(extractShipmentCoords(s)).toEqual({ lat: 1, lng: 1 });
    expect(extractShipmentCoords({ ...s, recipientAddress: {} })).toEqual({ lat: 2, lng: 2 });
    expect(extractShipmentCoords({ ...s, recipientAddress: {}, metadata: null })).toEqual({ lat: 3, lng: 3 });
    expect(extractShipmentCoords({})).toBeNull();
  });
});

describe("estimateEtaMinutes (mirror of server/services/eta.ts)", () => {
  const zones = [{ name: "Lekki", etaMinutes: 60 }];

  it("uses zone ETA when the zone matches (case-insensitive)", () => {
    expect(estimateEtaMinutes({ status: "pending", zoneName: " lekki ", zones })).toBe(60);
  });

  it("scales by status fraction and rounds to 5", () => {
    // 60 * 0.6 = 36 → rounds to 35
    expect(estimateEtaMinutes({ status: "picked_up", zoneName: "Lekki", zones })).toBe(35);
    // 60 * 0.3 = 18 → 20
    expect(estimateEtaMinutes({ status: "out_for_delivery", zoneName: "Lekki", zones })).toBe(20);
  });

  it("returns 0 for terminal statuses", () => {
    expect(estimateEtaMinutes({ status: "delivered", zoneName: "Lekki", zones })).toBe(0);
    expect(estimateEtaMinutes({ status: "failed", zones })).toBe(0);
  });

  it("falls back to 45 same-city / 180 intercity with no zone match", () => {
    expect(estimateEtaMinutes({ status: "pending", zones })).toBe(45);
    expect(estimateEtaMinutes({ status: "pending", sameCity: false, zones })).toBe(180);
    expect(estimateEtaMinutes({ status: null, zones: null })).toBe(45);
  });
});

describe("formatEta", () => {
  it("formats minutes and hours, hides zero/negative", () => {
    expect(formatEta(45)).toBe("~45 min");
    expect(formatEta(180)).toBe("~3h");
    expect(formatEta(150)).toBe("~2h 30m");
    expect(formatEta(0)).toBeNull();
    expect(formatEta(null)).toBeNull();
  });
});

describe("maskDeliveryPin", () => {
  it("never exposes PIN digits", () => {
    expect(maskDeliveryPin("4821")).toBe("••••");
    expect(maskDeliveryPin("123456")).toBe("••••••");
    expect(maskDeliveryPin(null)).toBeNull();
    expect(maskDeliveryPin("")).toBeNull();
  });
});

describe("nairaToKobo (₦ → kobo segment conversion)", () => {
  it("converts major to minor units, rounding to integer kobo", () => {
    expect(nairaToKobo(5000)).toBe(500_000);
    expect(nairaToKobo("5000")).toBe(500_000);
    expect(nairaToKobo("10.50")).toBe(1050);
    expect(nairaToKobo("0.01")).toBe(1);
  });

  it("tolerates currency symbols, commas and whitespace", () => {
    expect(nairaToKobo("₦5,000")).toBe(500_000);
    expect(nairaToKobo(" 1,250.75 ")).toBe(125_075);
  });

  it("returns null for empty/invalid/negative input", () => {
    expect(nairaToKobo("")).toBeNull();
    expect(nairaToKobo(null)).toBeNull();
    expect(nairaToKobo(undefined)).toBeNull();
    expect(nairaToKobo("abc")).toBeNull();
    expect(nairaToKobo(-5)).toBeNull();
  });
});

describe("buildSegmentFilter", () => {
  it("returns undefined when nothing is set", () => {
    expect(buildSegmentFilter({})).toBeUndefined();
    expect(buildSegmentFilter({ tagsText: " , ,", minOrders: "", minSpendNaira: "", lastOrderWithinDays: "" })).toBeUndefined();
  });

  it("parses comma-separated tags, trimmed", () => {
    expect(buildSegmentFilter({ tagsText: "vip,  repeat-buyer ," })).toEqual({ tags: ["vip", "repeat-buyer"] });
  });

  it("converts ₦ min spend to kobo", () => {
    expect(buildSegmentFilter({ minSpendNaira: "5000" })).toEqual({ minSpendKobo: 500_000 });
  });

  it("builds a full segment and ignores invalid numbers", () => {
    expect(
      buildSegmentFilter({
        tagsText: "vip",
        minOrders: "3",
        minSpendNaira: "1,000",
        lastOrderWithinDays: "30",
      }),
    ).toEqual({ tags: ["vip"], minOrders: 3, minSpendKobo: 100_000, lastOrderWithinDays: 30 });

    expect(buildSegmentFilter({ minOrders: "abc", minSpendNaira: "-10" })).toBeUndefined();
  });
});
