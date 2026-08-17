/**
 * SOC2 controls self-check (assurance: CC4.4 / CC8.3).
 *
 * Run:  npx tsx scripts/soc2-check.ts
 *
 * Static checks that key control artifacts exist and basic hygiene holds:
 *   - SOC2 docs pack present (docs/SOC2/*.md)
 *   - hash-chained audit service, compliance router, retention service present
 *   - authz-coverage scanner present
 *   - payment confirmation invariant file present (byte-locked control)
 *   - env.example.txt contains no real-looking secrets
 *
 * Statuses: PASS / FAIL / WARN.
 *   FAIL  — a control artifact owned by this wave is missing or broken.
 *   WARN  — artifact expected from a parallel wave (server compliance stack)
 *           is not yet present in this tree.
 * Exit code is non-zero iff any check FAILs.
 *
 * The check functions are exported for `scripts/soc2-check.test.ts`.
 */
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";

export type CheckStatus = "PASS" | "FAIL" | "WARN";

export interface CheckResult {
  id: string;
  control: string;
  status: CheckStatus;
  detail: string;
}

export const SOC2_DOCS = [
  "docs/SOC2/SYSTEM_DESCRIPTION.md",
  "docs/SOC2/TSC_CONTROL_MATRIX.md",
  "docs/SOC2/INCIDENT_RUNBOOK.md",
  "docs/SOC2/VENDOR_REGISTER.md",
  "docs/SOC2/CHANGE_MANAGEMENT.md",
  "docs/SOC2/DATA_CLASSIFICATION.md",
] as const;

/** Artifacts delivered by the parallel server wave: WARN (not FAIL) if absent. */
export const PARALLEL_WAVE_FILES = [
  "server/services/auditChain.ts",
  "server/services/retention.ts",
] as const;

function exists(root: string, rel: string): boolean {
  return existsSync(join(root, rel));
}

export function checkDocsPack(root: string): CheckResult[] {
  return SOC2_DOCS.map((rel) => ({
    id: `docs:${rel}`,
    control: "CC2.1/CC7.2 SOC2 documentation pack",
    status: exists(root, rel) ? "PASS" : "FAIL",
    detail: exists(root, rel) ? `${rel} present` : `${rel} missing`,
  }));
}

export function checkControlFiles(root: string): CheckResult[] {
  const results: CheckResult[] = [];
  const hard: Array<[string, string, string]> = [
    ["server/routers/compliance.ts", "CC-series", "compliance router"],
    ["server/routers/__tests__/authzScan.lib.ts", "CC4.2/CC6.1", "authz-coverage scanner lib"],
    ["server/routers/__tests__/authzCoverage.test.ts", "CC4.2/CC6.1", "authz-coverage ratchet test"],
    ["server/services/paymentConfirm.ts", "CC5.1/CC8.3", "payment confirm invariant (byte-locked)"],
    ["scripts/soc2-check.ts", "CC4.4", "this self-check script"],
  ];
  for (const [rel, cc, label] of hard) {
    results.push({
      id: `file:${rel}`,
      control: `${cc} ${label}`,
      status: exists(root, rel) ? "PASS" : "FAIL",
      detail: exists(root, rel) ? `${rel} present` : `${rel} missing`,
    });
  }
  for (const rel of PARALLEL_WAVE_FILES) {
    results.push({
      id: `file:${rel}`,
      control: "CC4.1/C1.3 parallel-wave server artifact",
      status: exists(root, rel) ? "PASS" : "WARN",
      detail: exists(root, rel)
        ? `${rel} present`
        : `${rel} not yet in tree (owned by parallel server wave)`,
    });
  }
  return results;
}

/**
 * Placeholder markers commonly used in env.example.txt. A value is suspicious
 * if it is long and contains none of these markers.
 */
const PLACEHOLDER_MARKERS = [
  "change-me",
  "your-",
  "your_",
  "example",
  "placeholder",
  "xxx",
  "...",
  "todo",
  "replace",
  "<",
  ">",
];

/** Values that are URLs/pointers, not secrets. */
const NON_SECRET_VALUE = /^https?:\/\//i;
/** Explicit dev-environment defaults, e.g. `dev-internal-key`, `keycloak_dev_2026`. */
const DEV_DEFAULT = /(^|[-_])dev([-_]|$|\d)/i;
/**
 * Well-known PUBLIC vendor example defaults (documented upstream, not real
 * tenant secrets). edd1c9…8f1 is the Apache APISIX documentation default
 * admin key — safe in an example file.
 */
const KNOWN_PUBLIC_DEFAULTS = new Set(["edd1c9f034335f136f87ad84b625c8f1"]);

export interface EnvFinding {
  line: number;
  key: string;
  reason: string;
}

export function scanEnvExample(content: string): EnvFinding[] {
  const findings: EnvFinding[] = [];
  const lines = content.split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!m) return;
    const [, key, rawVal] = m;
    const val = rawVal.trim().replace(/^["']|["']$/g, "");
    if (!val) return;
    if (NON_SECRET_VALUE.test(val)) return;
    if (DEV_DEFAULT.test(val)) return;
    if (KNOWN_PUBLIC_DEFAULTS.has(val)) return;
    const lower = val.toLowerCase();
    const isSensitiveKey = /(SECRET|TOKEN|KEY|PASSWORD|PASS|PWD)/.test(key) && !/(_URL|_URI|_HOST)$/.test(key);
    if (!isSensitiveKey) return;
    const looksPlaceholder = PLACEHOLDER_MARKERS.some((mk) => lower.includes(mk));
    // Long, marker-free sensitive values look like real secrets.
    if (!looksPlaceholder && val.length >= 16) {
      findings.push({ line: i + 1, key, reason: `value for ${key} looks like a real secret (len ${val.length})` });
    }
  });
  return findings;
}

export function checkEnvExample(root: string): CheckResult {
  const rel = "env.example.txt";
  if (!exists(root, rel)) {
    return { id: "env:example", control: "CC6.4 env example file", status: "FAIL", detail: `${rel} missing` };
  }
  const findings = scanEnvExample(readFileSync(join(root, rel), "utf8"));
  return {
    id: "env:example",
    control: "CC6.4 env.example.txt contains no real-looking secrets",
    status: findings.length === 0 ? "PASS" : "FAIL",
    detail:
      findings.length === 0
        ? "no real-looking secrets found"
        : findings.map((f) => `L${f.line} ${f.reason}`).join("; "),
  };
}

export function runChecks(root: string): CheckResult[] {
  return [...checkDocsPack(root), ...checkControlFiles(root), checkEnvExample(root)];
}

export function summarize(results: CheckResult[]): { exitCode: number; counts: Record<CheckStatus, number> } {
  const counts: Record<CheckStatus, number> = { PASS: 0, FAIL: 0, WARN: 0 };
  for (const r of results) counts[r.status]++;
  return { exitCode: counts.FAIL > 0 ? 1 : 0, counts };
}

const invokedPath = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] || process.argv[1].endsWith("soc2-check.ts") : false;
const isMain = invokedPath && !process.env.VITEST;

if (isMain) {
  const root = process.cwd();
  const results = runChecks(root);
  for (const r of results) {
    console.log(`${r.status.padEnd(4)} [${r.id}] ${r.control} — ${r.detail}`);
  }
  const { exitCode, counts } = summarize(results);
  console.log(
    `\nsoc2-check: ${counts.PASS} PASS, ${counts.WARN} WARN, ${counts.FAIL} FAIL → exit ${exitCode}`,
  );
  process.exit(exitCode);
}
