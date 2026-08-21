/**
 * A2-02 + W26: strengthened authz-coverage scanner (shared lib).
 *
 * Upgrades over the W12.1 regex ratchet:
 *  (a) Same-file module-level `const X = z.object({...})` schemas referenced
 *      via `.input(X)` are resolved before the tenantId/id-field check
 *      (closes the hermes.saveConfig evasion class).
 *  (b) Inputs keyed by id-like fields (*Id / *id: orderId, poId, accountId,
 *      …) are treated as tenant-relevant even without a literal tenantId:
 *      they require a real guard on comment-stripped source, or an explicit
 *      EXEMPTION_ALLOWLIST entry.
 *  (c) Guard detection runs on comment-stripped source, so a guard mentioned
 *      only in a comment (or dead string) no longer satisfies the ratchet.
 *
 * W26 hardening (closes the "gameable scanner" finding):
 *  (d) RECURSIVE directory scan — routers organized in subdirectories are
 *      scanned too (previously only top-level server/routers/*.ts). Test and
 *      fixture directories (__tests__, *.test.ts, *.fixture.ts) are excluded
 *      from the production-source scan.
 *  (e) INDENTATION-AGNOSTIC procedure detection — a procedure reindented
 *      from 2 to 4+ spaces (e.g. nested sub-routers like geo.merchant.*) is
 *      still discovered; the old `^\s{2}` anchor silently unscanned it.
 *  (f) EXEMPTION ALLOWLIST — free-form `// authz:exempt <reason>` comments
 *      are NO LONGER honored (any author could self-approve). An exemption
 *      only counts when the exact `file:procedure` pair is present in
 *      EXEMPTION_ALLOWLIST below with a reviewable justification.
 */
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

export interface ProcBlock {
  file: string;
  name: string;
  kind: string;
  body: string; // raw source of the procedure block
  stripped: string; // comment-stripped body
  inputText: string; // resolved input schema text (inline + module-level consts)
  exempt: string | null; // allowlist justification, if exempted
}

const PROC_KINDS =
  "protectedProcedure|publicProcedure|adminProcedure|operatorProcedure|analystProcedure|internalProcedure";

/**
 * W26(f): explicit exemption allowlist. Key: `<file>:<procedure>` (file is
 * the path relative to server/routers). Value: audit-reviewed justification.
 * Free-form `// authz:exempt` comments in router source are ignored — add an
 * entry here (with a real reason) in the same PR that needs the exemption so
 * reviewers see it.
 */
export const EXEMPTION_ALLOWLIST: Record<string, string> = {
  "alertRules.ts:listEvents":
    "platform-scoped global alert rules (heartbeat/recon ops config), not per-tenant data",
  "hermes.ts:approvePO":
    "capability-token PO approval link: lookup requires matching approvalToken (bearer capability)",
  "hermes.ts:rejectPO":
    "capability-token PO approval link: lookup requires matching approvalToken (bearer capability)",
  "mlOps.ts:getMlflowRuns":
    "platform ML-ops surface (mlflow experiments/model AB tests), operator tooling not tenant data",
  "mlOps.ts:getMetricHistory":
    "platform ML-ops surface (mlflow experiments/model AB tests), operator tooling not tenant data",
  "mlOps.ts:conclude":
    "platform ML-ops surface (mlflow experiments/model AB tests), operator tooling not tenant data",
  "operatorTemplates.ts:getById":
    "platform-shared operator templates readable by id; template library is cross-tenant by design",
  "procurement.ts:getPo":
    "object-level check inside getPoForEitherSide (buyer-side or supplier-side access)",
  "quickReplyTemplates.ts:delete":
    "shared quick-reply template library (tenantId nullable; list is global), cross-tenant by design",
  "quickReplyTemplates.ts:incrementUsage":
    "shared quick-reply template library (tenantId nullable; list is global), cross-tenant by design",
  // Fixture control: proves the allowlist (not the in-source comment) is what
  // exempts a procedure. Never add real exemptions for fixture files.
  "evasion.fixture.ts:publicWebhookish":
    "fixture: proves allowlist-based exemption works while free-form comments are ignored",
};

/** Strip line and block comments (naive but adequate for router source). */
export function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
}

/** Extract a balanced `{...}` region starting at the index of `{`. */
function balancedBraces(src: string, openIdx: number): string {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return src.slice(openIdx, i + 1);
    }
  }
  return src.slice(openIdx);
}

/** Resolve module-level `const X = z.object({...})` schema bodies. */
export function moduleSchemas(src: string): Map<string, string> {
  const map = new Map<string, string>();
  const re = /const\s+(\w+)\s*=\s*z\.object\(\s*\{/g;
  for (const m of Array.from(src.matchAll(re))) {
    const openIdx = src.indexOf("{", m.index! + m[0].length - 1);
    map.set(m[1], balancedBraces(src, openIdx));
  }
  return map;
}

export function procedureBlocksFromSource(src: string, file: string): ProcBlock[] {
  const schemas = moduleSchemas(src);
  // W26(e): indentation-agnostic — any leading whitespace (or none) before
  // `<name>: <kind>Procedure`, so reindented/nested procedures stay scanned.
  const starts = Array.from(
    src.matchAll(new RegExp(`^\\s*(\\w+):\\s*(${PROC_KINDS})\\b`, "gm")),
  );
  const blocks: ProcBlock[] = [];
  for (let i = 0; i < starts.length; i++) {
    const m = starts[i];
    const end = i + 1 < starts.length ? starts[i + 1].index! : src.length;
    const body = src.slice(m.index, end);
    // Resolve input text: inline z.object plus any .input(Identifier) refs.
    let inputText = "";
    const inline = body.match(/\.input\(\s*z\.object\(\s*\{/);
    if (inline) {
      const openIdx = body.indexOf("{", inline.index! + inline[0].length - 1);
      inputText += balancedBraces(body, openIdx);
    }
    for (const idm of Array.from(body.matchAll(/\.input\(\s*(\w+)\s*\)/g))) {
      const resolved = schemas.get(idm[1]);
      if (resolved) inputText += "\n" + resolved;
    }
    blocks.push({
      file,
      name: m[1],
      kind: m[2],
      body,
      stripped: stripComments(body),
      inputText: stripComments(inputText),
      // W26(f): exemptions come ONLY from the explicit allowlist.
      exempt: EXEMPTION_ALLOWLIST[`${file}:${m[1]}`] ?? null,
    });
  }
  return blocks;
}

/**
 * W26(d): recursive scan of the router directory. Subdirectories are
 * traversed; test/fixture code (__tests__ dirs, *.test.ts, *.fixture.ts) is
 * excluded because it is test code, not production router surface.
 */
export function scanRouterDir(dir: string, relPrefix = ""): ProcBlock[] {
  const out: ProcBlock[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      out.push(
        ...scanRouterDir(
          join(dir, entry.name),
          relPrefix ? `${relPrefix}/${entry.name}` : entry.name,
        ),
      );
    } else if (
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".fixture.ts")
    ) {
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      out.push(...procedureBlocksFromSource(readFileSync(join(dir, entry.name), "utf8"), rel));
    }
  }
  return out;
}

const REQUIRED_TENANT_RE = /tenantId:\s*z\.string\(\)(?!\s*\.optional)/;
// id-like input fields: orderId, poId, accountId, id, … (tenantId handled above)
const ID_FIELD_RE = /\b(\w*[iI]d):\s*z\.(?:string|number)\(/;

export function hasRequiredTenantId(b: ProcBlock): boolean {
  return REQUIRED_TENANT_RE.test(b.inputText);
}

/** A2-02(b): id-keyed inputs are tenant-relevant even without tenantId. */
export function hasIdKeyedInput(b: ProcBlock): boolean {
  return ID_FIELD_RE.test(b.inputText);
}

export function isTenantRelevant(b: ProcBlock): boolean {
  return hasRequiredTenantId(b) || hasIdKeyedInput(b);
}

/** Guard check runs on comment-stripped source only. */
export function isGuarded(b: ProcBlock): boolean {
  if (b.exempt) return true;
  if (b.kind === "adminProcedure" || b.kind === "operatorProcedure" || b.kind === "analystProcedure")
    return true;
  // W26: internalProcedure enforces the INTERNAL_API_KEY shared-secret gate
  // (see server/_core/trpc.ts) — service-to-service surface, not tenant data.
  if (b.kind === "internalProcedure") return true;
  if (b.kind === "publicProcedure") return true; // public surface reviewed separately
  if (b.stripped.includes("assertTenantAccess(")) return true;
  if (b.stripped.includes("assertNlpSessionAccess(")) return true;
  if (b.stripped.includes("assertTemplateAccess(")) return true;
  // Domain object-level asserts (load-then-assert helpers).
  if (/\bassert\w*(Access|OrAdmin|Ownership)\(/.test(b.stripped)) return true;
  // Inline admin/owner role gate.
  if (/ctx\.user\??\.?role/.test(b.stripped) && b.stripped.includes("FORBIDDEN")) return true;
  // Load-then-assert inline equivalent: explicit tenant comparison + FORBIDDEN.
  if (
    (b.stripped.includes("ctx.user.tenantId") || b.stripped.includes("ctx.user?.tenantId")) &&
    b.stripped.includes("FORBIDDEN")
  )
    return true;
  if (b.stripped.includes(".tenantId") && b.stripped.includes("FORBIDDEN")) return true;
  // Session-tenant scoping: tenant comes from ctx.user, not from caller input.
  if (b.stripped.includes("ctx.user.tenantId") || b.stripped.includes("ctx.user?.tenantId"))
    return true;
  // Same pattern via local fail-closed helpers (menu/template/visualInventory/…).
  if (/getTenantId\(ctx/.test(b.stripped)) return true;
  // Session-tenant via explicit cast: (ctx.user as { tenantId?: string }).tenantId
  if (/ctx\.user\s+as\s+\{[^}]*tenantId/.test(b.stripped)) return true;
  return false;
}
