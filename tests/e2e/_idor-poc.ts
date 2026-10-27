/**
 * LIVE adversarial PoC — tenant-isolation (IDOR) + privilege escalation, over real HTTP.
 *
 * Not a vitest file (underscore prefix) — run directly:
 *   DATABASE_URL=... JWT_SECRET=e2e-jwt-secret npx tsx tests/e2e/_idor-poc.ts
 *
 * Auth model under test: the platform session JWT carries only { openId };
 * the server resolves role + tenantId from the DB `users` row. So the real
 * attack surface is a *legitimately authenticated* tenant-A user attempting to
 * (a) reach tenant-B resources by id and (b) invoke money/admin procedures
 * above their role. Positive controls prove the gate is not a blanket deny.
 */
import {
  seedUser,
  mintPlatformSession,
  trpcQuery,
  trpcMutation,
  getSql,
  closeSql,
  uniqueId,
} from "./helpers/stack";

type Row = { label: string; expect: string; got: string; pass: boolean };
const rows: Row[] = [];
function record(label: string, expect: string, got: string, pass: boolean) {
  rows.push({ label, expect, got, pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}\n       expect: ${expect}\n       got:    ${got}`);
}

async function waitForHealth(timeoutMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch("http://localhost:3000/api/health/postgres", {
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const j = (await res.json()) as { online?: boolean };
        if (j.online) return true;
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("server health never went green");
}

async function main() {
  await waitForHealth();
  const sql = getSql();

  // ── Tenants + principals ────────────────────────────────────────────────
  const tenantA = uniqueId("tenantA");
  const tenantB = uniqueId("tenantB");

  const openIdAUser = uniqueId("oidA-user");
  const openIdAAnalyst = uniqueId("oidA-analyst");
  const openIdBUser = uniqueId("oidB-user");
  const openIdAdmin = uniqueId("oid-admin");

  await seedUser({ openId: openIdAUser, name: "A buyer", role: "user", tenantId: tenantA });
  await seedUser({ openId: openIdAAnalyst, name: "A analyst", role: "analyst", tenantId: tenantA });
  await seedUser({ openId: openIdBUser, name: "B buyer", role: "user", tenantId: tenantB });
  await seedUser({ openId: openIdAdmin, name: "Platform admin", role: "admin", tenantId: null as unknown as undefined });

  const tokAUser = await mintPlatformSession(openIdAUser, "A buyer");
  const tokAAnalyst = await mintPlatformSession(openIdAAnalyst, "A analyst");
  const tokBUser = await mintPlatformSession(openIdBUser, "B buyer");
  const tokAdmin = await mintPlatformSession(openIdAdmin, "Platform admin");

  // ── Tenant-scoped resources (one template per tenant) ───────────────────
  const tplA = uniqueId("tpl-A");
  const tplB = uniqueId("tpl-B");
  await sql`INSERT INTO whatsapp_templates ("id","tenantId","name","bodyText")
            VALUES (${tplA}, ${tenantA}, ${"A greeting"}, ${"hello from A"})`;
  await sql`INSERT INTO whatsapp_templates ("id","tenantId","name","bodyText")
            VALUES (${tplB}, ${tenantB}, ${"B greeting"}, ${"hello from B"})`;

  // ════════════════ IDOR / tenant isolation ════════════════
  // 1. Positive control: A reads its OWN template.
  {
    const r = await trpcQuery<{ id?: string } | null>("template.get", { id: tplA }, tokAUser);
    const got = r.ok ? `data.id=${(r.data as any)?.id}` : `error ${r.error.trpcCode}`;
    record("IDOR-posctrl: A-user reads A's template", `ok, data.id=${tplA}`, got, r.ok && (r.data as any)?.id === tplA);
  }
  // 2. IDOR read: A reads B's template by id → must NOT leak (null).
  {
    const r = await trpcQuery<{ id?: string } | null>("template.get", { id: tplB }, tokAUser);
    const leaked = r.ok && (r.data as any)?.id === tplB;
    const got = r.ok ? `data=${JSON.stringify(r.data)}` : `error ${r.error.trpcCode}`;
    record("IDOR-read: A-user reads B's template by id", "null (no cross-tenant leak)", got, !leaked);
  }
  // 3. IDOR update: A tries to rename B's template → B must be unchanged.
  {
    await trpcMutation("template.update", { id: tplB, name: "HACKED-BY-A" }, tokAUser);
    const [after] = await sql<{ name: string }[]>`SELECT "name" FROM whatsapp_templates WHERE "id"=${tplB}`;
    record("IDOR-update: A-user renames B's template", "B.name still 'B greeting'", `B.name='${after?.name}'`, after?.name === "B greeting");
  }
  // 4. IDOR delete: A tries to delete B's template → B must still exist.
  {
    await trpcMutation("template.delete", { id: tplB }, tokAUser);
    const existing = await sql<{ id: string }[]>`SELECT "id" FROM whatsapp_templates WHERE "id"=${tplB}`;
    record("IDOR-delete: A-user deletes B's template", "B still exists", `rows=${existing.length}`, existing.length === 1);
  }
  // 5. Positive control: B reads its OWN template (proves tplB is real + reachable by owner).
  {
    const r = await trpcQuery<{ id?: string } | null>("template.get", { id: tplB }, tokBUser);
    const got = r.ok ? `data.id=${(r.data as any)?.id}` : `error ${r.error.trpcCode}`;
    record("IDOR-posctrl: B-user reads B's template", `ok, data.id=${tplB}`, got, r.ok && (r.data as any)?.id === tplB);
  }

  // ════════════════ Privilege escalation ════════════════
  // 6. Admin escalation: A-user (role 'user') calls an adminProcedure.
  {
    const r = await trpcQuery("telemetry.getStatus", undefined, tokAUser);
    const got = r.ok ? "ok (LEAK!)" : `error ${r.error.trpcCode}`;
    record("ESC-admin: A-user calls adminProcedure telemetry.getStatus", "FORBIDDEN", got, !r.ok && r.error.trpcCode === "FORBIDDEN");
  }
  // 7. Positive control: admin calls the same adminProcedure → works.
  {
    const r = await trpcQuery("telemetry.getStatus", undefined, tokAdmin);
    const got = r.ok ? "ok" : `error ${r.error.trpcCode}`;
    record("ESC-posctrl: admin calls telemetry.getStatus", "ok", got, r.ok);
  }
  // 8. Money escalation: A-user (no owner/operator/finance membership) calls moneyProcedure.
  {
    const r = await trpcMutation("approvals.setPolicy", { tenantId: tenantA, thresholdCents: 1000 }, tokAUser);
    const got = r.ok ? "ok (LEAK!)" : `error ${r.error.trpcCode}`;
    record("ESC-money: A-user calls moneyProcedure approvals.setPolicy", "FORBIDDEN", got, !r.ok && r.error.trpcCode === "FORBIDDEN");
  }
  // 9. Money escalation (analyst): analyst is NEVER enough for money movement.
  {
    const r = await trpcMutation("approvals.setPolicy", { tenantId: tenantA, thresholdCents: 1000 }, tokAAnalyst);
    const got = r.ok ? "ok (LEAK!)" : `error ${r.error.trpcCode}`;
    record("ESC-money: A-analyst calls moneyProcedure approvals.setPolicy", "FORBIDDEN", got, !r.ok && r.error.trpcCode === "FORBIDDEN");
  }
  // 10. Cross-tenant claim: A-user names tenant B in the input.
  {
    const r = await trpcMutation("approvals.setPolicy", { tenantId: tenantB, thresholdCents: 1000 }, tokAUser);
    const got = r.ok ? "ok (LEAK!)" : `error ${r.error.trpcCode}`;
    record("ESC-xtenant: A-user sets policy for tenant B", "FORBIDDEN", got, !r.ok && r.error.trpcCode === "FORBIDDEN");
  }
  // 11. Unauthenticated: no token at all.
  {
    const r = await trpcQuery("template.list", { page: 1, pageSize: 10 });
    const got = r.ok ? "ok (LEAK!)" : `error ${r.error.trpcCode}`;
    record("AUTH: unauthenticated template.list", "UNAUTHORIZED", got, !r.ok && r.error.trpcCode === "UNAUTHORIZED");
  }

  // ── Cleanup our rows ─────────────────────────────────────────────────────
  await sql`DELETE FROM whatsapp_templates WHERE "id" IN (${tplA}, ${tplB})`;
  await closeSql();

  const failed = rows.filter((r) => !r.pass);
  console.log(`\n================ SUMMARY ================`);
  console.log(`${rows.length - failed.length}/${rows.length} probes behaved correctly.`);
  if (failed.length) {
    console.log(`\nVULNERABILITIES / UNEXPECTED:`);
    for (const f of failed) console.log(`  - ${f.label} (expected ${f.expect}, got ${f.got})`);
    process.exit(1);
  }
  console.log(`No tenant-isolation or privilege-escalation gaps found.`);
}

main().catch((e) => {
  console.error("POC_ERROR", e);
  process.exit(2);
});
