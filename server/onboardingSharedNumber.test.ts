import { afterEach, describe, expect, it } from "vitest";
import { runTenantValidation } from "./services/onboarding";

const neverCalled = (async () => { throw new Error("no Graph call expected"); }) as unknown as typeof fetch;

describe("validation for a shop on the shared number", () => {
  afterEach(() => { delete process.env.WHATSAPP_PLATFORM_NUMBER_ID; });
  it("passes WhatsApp without a number of its own when the shared number is set up", async () => {
    process.env.WHATSAPP_PLATFORM_NUMBER_ID = "pn_platform";
    const r = await runTenantValidation({ id: "t1", whatsappPhoneNumberId: null, settings: {} }, neverCalled);
    const wa = r.checks.find((c) => c.check === "whatsapp");
    expect(wa?.ok).toBe(true);
  });
  it("still fails a shop with no number when there is no shared number", async () => {
    const r = await runTenantValidation({ id: "t1", whatsappPhoneNumberId: null, settings: {} }, neverCalled);
    expect(r.checks.find((c) => c.check === "whatsapp")?.ok).toBe(false);
  });
});
