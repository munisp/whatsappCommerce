// === W49 RICHMEDIA ===
/**
 * J491 — RICH-6: order receipt PDF via the existing ucDocsPdf pipeline.
 *
 *   WA: sendOrderReceiptPdf writes receipt-<orderNo>.pdf under ucDocsDir and
 *       pushes a WhatsApp document message whose link is an ABSOLUTE
 *       /api/uc-docs URL (RICH-3 absolutization inside sendChatDocument).
 *   TG: the telegram document path (sendTelegramMedia type=document with a
 *       buffer — the exact shape channelParity uses) reaches the Bot API as
 *       sendDocument.
 *   Fail-open: a bogus tenant returns false instead of throwing (receipts
 *   must never break the money path).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { ensureTelegramConfig } from "./j235-telegram-webhook-security";
import { tg } from "../metaMock";

export const journey: Journey = {
  id: "J491",
  name: "order receipt PDF delivered as chat document on WA + TG",
  feature: "RICH-6",
  async run(world: World) {
    process.env.PUBLIC_APP_URL = "https://shop.example.com";
    const { sendOrderReceiptPdf } = await import("../../server/services/richMedia");
    const { ucDocsDir } = await import("../../server/services/ucDocsPdf");
    const phone = "+2348017000491";

    // ── WA document ───────────────────────────────────────────────────────
    const ok = await sendOrderReceiptPdf(TENANT_ID, phone, {
      businessName: "Sim Store",
      orderNumber: "SO-491",
      lines: ["2 × Ankara — ₦9,000", "Total: ₦9,000"],
    });
    assert(ok === true, "receipt pdf delivered (or simulated) without throwing");
    assert(existsSync(join(ucDocsDir(), `receipts/${TENANT_ID}/receipt-SO-491.pdf`)), "PDF persisted under ucDocsDir");
    const doc = world.outbound.lastOfType("document", phone.replace("+", ""));
    assert(doc, "WA document message captured");
    assert(String(doc!.body?.document?.link).startsWith("https://shop.example.com/api/uc-docs/"), `absolute doc link (got ${doc!.body?.document?.link})`);
    assert(doc!.body?.document?.filename === "receipt-SO-491.pdf", "filename shown to buyer");

    // ── TG document (buffer multipart — channelParity shape) ──────────────
    await ensureTelegramConfig(world);
    tg.reset();
    const { sendTelegramMedia } = await import("../../server/services/telegramSender");
    await sendTelegramMedia(TENANT_ID, "491001", {
      type: "document",
      buffer: Buffer.from("%PDF-1.4 sim"),
      filename: "receipt-SO-491.pdf",
      caption: "🧾 Receipt",
    });
    assert(tg.callsFor("sendDocument").length === 1, "TG sendDocument reached the Bot API");

    // ── fail-open on an unconfigured tenant ───────────────────────────────
    const bad = await sendOrderReceiptPdf("tenant-does-not-exist", phone, {
      businessName: "X",
      orderNumber: "SO-X",
      lines: ["Total: ₦0"],
    });
    assert(typeof bad === "boolean", "fail-open boolean, never throws");
  },
};
