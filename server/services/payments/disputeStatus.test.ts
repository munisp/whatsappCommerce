import { describe, expect, it } from "vitest";
import { paystackDisputeStatus } from "./disputes";

describe("paystackDisputeStatus (AF-03)", () => {
  it("a declined dispute is a merchant WIN, not a loss", () => {
    expect(paystackDisputeStatus("charge.dispute.resolve", "declined")).toBe("won");
  });
  it("merchant-accepted means the merchant conceded", () => {
    expect(paystackDisputeStatus("charge.dispute.resolve", "merchant-accepted")).toBe("accepted");
  });
  it("an unrecognised resolution stays open for a human instead of being reported as lost", () => {
    expect(paystackDisputeStatus("charge.dispute.resolve", "")).toBe("open");
    expect(paystackDisputeStatus("charge.dispute.resolve", "something-new")).toBe("open");
  });
  it("create / remind events are open", () => {
    expect(paystackDisputeStatus("charge.dispute.create", "declined")).toBe("open");
    expect(paystackDisputeStatus("charge.dispute.remind", undefined)).toBe("open");
  });
});
