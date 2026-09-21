/**
 * Section 8 (Role × Functionality Matrix) deliverable generator.
 *
 * Reuses the CI's own authzScan.lib.ts (already trusted — it's the ratchet
 * that caught QA-005/006) to classify every router procedure by:
 *   - procedure kind (the actual access-control tier: public / protected /
 *     internal / operator / analyst / money / admin)
 *   - HTTP-ish verb inferred from the procedure builder (.query vs .mutation)
 *   - the specific guard mechanism found in-body (assertTenantAccess /
 *     assertMoneyAccess / admin-role-check / session-tenant-scoping / etc.)
 *   - a money-relevance heuristic (body mentions balance/amount/wallet/
 *     escrow/refund/payout/withdraw/settle/commission)
 *
 * Output: .qa/role-functionality-matrix.md — one row per procedure, grouped
 * by router file, so every meaningful (role-tier × procedure) intersection
 * in the actual codebase is visible in one place instead of sampled.
 */
import { scanRouterDir, isGuarded, isTenantRelevant, type ProcBlock } from "../../server/routers/__tests__/authzScan.lib";
import { writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROUTER_DIR = join(__dirname, "../../server/routers");

const MONEY_RE = /\b(balance_cents|balanceCents|amount_cents|amountCents|wallet|escrow|refund|payout|withdraw|settle|commission|debit|credit|ledger|payment_intent|paymentIntent)\b/i;

function verbOf(b: ProcBlock): "query" | "mutation" | "unknown" {
  if (/\.mutation\(/.test(b.body)) return "mutation";
  if (/\.query\(/.test(b.body)) return "query";
  return "unknown";
}

function guardMechanism(b: ProcBlock): string {
  if (b.exempt) return `exempt: ${b.exempt}`;
  if (b.kind === "adminProcedure") return "adminProcedure (role=admin + Permify)";
  if (b.kind === "operatorProcedure") return "operatorProcedure (owner|operator)";
  if (b.kind === "analystProcedure") return "analystProcedure (owner|operator|analyst)";
  if (b.kind === "internalProcedure") return "internalProcedure (shared-secret)";
  if (b.kind === "publicProcedure") return "publicProcedure (no auth)";
  if (b.stripped.includes("assertMoneyAccess(")) return "assertMoneyAccess (owner|operator|finance)";
  if (b.stripped.includes("assertTenantAccess(")) return "assertTenantAccess (any membership)";
  if (/\bassert\w*(Access|OrAdmin|Ownership)\(/.test(b.stripped)) {
    const m = b.stripped.match(/\bassert\w*(Access|OrAdmin|Ownership)\(/);
    return `domain guard: ${m?.[0] ?? "unknown"}`;
  }
  if (/ctx\.user\??\.?role/.test(b.stripped) && b.stripped.includes("FORBIDDEN")) return "inline role check";
  if (b.stripped.includes("ctx.user.tenantId") || b.stripped.includes("ctx.user?.tenantId")) return "session-tenant scoping";
  if (/getTenantId\(ctx/.test(b.stripped)) return "getTenantId(ctx) helper";
  if (/tenantCtx\(ctx/.test(b.stripped)) return "tenantCtx(ctx) helper (wraps assertTenantAccess)";
  return "NONE FOUND";
}

const blocks = scanRouterDir(ROUTER_DIR);
const byFile = new Map<string, ProcBlock[]>();
for (const b of blocks) {
  if (!byFile.has(b.file)) byFile.set(b.file, []);
  byFile.get(b.file)!.push(b);
}

let md = `# Role × Functionality Matrix\n\n`;
md += `Generated from \`server/routers/**/*.ts\` via \`authzScan.lib.ts\` (${blocks.length} procedures across ${byFile.size} router files).\n\n`;
md += `Columns: procedure kind = the base-procedure access tier it's built on (this is the FIRST line of defense — public/protected/internal/operator/analyst/admin); guard mechanism = the specific in-body check found (second line of defense for protectedProcedure-based ones, which carry no automatic tenant scoping).\n\n`;
md += `Rows flagged **⚠ UNGUARDED** are procedures the static scanner could not find ANY tenant/role guard for and that were NOT in the reviewed exemption allowlist — these are exactly the class QA-005/006/011 hunted for manually; this table is the systematic version of that same check, covering all ${blocks.length} procedures instead of a sample.\n\n`;

let totalUnguarded = 0;
let totalMoneyUnguarded = 0;

for (const [file, procs] of Array.from(byFile.entries()).sort()) {
  md += `## \`${file}\`\n\n`;
  md += `| Procedure | Verb | Kind | Guard mechanism | Money-relevant | Tenant-relevant | Status |\n`;
  md += `|---|---|---|---|---|---|---|\n`;
  for (const b of procs) {
    const guarded = isGuarded(b);
    const tenantRelevant = isTenantRelevant(b);
    const money = MONEY_RE.test(b.stripped);
    const verb = verbOf(b);
    const mech = guardMechanism(b);
    const status = guarded ? "OK" : "⚠ UNGUARDED";
    if (!guarded) {
      totalUnguarded++;
      if (money) totalMoneyUnguarded++;
    }
    md += `| ${b.name} | ${verb} | ${b.kind} | ${mech} | ${money ? "yes" : ""} | ${tenantRelevant ? "yes" : ""} | ${status} |\n`;
  }
  md += `\n`;
}

md = md.replace(
  "Rows flagged",
  `**Summary: ${totalUnguarded} unguarded procedure(s) found (${totalMoneyUnguarded} money-relevant).**\n\nRows flagged`,
);

writeFileSync(join(__dirname, "../role-functionality-matrix.md"), md);
console.log(`Wrote .qa/role-functionality-matrix.md: ${blocks.length} procedures, ${totalUnguarded} unguarded (${totalMoneyUnguarded} money-relevant).`);
