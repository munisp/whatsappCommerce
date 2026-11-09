/**
 * Automated KYB document checks (2026-11-09): until now no document had ever been checked (wrong request shape for
 * the verifier, wrong answer field, wrong key), and a "done" mark ignored the authenticity verdict.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Readable } from "node:stream";

vi.mock("./db", () => ({ getDb: vi.fn() }));
vi.mock("./routers/audit", () => ({ writeAuditLog: vi.fn(async () => {}) }));
vi.mock("./storage", () => ({
  storageServe: vi.fn(async () => ({ stream: Readable.from([Buffer.from("%PDF-1.4 certificate")]), contentType: "application/pdf" })),
  storagePut: vi.fn(), storageDelete: vi.fn(),
}));
vi.mock("./services/compliance", () => ({
  runKybChecks: vi.fn(async () => ({ recommendation: "auto_approve", reasons: [], sanctions: { degraded: false } })),
}));

import { getDb } from "./db";
import { createServer } from "node:http";
import { verifyKycDocument, queueKycDocumentVerification, kycVerificationIdle, verifierTransport } from "./services/kycDocumentVerification";
import { kycRouter } from "./routers/kyc";

const DOC = {
  id: "doc-1", applicationId: "app-1", tenantId: "t-1", documentType: "business_registration", fileKey: "kyc/app-1/br-1",
  fileName: "cac.pdf", mimeType: "application/pdf", processedAt: null as Date | null, erasedAt: null, erasureScheduledAt: null,
  verificationNotes: null as string | null, isAuthentic: null as boolean | null, isTampered: null as boolean | null,
};
let docs: (typeof DOC)[] = [];
let app: Record<string, unknown> = {};
const updates: Record<string, unknown>[] = [];

function fakeDb() {
  let table = "";
  const chain: any = {
    from: (t: any) => { table = t?.[Symbol.for("drizzle:Name")] ?? ""; return chain; },
    where: () => chain, orderBy: () => Promise.resolve(docs),
    limit: () => Promise.resolve(table === "kyc_documents" ? docs.slice(0, 1) : [app]),
    then: (res: any, rej: any) => Promise.resolve(table === "kyc_documents" ? docs : [app]).then(res, rej),
  };
  return {
    select: () => chain,
    update: () => ({ set: (v: Record<string, unknown>) => ({ where: () => { updates.push(v); return Promise.resolve(); } }) }),
  };
}

const realPost = verifierTransport.post;
const fetchMock = vi.fn();
beforeEach(() => {
  docs = [{ ...DOC }]; updates.length = 0; fetchMock.mockReset();
  verifierTransport.post = fetchMock as any;
  vi.mocked(getDb).mockResolvedValue(fakeDb() as any);
  process.env.KYC_SERVICE_URL = "http://kyc-verifier:8001";
  process.env.KYC_SERVICE_API_KEY = "the-real-key";
});
afterEach(() => { verifierTransport.post = realPost; });

const answer = (body: object, status = 200) => ({ status, body: JSON.stringify(body) });

describe("verifyKycDocument", () => {
  it("sends the file itself, as the verifier expects, with the deployment's key", async () => {
    fetchMock.mockResolvedValue(answer({ is_authentic: true, is_tampered: false, authenticity_score: 0.91, risk_score: 0.1, extracted_data: { business_name: "Ada Foods Ltd" } }));
    expect(await verifyKycDocument("doc-1")).toBe("verified");
    const [url, headers, file] = fetchMock.mock.calls[0];
    expect(url).toBe("http://kyc-verifier:8001/verify/document");
    expect(file.bytes.toString()).toBe("%PDF-1.4 certificate");
    expect(file.mimeType).toBe("application/pdf");
    expect(file.fileName).toBe("cac.pdf");
    expect(headers).toMatchObject({ "x-api-key": "the-real-key", "X-Application-Id": "app-1", "X-Tenant-Id": "t-1", "X-Document-Type": "business_registration" });
    expect(updates[0]).toMatchObject({ isAuthentic: true, isTampered: false, authenticityScore: "0.91", extractedData: { business_name: "Ada Foods Ltd" } });
    expect(updates[0].processedAt).toBeInstanceOf(Date);
    expect(String(updates[0].verificationNotes)).toMatch(/^\[auto-check\] passed/);
  });

  it("stores a bad verdict as flagged — checked, but not verified", async () => {
    fetchMock.mockResolvedValue(answer({ is_authentic: false, is_tampered: true, authenticity_score: 0.2, verification_notes: "Seal looks pasted" }));
    expect(await verifyKycDocument("doc-1")).toBe("flagged");
    expect(updates[0]).toMatchObject({ isAuthentic: false, isTampered: true });
    expect(String(updates[0].verificationNotes)).toContain("flagged");
    expect(String(updates[0].verificationNotes)).toContain("Seal looks pasted");
  });

  it("leaves the document pending when the verifier can't check it (503)", async () => {
    fetchMock.mockResolvedValue(answer({ detail: "verification unavailable" }, 503));
    expect(await verifyKycDocument("doc-1")).toBe("unavailable");
    expect(updates).toHaveLength(0);
  });

  it("leaves it pending when the answer has no verdict, or the verifier is unreachable", async () => {
    fetchMock.mockResolvedValueOnce(answer({ extracted_data: { business_name: "x" } }));
    expect(await verifyKycDocument("doc-1")).toBe("unavailable");
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    expect(await verifyKycDocument("doc-1")).toBe("unavailable");
    expect(updates).toHaveLength(0);
  });

  it("doesn't re-check a document that already has a verdict, or one being erased", async () => {
    docs = [{ ...DOC, processedAt: new Date() }];
    expect(await verifyKycDocument("doc-1")).toBe("skipped");
    docs = [{ ...DOC, erasedAt: new Date() as any }];
    expect(await verifyKycDocument("doc-1")).toBe("skipped");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("queues each document once", async () => {
    fetchMock.mockResolvedValue(answer({ is_authentic: true, is_tampered: false }));
    expect(queueKycDocumentVerification("doc-1")).toBe(true);
    expect(queueKycDocumentVerification("doc-1")).toBe(false);
    await kycVerificationIdle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("the real transport", () => {
  it("posts one multipart file the way FastAPI's UploadFile reads it, with our headers, and waits past 5 minutes' worth of fetch limits", async () => {
    let seen: { headers: Record<string, unknown>; body: Buffer } | null = null;
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => { seen = { headers: req.headers, body: Buffer.concat(chunks) }; res.end('{"ok":true}'); });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as any).port;
    const r = await realPost(`http://127.0.0.1:${port}/verify/document`, { "x-api-key": "k", "X-Document-Type": "business_registration" },
      { bytes: Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]), fileName: 'cac "final".pdf', mimeType: "application/pdf" }, 5000);
    server.close();
    expect(r).toEqual({ status: 200, body: '{"ok":true}' });
    const ct = String(seen!.headers["content-type"]);
    expect(ct).toMatch(/^multipart\/form-data; boundary=/);
    const boundary = ct.split("boundary=")[1];
    const text = seen!.body.toString("latin1");
    expect(text.startsWith(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="cac _final_.pdf"\r\nContent-Type: application/pdf\r\n\r\n`)).toBe(true);
    expect(text.endsWith(`\r\n--${boundary}--\r\n`)).toBe(true);
    expect(seen!.body.includes(Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]))).toBe(true); // binary intact
    expect(seen!.headers["x-api-key"]).toBe("k");
  });

  it("gives up at our own deadline", async () => {
    const server = createServer(() => { /* never answers */ });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as any).port;
    await expect(realPost(`http://127.0.0.1:${port}/x`, {}, { bytes: Buffer.from("x"), fileName: "f", mimeType: "image/png" }, 300))
      .rejects.toThrow(/no answer within/);
    server.closeAllConnections(); server.close();
  });
});

describe("kyc.review approve with a flagged document", () => {
  const ADMIN = { user: { id: 1, role: "admin", tenantId: null, name: "Admin" } } as any;
  beforeEach(() => {
    app = { id: "app-1", tenantId: "t-1", status: "pending", reviewNotes: null, businessName: "Ada Foods Ltd", businessRegistrationNumber: "RC-1", businessCountry: "NG" };
  });

  it("needs the waiver, like an unchecked one, and says it was flagged", async () => {
    docs = [{ ...DOC, processedAt: new Date(), isAuthentic: false, isTampered: false }];
    const err = await kycRouter.createCaller(ADMIN).review({ applicationId: "app-1", decision: "approved" }).catch((e) => e);
    expect(err.code).toBe("PRECONDITION_FAILED");
    expect(err.message).toContain("business_registration — flagged");
  });

  it("a cleanly checked document needs no waiver", async () => {
    docs = [{ ...DOC, processedAt: new Date(), isAuthentic: true, isTampered: false }];
    const err = await kycRouter.createCaller(ADMIN).review({ applicationId: "app-1", decision: "approved" }).catch((e) => e);
    expect(String(err?.message ?? "")).not.toContain("not verified");
  });
});
