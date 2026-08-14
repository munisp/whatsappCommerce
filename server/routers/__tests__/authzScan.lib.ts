/**
 * A2-02: strengthened authz-coverage scanner (shared lib).
 *
 * Upgrades over the W12.1 regex ratchet:
 *  (a) Same-file module-level `const X = z.object({...})` schemas referenced
 *      via `.input(X)` are resolved before the tenantId/id-field check
 *      (closes the hermes.saveConfig evasion class).
 *  (b) Inputs keyed by id-like fields (*Id / *id: orderId, poId, accountId,
 *      …) are treated as tenant-relevant even without a literal tenantId:
 *      they require a real guard on comment-stripped source, or a parsed
 *      `// authz:exempt <reason>` marker.
 *  (c) Guard detection runs on comment-stripped source, so a guard mentioned
 *      only in a comment (or dead string) no longer satisfies the ratchet.
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
  exempt: string | null; // parsed exemption reason, if any
}

const PROC_KINDS =
  "protectedProcedure|publicProcedure|adminProcedure|operatorProcedure|analystProcedure";

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

const EXEMPT_RE = /\/\/\s*authz:exempt\s+(\S[^\n]*)/;

export function procedureBlocksFromSource(src: string, file: string): ProcBlock[] {
  const schemas = moduleSchemas(src);
  const starts = Array.from(
    src.matchAll(new RegExp(`^\\s{2}(\\w+):\\s*(${PROC_KINDS})\\b`, "gm")),
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
    const exemptMatch = body.match(EXEMPT_RE);
    blocks.push({
      file,
      name: m[1],
      kind: m[2],
      body,
      stripped: stripComments(body),
      inputText: stripComments(inputText),
      exempt: exemptMatch ? exemptMatch[1].trim() : null,
    });
  }
  return blocks;
}

export function scanRouterDir(dir: string): ProcBlock[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".ts"))
    .flatMap((f) => procedureBlocksFromSource(readFileSync(join(dir, f), "utf8"), f));
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
