export function formatMoney(amount: number | string, currency = "NGN"): string {
  const value = Number(amount);
  const symbol = currency === "NGN" ? "₦" : "";
  const text = value.toLocaleString("en-NG", { minimumFractionDigits: Number.isInteger(value) ? 0 : 2, maximumFractionDigits: 2 });
  return symbol ? `${symbol}${text}` : `${currency} ${text}`;
}

export const salePercent = (price: string, compareAt: string | null) =>
  compareAt ? Math.round((1 - Number(price) / Number(compareAt)) * 100) : 0;

/** On the shared number, the first line sends the customer to this shop (see parseShopDirective on the server). */
export function waLink(store: { whatsapp: string | null; whatsappShopRef?: string | null }, text: string): string | null {
  if (!store.whatsapp) return null;
  const message = store.whatsappShopRef ? `Shop: ${store.whatsappShopRef}\n${text}` : text;
  return `https://wa.me/${store.whatsapp}?text=${encodeURIComponent(message)}`;
}

export const ORDER_STATUS_LABEL: Record<string, string> = {
  pending: "Order received", confirmed: "Confirmed", processing: "Being prepared", shipped: "On its way", out_for_delivery: "Out for delivery",
  delivered: "Delivered", completed: "Completed", cancelled: "Cancelled", refunded: "Refunded", failed: "Failed", ready: "Ready for pickup",
};
export const PAYMENT_STATUS_LABEL: Record<string, string> = {
  unpaid: "Not paid yet", initiated: "Waiting for payment", pending: "Waiting for payment", completed: "Paid", paid: "Paid",
  failed: "Payment failed", refunded: "Refunded", cancelled: "Cancelled",
};
