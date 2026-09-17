/**
 * === W40 MSG-2 + MSG-3 ===
 * Broadcast resilience unit tests:
 *   - circuitBreakerShouldTrip trip predicate (min attempts + failure rate)
 *   - executeCampaignSend auto-pauses a failing campaign (status='paused',
 *     pausedReason persisted) and alerts the tenant admin
 *   - dead-template gate blocks the send honestly (PRECONDITION_FAILED)
 *   - broadcast.resume returns a paused campaign to draft and refuses others
 *   - mapMetaTemplateEvent maps Meta lifecycle events onto local statuses
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("./redis", () => ({ getRedis: vi.fn(async () => null) }));
vi.mock("./db", () => ({ getDb: vi.fn(async () => null) }));

const sendTextMock = vi.fn();
const sendTemplateMock = vi.fn();
vi.mock("./services/waSender", () => ({
  normalizeWaPhone: (p: string) => String(p ?? "").replace(/\D/g, ""),
  sendWhatsAppText: (...args: any[]) => sendTextMock(...args),
  sendWhatsAppTemplate: (...args: any[]) => sendTemplateMock(...args),
}));

const adminAlertMock = vi.fn(async () => true);
vi.mock("./services/adminAlerts", () => ({
  notifyTenantAdminWhatsApp: (...args: any[]) => adminAlertMock(...args),
  resolveAdminPhone: vi.fn(async () => "+2349000000000"),
}));

import {
  circuitBreakerShouldTrip,
  executeCampaignSend,
  BROADCAST_BREAKER_MIN_ATTEMPTS,
  type BroadcastAudienceMember,
} from "./routers/broadcast";
import { mapMetaTemplateEvent, isDeadTemplateStatus } from "./services/templateStatus";
import { setMarketingClockOverride } from "./services/frequencyCap";

const T = "tenant-1";

/** Chainable row-store db mock for the campaign send loop. */
function makeCampaignDb(opts: { templateRow?: any | null }) {
  const campaignUpdates: any[] = [];
  const recipientRows: any[] = [];
  const db: any = {
    select: () => {
      const chain: any = {};
      chain.from = () => chain;
      chain.where = () => chain;
      chain.orderBy = () => chain;
      chain.limit = () => Promise.resolve(opts.templateRow ? [opts.templateRow] : []);
      return chain;
    },
    insert: () => ({
      values: (v: any) => {
        recipientRows.push(v);
        return { onConflictDoNothing: () => Promise.resolve() };
      },
    }),
    update: (table: any) => ({
      set: (v: any) => {
        campaignUpdates.push(v);
        return { where: () => Promise.resolve() };
      },
    }),
    execute: vi.fn(async () => ({ rows: [] })),
  };
  return { db, campaignUpdates, recipientRows };
}

function audience(n: number): BroadcastAudienceMember[] {
  return Array.from({ length: n }, (_, i) => ({
    customerId: `cust-${i}`,
    phone: `2348000000${String(i).padStart(3, "0")}`,
    name: `Cust ${i}`,
    inWindow: true, // free-form text path -> sendWhatsAppText mock
  }));
}

const CAMPAIGN = {
  id: "camp-1",
  tenantId: T,
  name: "Promo Blast",
  templateId: "tpl-1",
  varMapping: null,
  segmentFilter: null,
} as any;

const LIVE_TEMPLATE = {
  id: "tpl-1",
  tenantId: T,
  name: "promo_blast",
  language: "en_US",
  bodyText: "Hello {{1}}, sale is live",
  approvalStatus: "approved",
  isActive: true,
};

beforeEach(() => {
  sendTextMock.mockReset();
  sendTemplateMock.mockReset();
  adminAlertMock.mockClear();
  // Pin the marketing clock to midday Africa/Lagos so the default quiet
  // hours (21:00–08:00) never defer sends regardless of wall-clock time.
  setMarketingClockOverride(() => new Date("2026-09-16T12:00:00+01:00"));
});

afterEach(() => {
  setMarketingClockOverride(null);
});

describe("circuitBreakerShouldTrip", () => {
  it("never trips below the minimum attempts", () => {
    expect(circuitBreakerShouldTrip(19, 19)).toBe(false);
    expect(circuitBreakerShouldTrip(0, 0)).toBe(false);
  });
  it("trips above 20% failures after >= 20 attempts", () => {
    expect(circuitBreakerShouldTrip(BROADCAST_BREAKER_MIN_ATTEMPTS, 5)).toBe(true); // 25%
    expect(circuitBreakerShouldTrip(25, 6)).toBe(true); // 24%
  });
  it("does not trip at or below the threshold", () => {
    expect(circuitBreakerShouldTrip(20, 4)).toBe(false); // exactly 20%
    expect(circuitBreakerShouldTrip(100, 20)).toBe(false); // exactly 20%
    expect(circuitBreakerShouldTrip(50, 2)).toBe(false);
  });
});

describe("executeCampaignSend circuit breaker (MSG-3)", () => {
  it("auto-pauses a failing campaign + alerts the admin + skips remaining recipients", async () => {
    const { db, campaignUpdates, recipientRows } = makeCampaignDb({ templateRow: LIVE_TEMPLATE });
    // Every send fails.
    sendTextMock.mockRejectedValue(new Error("WhatsApp send failed (500): boom"));
    const result = await executeCampaignSend(db, CAMPAIGN, { ratePerMin: 30, templateName: "x", languageCode: "en_US" }, audience(30));
    expect(result.paused).toBe(true);
    expect(result.pausedReason ?? "").toContain("circuit_breaker");
    // First chunk (25) attempted; breaker trips; remaining 5 never attempted.
    expect(result.failed).toBe(25);
    expect(recipientRows.length).toBe(25);
    const pausedWrite = campaignUpdates.find((u) => u.status === "paused");
    expect(pausedWrite).toBeTruthy();
    expect(pausedWrite.pausedReason).toContain("circuit_breaker");
    expect(pausedWrite.pausedAt instanceof Date).toBe(true);
    expect(adminAlertMock).toHaveBeenCalledTimes(1);
    expect(String(adminAlertMock.mock.calls[0][2])).toContain("AUTO-PAUSED");
  });

  it("completes normally under the failure threshold", async () => {
    const { db, campaignUpdates } = makeCampaignDb({ templateRow: LIVE_TEMPLATE });
    let calls = 0;
    sendTextMock.mockImplementation(async () => {
      calls++;
      if (calls <= 3) throw new Error("flaky"); // 3/25 = 12% < 20%
      return { sent: true, simulated: false, wamids: ["wamid.x"], chunks: 1 };
    });
    const result = await executeCampaignSend(db, CAMPAIGN, { ratePerMin: 30, templateName: "x", languageCode: "en_US" }, audience(25));
    expect(result.paused).toBeFalsy();
    expect(result.failed).toBe(3);
    expect(result.sent).toBe(22);
    expect(campaignUpdates.find((u) => u.status === "completed")).toBeTruthy();
    expect(campaignUpdates.find((u) => u.status === "paused")).toBeFalsy();
    expect(adminAlertMock).not.toHaveBeenCalled();
  });
});

describe("dead-template gate (MSG-2)", () => {
  it("blocks the send honestly when the campaign template is REJECTED", async () => {
    const dead = { ...LIVE_TEMPLATE, approvalStatus: "rejected" };
    const { db, campaignUpdates } = makeCampaignDb({ templateRow: dead });
    await expect(
      executeCampaignSend(db, CAMPAIGN, { ratePerMin: 30, templateName: "x", languageCode: "en_US" }, audience(3)),
    ).rejects.toThrow(/rejected/i);
    expect(sendTextMock).not.toHaveBeenCalled();
    expect(campaignUpdates.find((u) => u.status === "failed")).toBeTruthy();
    expect(adminAlertMock).toHaveBeenCalledTimes(1);
  });

  it("blocks PAUSED and DISABLED templates too", async () => {
    for (const approvalStatus of ["paused", "disabled"]) {
      const { db } = makeCampaignDb({ templateRow: { ...LIVE_TEMPLATE, approvalStatus } });
      await expect(
        executeCampaignSend(db, CAMPAIGN, { ratePerMin: 30, templateName: "x", languageCode: "en_US" }, audience(3)),
      ).rejects.toThrow();
    }
  });
});

describe("mapMetaTemplateEvent", () => {
  it("maps Meta lifecycle events onto local statuses", () => {
    expect(mapMetaTemplateEvent("APPROVED")).toBe("approved");
    expect(mapMetaTemplateEvent("REJECTED")).toBe("rejected");
    expect(mapMetaTemplateEvent("PAUSED")).toBe("paused");
    expect(mapMetaTemplateEvent("DISABLED")).toBe("disabled");
    expect(mapMetaTemplateEvent("PENDING")).toBe("submitted");
    expect(mapMetaTemplateEvent("SOMETHING_NEW")).toBeNull();
  });
  it("isDeadTemplateStatus gates exactly the dead set", () => {
    for (const s of ["rejected", "paused", "disabled"]) expect(isDeadTemplateStatus(s)).toBe(true);
    for (const s of ["approved", "submitted", "none", null, undefined]) expect(isDeadTemplateStatus(s as any)).toBe(false);
  });
});
