// === W46 uc-docs ===
/**
 * ucDocsPdf.ts — shared dependency-free document machinery for the W46
 * uc-docs features (UC-12 statements, UC-19 proformas, UC-20 commission
 * statements). Same minimal-PDF pattern as the W28 bookkeeping export and
 * the W33 supplier tax statements (Courier base font, ASCII-escaped text
 * lines, honest local persistence — a failed write throws, no row claims a
 * document that does not exist on disk).
 *
 * Also the chat document DELIVERY helper: routes a PDF document to the
 * customer on their preferred channel via channelParity.notifyCustomer
 * (telegram sendDocument for telegram-linked customers) with the WA media
 * path (sendWhatsAppMedia type 'document') as the fallback — byte-identical
 * to the existing annual-statement send for WA customers.
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "fs";
import { join } from "path";

/** Directory W46 document PDFs are written to (honest local persistence). */
export function ucDocsDir(): string {
  return (process.env.UC_DOCS_DIR ?? "data/uc-docs").trim() || "data/uc-docs";
}

export interface SimplePdfInput {
  title: string;
  lines: string[];
}

/**
 * Minimal single/multi-page PDF from plain text lines (ASCII-safe). Pages
 * break at 46 lines. This is intentionally the SAME dependency-free writer
 * pattern as supplierTaxStatements.statementToPdf.
 */
export function linesToPdf(input: SimplePdfInput): Buffer {
  const esc = (s: string) =>
    s.replace(/[^\x20-\x7E]/g, "?").replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const allLines = [input.title, "=".repeat(Math.min(input.title.length, 60)), "", ...input.lines];
  const PAGE_LINES = 46;
  const pages: string[][] = [];
  for (let i = 0; i < allLines.length; i += PAGE_LINES) pages.push(allLines.slice(i, i + PAGE_LINES));

  const objects: string[] = [];
  const pageIds = pages.map((_, i) => 3 + i);
  const contentIds = pages.map((_, i) => 3 + pages.length + i);
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  pages.forEach((pageLines, i) => {
    let content = "BT /F1 11 Tf 50 780 Td 16 TL\n";
    for (const line of pageLines) content += `(${esc(line)}) Tj T*\n`;
    content += "ET\n";
    objects[pageIds[i]!] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents ${contentIds[i]} 0 R >>`;
    objects[contentIds[i]!] = `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`;
  });
  objects[4] = "<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>";

  const count = 3 + pages.length * 2;
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let i = 1; i <= count; i++) {
    offsets[i] = Buffer.byteLength(pdf);
    pdf += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefPos = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${count + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= count; i++) pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${count + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  return Buffer.from(pdf, "binary");
}

/** Write a document PDF deterministically; throws honestly on failure. */
export function writeDocPdf(rel: string, pdf: Buffer): string {
  const abs = join(ucDocsDir(), rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, pdf);
  if (!existsSync(abs)) throw new Error(`document PDF write failed for ${abs}`);
  return rel;
}

export interface ChatDocResult {
  channel: "whatsapp" | "telegram";
  sent: boolean;
  simulated: boolean;
  messageId: string | null;
}

/**
 * Deliver a generated PDF to a customer/agent over chat. Telegram-linked
 * recipients are routed by channelParity (sendDocument); everyone else takes
 * the EXISTING waSender media path (document by public link). The PDF buffer
 * travels for telegram (Bot API multipart upload); WA sends the link form,
 * exactly like the W33 annual-statement push.
 */
export async function sendChatDocument(
  tenantId: string,
  phone: string,
  opts: {
    relPath: string;
    filename: string;
    caption: string;
    notifType: string;
    /** Parity category (registered in channelParity PARITY_CATEGORIES). */
    category: string;
  },
): Promise<ChatDocResult> {
  const link = `/api/uc-docs/${opts.relPath}`;
  // Telegram route first (channelParity resolves the linked identity).
  try {
    const { notifyCustomer } = await import("./channelParity");
    const buffer = readFileSync(join(ucDocsDir(), opts.relPath));
    const routed = await notifyCustomer(tenantId, { phone }, opts.category, {
      text: opts.caption,
      notifType: opts.notifType,
      media: { type: "document", url: link, buffer, caption: opts.caption, filename: opts.filename },
    });
    if (routed.handled) {
      return { channel: "telegram", sent: routed.sent === true, simulated: routed.simulated === true, messageId: null };
    }
  } catch (e: any) {
    console.warn(`[uc-docs] telegram document route failed (${opts.notifType}):`, e?.message);
  }
  // WhatsApp fallback — same call shape as supplierTaxStatements.sendStatement.
  const { sendWhatsAppMedia } = await import("./waSender");
  const res = await sendWhatsAppMedia(tenantId, phone, {
    type: "document",
    link,
    caption: opts.caption,
    filename: opts.filename,
  }, { notifType: opts.notifType });
  if (!res.sent && !res.simulated) throw new Error("WhatsApp document push was not accepted");
  return { channel: "whatsapp", sent: res.sent, simulated: res.simulated, messageId: res.wamid ?? null };
}
// === END W46 uc-docs ===
