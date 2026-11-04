import { describe, expect, it } from "vitest";
import { deliverAssistantTurn, paymentMessageBody } from "./services/chatReplyDelivery";

function harness(opts: { failInteractive?: boolean } = {}) {
  const sent: Array<{ kind: string; body: any; opts?: any }> = [];
  return {
    sent,
    deps: {
      sendText: async (text: string) => { sent.push({ kind: "text", body: text }); },
      sendInteractive: async (msg: any, o?: any) => {
        if (opts.failInteractive) throw new Error("meta 500");
        sent.push({ kind: msg.action.type, body: msg, opts: o });
      },
      orderActionCard: (orderId: string, orderNumber: string) => ({
        bodyText: `Order ${orderNumber} — manage it here:`,
        action: { type: "button" as const, buttons: [{ id: `order_track:${orderId}`, title: "📦 Track Order" }] },
      }),
    },
  };
}

const SUMMARY = "🧾 *Pickup Order ORD-1*\n1 × Rice — ₦2,500.00\n*Total: ₦2,500.00*\n\n💳 Click here to complete payment: https://checkout.paystack.com/abc\n🔎 Track your order: https://x/track/1";

describe("deliverAssistantTurn", () => {
  it("sends an order with a pay link as ONE summary + Pay now message", async () => {
    const h = harness();
    const r = await deliverAssistantTurn({ reply: SUMMARY, orderCard: { orderId: "o1", orderNumber: "ORD-1", paymentUrl: "https://checkout.paystack.com/abc" } }, h.deps);
    expect(r).toBe("payment");
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].kind).toBe("cta_url");
    expect(h.sent[0].body.action.url).toBe("https://checkout.paystack.com/abc");
    expect(h.sent[0].body.bodyText).toContain("Total: ₦2,500.00");
    expect(h.sent[0].body.bodyText).not.toContain("Click here to complete payment");
    expect(h.sent[0].body.bodyText).toContain("Track your order");
  });

  it("falls back to the summary text (with the link) when the Pay button can't be sent", async () => {
    const h = harness({ failInteractive: true });
    await deliverAssistantTurn({ reply: SUMMARY, orderCard: { orderId: "o1", orderNumber: "ORD-1", paymentUrl: "https://checkout.paystack.com/abc" } }, h.deps);
    expect(h.sent).toEqual([{ kind: "text", body: SUMMARY }]);
  });

  it("keeps the management card for cash-on-delivery orders", async () => {
    const h = harness();
    await deliverAssistantTurn({ reply: "Order placed, pay the rider.", orderCard: { orderId: "o2", orderNumber: "ORD-2", paymentUrl: null } }, h.deps);
    expect(h.sent.map((m) => m.kind)).toEqual(["text", "button"]);
  });

  it("sends quick-reply buttons with the reply as the body", async () => {
    const h = harness();
    const buttons = [{ id: "say:checkout", title: "🧾 Checkout" }];
    expect(await deliverAssistantTurn({ reply: "✅ 1 × Rice", buttons }, h.deps)).toBe("buttons");
    expect(h.sent[0].body).toMatchObject({ bodyText: "✅ 1 × Rice", action: { type: "button", buttons } });
  });

  it("falls back to plain text when buttons fail or the reply is too long for one", async () => {
    const h = harness({ failInteractive: true });
    await deliverAssistantTurn({ reply: "✅ 1 × Rice", buttons: [{ id: "say:cart", title: "Cart" }] }, h.deps);
    expect(h.sent).toEqual([{ kind: "text", body: "✅ 1 × Rice" }]);
    const h2 = harness();
    await deliverAssistantTurn({ reply: "x".repeat(1100), buttons: [{ id: "say:cart", title: "Cart" }] }, h2.deps);
    expect(h2.sent.map((m) => m.kind)).toEqual(["text"]);
  });

  it("ignores non-https payment links", () => {
    expect(paymentMessageBody(SUMMARY)).not.toMatch(/Click here/);
  });
});
