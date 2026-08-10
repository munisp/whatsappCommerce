/**
 * w11 unified webhook route tests — valid webhook normalizes into the
 * existing confirm path; bad signature → 401 + capture, NEVER confirm.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHmac } from "node:crypto";

const { confirmMock, captureMock, getChainMock } = vi.hoisted(() => ({
  confirmMock: vi.fn(async (_db: any, _opts: any) => ({ ok: true, action: "confirmed" })),
  captureMock: vi.fn(),
  getChainMock: vi.fn(),
}));

vi.mock("../../../db", () => ({ getDb: async () => ({ __db: true }) }));
vi.mock("../../paymentConfirm", () => ({ confirmProviderPayment: confirmMock }));
vi.mock("../../observability", () => ({ captureException: captureMock }));
vi.mock("./registry", async (importActual) => {
  const actual = await importActual<typeof import("./registry")>();
  return { ...actual, getProviderForTenant: getChainMock };
});

import { handleUnifiedPaymentWebhook } from "./unifiedWebhook";

const CREDS = { secretKey: "sk_test", webhookSecret: "whsec" };

function makeReqRes(provider: string, raw: string, sig?: string) {
  const req: any = {
    params: { provider },
    headers: sig ? { "x-paystack-signature": sig } : {},
    body: Buffer.from(raw, "utf8"),
  };
  const res: any = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
  return { req, res };
}

function hmac(body: string, secret: string): string {
  return createHmac("sha512", secret).update(body).digest("hex");
}

describe("unified payment webhook", () => {
  beforeEach(() => {
    confirmMock.mockClear();
    captureMock.mockClear();
    getChainMock.mockReset();
    getChainMock.mockImplementation(async (tenantId: string) => [
      { provider: (await import("./registry")).getProviderAdapter("paystack")!, creds: CREDS, config: { priority: 0 } },
    ]);
  });

  it("valid paystack webhook → normalized into confirmProviderPayment", async () => {
    const payload = {
      event: "charge.success",
      data: { reference: "PAY-9", amount: 123456, currency: "NGN", metadata: { tenant_id: "t1" } },
    };
    const raw = JSON.stringify(payload);
    const { req, res } = makeReqRes("paystack", raw, hmac(raw, "whsec"));
    await handleUnifiedPaymentWebhook(req, res);
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(confirmMock).toHaveBeenCalledWith({ __db: true }, {
      provider: "paystack",
      reference: "PAY-9",
      amountMajor: 1234.56,
      currency: "NGN",
      rawPayload: payload.data,
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(getChainMock).toHaveBeenCalledWith("t1");
  });

  it("bad signature → 401 + captureException(warn), confirm NEVER called", async () => {
    const raw = JSON.stringify({ event: "charge.success", data: { reference: "PAY-9", amount: 100, metadata: { tenant_id: "t1" } } });
    const { req, res } = makeReqRes("paystack", raw, hmac(raw, "attacker-key"));
    await handleUnifiedPaymentWebhook(req, res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(confirmMock).not.toHaveBeenCalled();
    expect(captureMock).toHaveBeenCalledTimes(1);
    expect(captureMock.mock.calls[0][1].severity).toBe("warn");
  });

  it("missing signature → 401, confirm NEVER called", async () => {
    const raw = JSON.stringify({ event: "charge.success", data: { reference: "PAY-9", amount: 100, metadata: { tenant_id: "t1" } } });
    const { req, res } = makeReqRes("paystack", raw);
    await handleUnifiedPaymentWebhook(req, res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it("unknown provider → 404", async () => {
    const { req, res } = makeReqRes("nope", "{}", "sig");
    await handleUnifiedPaymentWebhook(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it("manual provider webhook → 401 (fail closed; receipt flow only)", async () => {
    const raw = JSON.stringify({ event: "charge.success", data: { reference: "M-1", amount: 1, metadata: { tenant_id: "t1" } } });
    const { req, res } = makeReqRes("manual", raw, "sig");
    await handleUnifiedPaymentWebhook(req, res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it("unresolvable creds → 401 + capture, never confirm", async () => {
    getChainMock.mockResolvedValue([]);
    delete process.env.PAYSTACK_SECRET_KEY;
    delete process.env.PAYSTACK_WEBHOOK_SECRET;
    const raw = JSON.stringify({ event: "charge.success", data: { reference: "PAY-9", amount: 100, metadata: { tenant_id: "t1" } } });
    const { req, res } = makeReqRes("paystack", raw, "sig");
    await handleUnifiedPaymentWebhook(req, res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: "provider-not-configured" });
    expect(confirmMock).not.toHaveBeenCalled();
    expect(captureMock).toHaveBeenCalled();
  });
});
