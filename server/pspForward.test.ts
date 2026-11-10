import { describe, it, expect, vi, afterEach } from "vitest";
import { paystackForwardTargets, paystackForwardTarget, forwardPaystackWebhook } from "./services/payments/pspForward";

const T = JSON.stringify({ volumeos: "http://svc-collections.volumeos.svc.cluster.local/v1/collections/webhooks/paystack" });

describe("Paystack webhook forwarding for other platforms on the shared account", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("routes an event tagged with a configured platform to that platform", () => {
    const targets = paystackForwardTargets(T);
    expect(paystackForwardTarget({ event: "charge.success", data: { reference: "bk-1", metadata: { tenant_id: "bolas-kitchen", platform: "volumeos" } } }, targets))
      .toBe("http://svc-collections.volumeos.svc.cluster.local/v1/collections/webhooks/paystack");
  });

  it("keeps OAK's own payments (tenant_id + payment_intent_id, no platform) in OAK", () => {
    const targets = paystackForwardTargets(T);
    expect(paystackForwardTarget({ event: "charge.success", data: { metadata: { tenant_id: "t1", payment_intent_id: "pi-1" } } }, targets)).toBeNull();
    expect(paystackForwardTarget({ event: "charge.success", data: {} }, targets)).toBeNull();
  });

  it("ignores platforms nobody configured, and bad or unsafe configuration", () => {
    expect(paystackForwardTarget({ data: { metadata: { platform: "kampusforce" } } }, paystackForwardTargets(T))).toBeNull();
    expect(paystackForwardTargets("not json")).toEqual({});
    expect(paystackForwardTargets(JSON.stringify({ oak: "http://x", volumeos: "ftp://x", "Bad Name": "http://x" }))).toEqual({});
    expect(paystackForwardTargets(undefined)).toEqual({});
  });

  it("forwards Paystack's exact body and signature, and reports the receiver's status", async () => {
    const seen: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: any) => { seen.push({ url, init }); return new Response("{}", { status: 200 }); }));
    const body = Buffer.from('{"event":"charge.success","data":{"reference":"bk-1"}}');
    expect(await forwardPaystackWebhook("http://receiver/hook", body, "abc123")).toBe(200);
    expect(seen[0].init.headers["x-paystack-signature"]).toBe("abc123");
    expect(Buffer.from(seen[0].init.body).equals(body)).toBe(true);
  });

  it("reports 0 when the receiver can't be reached, so OAK answers 502 and Paystack retries", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("connect ECONNREFUSED"); }));
    expect(await forwardPaystackWebhook("http://receiver/hook", Buffer.from("{}"), "sig")).toBe(0);
  });
});
