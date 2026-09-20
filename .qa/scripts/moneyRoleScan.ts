import { scanRouterDir } from "../../server/routers/__tests__/authzScan.lib";

const ROUTERS_DIR = "/Users/tanitoluwaifegbesan/Documents/whatsappCommerce/server/routers";
const blocks = scanRouterDir(ROUTERS_DIR);

// Money-movement signal: procedure name suggests it creates/moves/approves
// financial exposure (limits, balances, payouts, refunds, etc.)
const NAME_SIGNAL = /(approve|reject|settle|payout|refund|repay|withdraw|disburs|charge|debit|credit|limit|balance|redeem|void|capture|waive|writeoff|write[- ]?off|commission|payable|invoice|bill|fee|bounty|payment|pay(?!load)|transfer|reconcile|grant|revoke|reverse|adjust|discount|price|cost|draw)/i;
const MONEY_ALREADY_GUARDED = /assertMoneyAccess\(|assertCapabilityAccess\(/;
const TENANT_ACCESS_ONLY = /assertTenantAccess\(/;

const candidates = blocks.filter((b) => {
  if (b.exempt) return false;
  if (b.kind !== "protectedProcedure") return false; // admin/operator/analyst procedures already role-scoped
  if (!TENANT_ACCESS_ONLY.test(b.stripped)) return false;
  if (MONEY_ALREADY_GUARDED.test(b.stripped)) return false; // already money-gated somewhere in body too
  if (!NAME_SIGNAL.test(b.name)) return false;
  return true;
});

console.log(`Total procedures scanned: ${blocks.length}`);
console.log(`Candidates (protectedProcedure + assertTenantAccess only + money-ish name): ${candidates.length}\n`);
for (const c of candidates) {
  console.log(`${c.file}:${c.name} (${c.kind})`);
}
