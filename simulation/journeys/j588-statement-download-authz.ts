// === W58 statements ===
/**
 * J588 — statement download authorization: the walletStatements router is
 * tenant-scoped (other tenants FORBIDDEN, anonymous UNAUTHORIZED) and the
 * generated PDF URL works only with the minted capability token on the
 * private uc-docs route (no token → 401; bound token → 200 PDF).
 */
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { seedUcTenant } from "./w46-uc-docs-seed";
import { tenantCaller, publicCaller, expectTrpcError } from "./helpers";

export const journey: Journey = {
  id: "J588",
  name: "statement download authz (tenant scope + capability token)",
  feature: "W58 statements: walletStatements router + uc-docs private access",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const svc = await import("../../server/services/walletStatements");
    const { tenantId } = await seedUcTenant(world, "588", 5802);
    const walletId = "wal-w58-588";
    await world.db.insert(schema.merchantWallets).values({
      id: walletId, tenantId, availableBalance: "100.00", currency: "NGN", isActive: true,
    }).onConflictDoNothing();
    await world.db.insert(schema.walletTransactions).values({
      id: "wtx-588-1", walletId, tenantId, type: "escrow_release", amount: "100.00",
      balanceBefore: "0.00", balanceAfter: "100.00", currency: "NGN", reference: "J588",
      createdAt: new Date(Date.now() - 40 * 86400000),
    } as any);

    // ── Router authz ────────────────────────────────────────────────────
    const owner = await tenantCaller(tenantId, { userId: 5802, memberships: [tenantId] });
    const gen = await owner.walletStatements.generateStatement({
      tenantId,
      from: new Date(Date.now() - 45 * 86400000).toISOString(),
      to: new Date().toISOString(),
    });
    assert(gen.record.id, "owner generates the statement");
    const listed = await owner.walletStatements.listStatements({ tenantId });
    assert(listed.length === 1, "owner lists the statement");
    const dl = await owner.walletStatements.getStatementDownload({ tenantId, statementId: gen.record.id });
    assert(dl.url.includes("/api/uc-docs/") && dl.url.includes("cap="), "download URL is capability-token bound");

    // Cross-tenant and anonymous callers are refused at every procedure.
    // The stranger holds a REAL owner membership in their own tenant so the
    // own-tenant probe below reaches the not-found branch (tenantRoleProcedure
    // checks the DB membership, not just the caller claim).
    await world.db.insert(schema.tenants).values({
      id: "sim-w58-stranger", name: "W58 stranger", slug: "sim-w58-stranger", status: "active",
    }).onConflictDoNothing();
    await world.db.insert(schema.tenantMemberships).values({
      tenantId: "sim-w58-stranger", userId: "5803", role: "owner",
    }).onConflictDoNothing();
    const stranger = await tenantCaller("sim-w58-stranger", { userId: 5803, memberships: ["sim-w58-stranger"] });
    await expectTrpcError(stranger.walletStatements.generateStatement({ tenantId, month: "2025-08" }), "FORBIDDEN", "cross-tenant generate");
    await expectTrpcError(stranger.walletStatements.listStatements({ tenantId }), "FORBIDDEN", "cross-tenant list");
    await expectTrpcError(stranger.walletStatements.getStatementDownload({ tenantId, statementId: gen.record.id }), "FORBIDDEN", "cross-tenant download");
    const anon = await publicCaller();
    await expectTrpcError(anon.walletStatements.listStatements({ tenantId }), "UNAUTHORIZED", "anonymous list");

    // A stranger tenant's id on their OWN tenant finds nothing (no leak).
    const strangerDl = stranger.walletStatements.getStatementDownload({ tenantId: "sim-w58-stranger", statementId: gen.record.id });
    await expectTrpcError(strangerDl, "NOT_FOUND", "statement id not visible across tenants");

    // ── HTTP authz on the private uc-docs route ─────────────────────────
    const bare = await fetch(`${world.baseUrl}/api/uc-docs/${gen.record.pdfPath}`);
    assert(bare.status === 401, `no token → 401 (got ${bare.status})`);
    const authed = await fetch(`${world.baseUrl}${dl.url}`);
    assert(authed.status === 200, `capability token → 200 (got ${authed.status})`);
    const body = await authed.text();
    assert(body.startsWith("%PDF-1.4"), "served bytes are the statement PDF");

    // Service-level: cross-tenant delivery refused.
    let refused = false;
    try {
      await svc.deliverWalletStatement(world.db, { tenantId: "sim-w58-stranger", statementId: gen.record.id, phone: "2348000000000" });
    } catch (e: any) {
      refused = e?.code === "not-found";
    }
    assert(refused, "another tenant cannot deliver the statement");
  },
};
