import { scanRouterDir } from "../../server/routers/__tests__/authzScan.lib";

const ROUTERS_DIR = "/Users/tanitoluwaifegbesan/Documents/whatsappCommerce/server/routers";
const blocks = scanRouterDir(ROUTERS_DIR);

// Candidate anti-pattern: the procedure's input carries BOTH a tenantId and
// an id-like field (suggesting "operate on a specific tenant-owned resource
// by id"), the guard is assertTenantAccess/assertMoneyAccess called with the
// CLIENT-SUPPLIED input.tenantId (not a value derived from a fetched row),
// AND the id-keyed DB lookup does not also filter by tenantId in the same
// query. This is the exact class QA-003 (b2b.ts, before the fix pattern was
// established) and the tradeCredit.ts findings belonged to — this scan is
// looking for the same shape more broadly (not IDOR risk, since assert
// happens first, but flags where the resource itself is never confirmed to
// belong to the caller's tenant, so a caller who is legitimately staff of
// tenant A but supplies another tenant's resource id could hit an object
// they don't own if the underlying store call has no tenant filter itself).
const idFieldPattern = /(\w*(?:Id|ID))\s*:\s*z\./g;
const clientTenantAssert = /assert(?:TenantAccess|MoneyAccess)\(ctx\.user,\s*input\.tenantId\)/;

const candidates: { file: string; name: string; idFields: string[] }[] = [];

for (const b of blocks) {
  if (b.exempt) continue;
  if (!b.inputText.includes("tenantId")) continue;
  if (!clientTenantAssert.test(b.stripped)) continue;
  const idFields = [...b.inputText.matchAll(idFieldPattern)]
    .map((m) => m[1])
    .filter((f) => f !== "tenantId" && f.toLowerCase() !== "id" === false || f !== "tenantId");
  const realIdFields = [...new Set(idFields)].filter((f) => f !== "tenantId");
  if (realIdFields.length === 0) continue;
  candidates.push({ file: b.file, name: b.name, idFields: realIdFields });
}

console.log(`Total procedures scanned: ${blocks.length}`);
console.log(`Candidates (client-supplied-tenantId assert + an id-like field in input): ${candidates.length}\n`);
for (const c of candidates) {
  console.log(`${c.file}:${c.name}  [id fields: ${c.idFields.join(", ")}]`);
}
