/**
 * Automated checking of KYB documents by the kyc-verifier service (OCR + vision model).
 *
 * Until 2026-11-09 no document had ever been checked: the server posted JSON with a file URL to a service that takes
 * the file itself as a multipart upload (and wasn't deployed), read `extracted_fields` where the service answers
 * `extracted_data`, and sent the insecure default key. Every document stayed "pending" and every approval needed a
 * waiver. It also marked a document done whenever fields came back, whatever the authenticity verdict.
 *
 * Now: the file bytes are sent as the service expects; the verdict (authentic / tampered / score / notes) is stored
 * with processedAt. A document that couldn't be checked stays pending (never marked done without a verdict) and can
 * be re-queued. Checks run one at a time per server in the background: a CPU vision model takes minutes per page,
 * and the merchant's upload shouldn't wait for it.
 */
import { eq, isNull, and } from "drizzle-orm";
import { getDb } from "../db";
import { kycDocuments } from "../../drizzle/schema";
import { storageServe } from "../storage";
import { injectTraceHeaders } from "../_core/telemetry";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { randomBytes } from "node:crypto";

const SERVICE_URL = () => process.env.KYC_SERVICE_URL ?? "http://localhost:8001";
const API_KEY = () => process.env.KYC_SERVICE_API_KEY ?? process.env.KYC_INTERNAL_API_KEY ?? "";
const TIMEOUT_MS = () => Number(process.env.KYC_VERIFY_TIMEOUT_MS ?? 15 * 60 * 1000);

export type VerificationOutcome = "verified" | "flagged" | "unavailable" | "skipped";

/** What the verifier answers (services/kyc-verifier/app/models.py DocumentVerificationResult). */
interface VerifierResult {
  ocr_confidence?: number; ocr_raw_text?: string; extracted_data?: Record<string, unknown>;
  vlm_analysis?: Record<string, unknown>; docling_structure?: Record<string, unknown>;
  is_authentic?: boolean; is_tampered?: boolean; authenticity_score?: number; risk_score?: number; verification_notes?: string;
}

async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer | string>) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

export { isFlagged } from "../../shared/kybScreening";

interface Upload { bytes: Buffer; fileName: string; mimeType: string }

/**
 * One multipart POST with node:http rather than fetch: Node's fetch gives up after 5 minutes without response
 * headers, and a CPU vision model can take longer than that on one page. Only our own deadline applies here.
 */
function postMultipart(url: string, headers: Record<string, string>, file: Upload, timeoutMs: number): Promise<{ status: number; body: string }> {
  const boundary = `----oak-kyc-${randomBytes(12).toString("hex")}`;
  const safeName = file.fileName.replace(/["\r\n]/g, "_");
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safeName}"\r\nContent-Type: ${file.mimeType}\r\n\r\n`),
    file.bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const target = new URL(url);
  const send = target.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = send(target, {
      method: "POST",
      headers: { ...headers, "Content-Type": `multipart/form-data; boundary=${boundary}`, "Content-Length": String(body.length) },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", reject);
    });
    const deadline = setTimeout(() => req.destroy(new Error(`no answer within ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
    req.on("close", () => clearTimeout(deadline));
    req.on("error", reject);
    req.end(body);
  });
}

/** How the verifier is reached; tests replace `post`. */
export const verifierTransport = { post: postMultipart };

/** Check one document now. Never throws; a failure leaves the document pending. */
export async function verifyKycDocument(documentId: string): Promise<VerificationOutcome> {
  try {
    const db = await getDb();
    if (!db) return "unavailable";
    const [doc] = await db.select().from(kycDocuments).where(eq(kycDocuments.id, documentId)).limit(1);
    if (!doc || doc.processedAt || doc.erasedAt || doc.erasureScheduledAt || !doc.fileKey) return "skipped";
    const { stream, contentType } = await storageServe(doc.fileKey);
    const bytes = await readAll(stream);
    const res = await verifierTransport.post(`${SERVICE_URL()}/verify/document`, injectTraceHeaders({
      "x-api-key": API_KEY(),
      "X-Application-Id": doc.applicationId,
      "X-Tenant-Id": doc.tenantId,
      "X-Document-Type": doc.documentType,
    }), { bytes, fileName: doc.fileName ?? "document", mimeType: doc.mimeType ?? contentType }, TIMEOUT_MS());
    if (res.status < 200 || res.status >= 300) {
      console.error(`[kyc-verify] ${documentId}: verifier answered ${res.status} — left pending`);
      return "unavailable";
    }
    const r = JSON.parse(res.body) as VerifierResult;
    if (typeof r.is_authentic !== "boolean" || typeof r.is_tampered !== "boolean") {
      console.error(`[kyc-verify] ${documentId}: verifier gave no verdict — left pending`);
      return "unavailable";
    }
    const note = `[auto-check] ${r.is_authentic && !r.is_tampered ? "passed" : "flagged"} at ${new Date().toISOString()}` +
      ` (authenticity ${r.authenticity_score ?? "?"}, risk ${r.risk_score ?? "?"})${r.verification_notes ? ` — ${r.verification_notes}` : ""}`;
    await db.update(kycDocuments).set({
      ocrRawText: r.ocr_raw_text ?? null,
      ocrConfidence: r.ocr_confidence != null ? String(Math.round(r.ocr_confidence * 1000) / 1000) : null,
      extractedData: r.extracted_data ?? null,
      vlmAnalysis: r.vlm_analysis ?? null,
      doclingStructure: r.docling_structure ?? null,
      isAuthentic: r.is_authentic,
      isTampered: r.is_tampered,
      authenticityScore: r.authenticity_score != null ? String(r.authenticity_score) : null,
      verificationNotes: [doc.verificationNotes, note].filter(Boolean).join("\n"),
      processedAt: new Date(),
    }).where(and(eq(kycDocuments.id, documentId), isNull(kycDocuments.processedAt)));
    const outcome = r.is_authentic && !r.is_tampered ? "verified" : "flagged";
    console.log(`[kyc-verify] ${documentId} (${doc.documentType}): ${outcome}`);
    return outcome;
  } catch (err) {
    console.error(`[kyc-verify] ${documentId}: check failed — left pending:`, (err as Error).message);
    return "unavailable";
  }
}

// One check at a time per server process; the same document is never queued twice.
let tail: Promise<unknown> = Promise.resolve();
const queued = new Set<string>();

/** Queue a background check. Returns false when that document is already waiting. */
export function queueKycDocumentVerification(documentId: string): boolean {
  if (queued.has(documentId)) return false;
  queued.add(documentId);
  // .catch first: one failed link must never stop the documents queued after it.
  tail = tail.catch(() => undefined).then(() => verifyKycDocument(documentId)).finally(() => queued.delete(documentId));
  return true;
}

/** Test hook: wait for everything queued so far. */
export function kycVerificationIdle(): Promise<unknown> {
  return tail;
}
