/**
 * === W40 TEN-5 (Coder B) ===
 * J278 — REGRESSION: erasure guards still win over the new KYC erasure path.
 *
 * A user with an OPEN escrow requests erasure. The request must be blocked
 * (open_escrows) exactly as before W40, and — critically — the new KYC
 * artifact scrubbing must NOT run: the document's OCR text stays intact
 * because the erasure was never executed. After the escrow reaches a
 * terminal state, erasure completes and scrubs KYC artifacts.
 */
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { assert, TENANT_ID, type World } from "../world";
import type { Journey } from "../runner";
import { adminCaller } from "./helpers";

export const journey: Journey = {
  id: "J278",
  name: "Erasure guards block KYC scrubbing too (TEN-5 regression)",
  feature: "open escrow blocks requestErasure; KYC artifacts untouched while blocked; erasure completes after escrow settles",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const admin = await adminCaller();
    process.env.TEMPORAL_ADDRESS = "127.0.0.1:1";

    const started = await admin.onboarding.start({ name: "Guarded Erasure Store", plan: "starter" });
    const tenantId = started.tenantId;
    const phone = `+23480${Math.floor(10000000 + Math.random() * 89999999)}`;
    const [u] = await world.db.insert(schema.users).values({
      openId: `w40-j278-${randomUUID().slice(0, 8)}`,
      email: "j278@sim.local", name: "J278 User", phone,
      loginMethod: "keycloak", role: "user", tenantId, lastSignedIn: new Date(),
    }).returning();
    const { appRouter } = await import("../../server/routers");
    const caller = appRouter.createCaller({
      user: {
        id: u.id, openId: u.openId, email: u.email, name: u.name, phone,
        loginMethod: "keycloak", role: "user", tenantId,
        createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date(),
      },
      req: { protocol: "http", headers: {} },
      res: { clearCookie: () => {} },
    } as any);

    // Customer profile keyed by the same phone + an OPEN escrow.
    const custId = `cust-j278-${randomUUID().slice(0, 8)}`;
    await world.db.insert(schema.customers).values({
      id: custId, tenantId, whatsappPhone: phone, name: "J278 Customer",
    });
    const orderId = `ord-j278-${randomUUID().slice(0, 8)}`;
    await world.db.insert(schema.orders).values({
      id: orderId, tenantId, customerId: custId,
      orderNumber: `J278-${randomUUID().slice(0, 6)}`,
      status: "pending", totalAmount: "500.00", currency: "NGN", metadata: {},
    });
    await world.db.insert(schema.escrowTransactions).values({
      tenantId, orderId, customerId: custId,
      amount: "500.00", currency: "NGN", state: "payment_received",
    });

    // KYC artifact that must survive the blocked erasure.
    const app = await caller.kyc.getOrCreateApplication({ tenantId, type: "kyb" });
    const docId = randomUUID();
    await world.db.insert(schema.kycDocuments).values({
      id: docId, applicationId: app.id, tenantId,
      documentType: "passport",
      fileKey: `kyc/${app.id}/passport-j278`,
      fileUrl: `/api/storage/kyc/${app.id}/passport-j278`,
      ocrRawText: "PASSPORT — J278 User — A01234567",
      createdAt: new Date(),
    });

    // ── Guard: open escrow blocks erasure; KYC artifacts untouched ───────
    const blocked = await caller.privacy.requestErasure({ reason: "J278 blocked" });
    assert(blocked.status === "blocked" && (blocked as any).reason === "open_escrows",
      `erasure blocked by open escrow (got ${JSON.stringify(blocked)})`);
    let [doc] = await world.db.select().from(schema.kycDocuments).where(eq(schema.kycDocuments.id, docId));
    assert(doc.ocrRawText?.includes("A01234567"), "KYC OCR text NOT scrubbed while erasure is blocked");
    assert(!doc.erasureScheduledAt && !doc.erasedAt, "no tombstone while blocked");
    const [uRow] = await world.db.select().from(schema.users).where(eq(schema.users.id, u.id));
    assert(uRow.email === "j278@sim.local", "user PII NOT anonymized while blocked");

    // ── Escrow settles → erasure completes and scrubs KYC artifacts ──────
    await world.db.update(schema.escrowTransactions)
      .set({ state: "settled" })
      .where(eq(schema.escrowTransactions.orderId, orderId));
    const done = await caller.privacy.requestErasure({ reason: "J278 after settlement" });
    assert(done.status === "completed", "erasure completes once escrow is terminal");
    [doc] = await world.db.select().from(schema.kycDocuments).where(eq(schema.kycDocuments.id, docId));
    assert(doc.ocrRawText === null && doc.fileUrl === null, "KYC artifacts scrubbed after guards clear");
    assert(doc.erasureScheduledAt || doc.erasedAt, "S3 scan deleted or tombstoned for the sweep");
  },
};
