/**
 * How one assistant turn reaches the customer on WhatsApp.
 *
 * - An order with an online payment link goes out as ONE message: the order
 *   summary with a "Pay now" button (instead of summary text + a separate
 *   pay button + an order-management card).
 * - A reply with quick-reply buttons (Checkout / View cart / Pickup …) goes
 *   out as one interactive message with the reply as its body.
 * - Anything else is plain text. Every rich form falls back to the plain
 *   text it replaces when the send fails, so a customer always gets the reply.
 */
import { WA_INTERACTIVE_BODY_LIMIT, type SendInteractiveInput } from "./waSender";

export interface ReplyButton { id: string; title: string }

export interface AssistantTurn {
  reply: string;
  buttons?: ReplyButton[] | null;
  orderCard?: { orderId?: string; orderNumber?: string; paymentUrl?: string | null; paymentMethod?: string | null } | null;
}

export interface DeliveryDeps {
  sendText: (text: string) => Promise<unknown>;
  sendInteractive: (msg: SendInteractiveInput, opts?: { notifType?: string; orderId?: string }) => Promise<unknown>;
  /** The legacy order-management card (Track / Pay / Cancel). */
  orderActionCard: (orderId: string, orderNumber: string, cod?: boolean) => SendInteractiveInput;
}

/** The summary line that carries the raw payment URL — the Pay button replaces it. */
const PAY_LINK_LINE = /^💳 Click here to complete payment: \S+\s*$/m;

export function paymentMessageBody(reply: string): string {
  return reply.replace(PAY_LINK_LINE, "").replace(/\n{3,}/g, "\n\n").trim();
}

export async function deliverAssistantTurn(turn: AssistantTurn, deps: DeliveryDeps): Promise<"payment" | "buttons" | "text" | "none"> {
  const reply = (turn.reply ?? "").trim();
  const card = turn.orderCard;
  const payUrl = card?.paymentUrl && /^https:\/\//.test(card.paymentUrl) ? card.paymentUrl : null;

  if (card?.orderId && card.orderNumber && payUrl) {
    const body = paymentMessageBody(reply) || `Order ${card.orderNumber} is ready for payment.`;
    if (body.length <= WA_INTERACTIVE_BODY_LIMIT) {
      const ok = await deps.sendInteractive(
        { bodyText: body, footerText: "Reply *track* or *cancel* anytime.", action: { type: "cta_url", displayText: "Pay now", url: payUrl } },
        { notifType: "payment_cta", orderId: card.orderId },
      ).then(() => true, () => false);
      if (ok) return "payment";
    }
    // Too long for one message, or the button failed: the summary text keeps
    // the raw link, then the pay button on its own.
    if (reply) await deps.sendText(reply).catch(() => undefined);
    await deps.sendInteractive(
      { bodyText: `💳 Order ${card.orderNumber} is awaiting payment. Tap below to pay securely.`, action: { type: "cta_url", displayText: "Pay now", url: payUrl } },
      { notifType: "payment_cta", orderId: card.orderId },
    ).catch(() => undefined);
    return "text";
  }

  if (!reply) return "none";
  const buttons = (turn.buttons ?? []).slice(0, 3);
  let sent: "buttons" | "text" = "text";
  if (buttons.length > 0 && reply.length <= WA_INTERACTIVE_BODY_LIMIT) {
    const ok = await deps.sendInteractive({ bodyText: reply, action: { type: "button", buttons } })
      .then(() => true, () => false);
    if (ok) sent = "buttons";
  }
  if (sent === "text") await deps.sendText(reply);

  // Orders without an online link (cash on delivery) keep the management card.
  if (card?.orderId && card.orderNumber && !payUrl) {
    await deps.sendInteractive(deps.orderActionCard(card.orderId, card.orderNumber, card.paymentMethod === "cod"), { notifType: "order_action_card", orderId: card.orderId })
      .catch(() => undefined);
  }
  return sent;
}
