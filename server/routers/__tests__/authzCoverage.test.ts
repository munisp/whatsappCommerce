/**
 * W12.1 authorization-coverage ratchet (source scan).
 *
 * Scans every router file and proves that tenant-scoped procedures cannot
 * silently lose their guard again:
 *   1. Procedures whose input REQUIRES `tenantId` must call
 *      assertTenantAccess (or an equivalent inline tenant check / a
 *      role-scoped procedure such as adminProcedure / operatorProcedure).
 *   2. The W12.1 surgical guards (id-keyed lookups, optional-tenantId list
 *      filters, admin-only procedures) stay in place.
 *   3. The total count of guarded procedures is a ratchet — it may only go
 *      up. Lower the number only by deleting a procedure, never a guard.
 *
 * This test caught onboarding.getProgress (direct tenantId read with no
 * guard) when first introduced.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

const ROUTERS_DIR = join(__dirname, "..");

interface ProcBlock {
  file: string;
  name: string;
  kind: string;
  body: string;
}

function procedureBlocks(file: string): ProcBlock[] {
  const src = readFileSync(join(ROUTERS_DIR, file), "utf8");
  const starts = [
    ...src.matchAll(/^\s{2}(\w+):\s*(protectedProcedure|publicProcedure|adminProcedure|operatorProcedure|analystProcedure)\b/gm),
  ];
  const blocks: ProcBlock[] = [];
  for (let i = 0; i < starts.length; i++) {
    const m = starts[i];
    const end = i + 1 < starts.length ? starts[i + 1].index! : src.length;
    blocks.push({
      file,
      name: m[1],
      kind: m[2],
      body: src.slice(m.index, end),
    });
  }
  return blocks;
}

const allBlocks: ProcBlock[] = readdirSync(ROUTERS_DIR)
  .filter((f) => f.endsWith(".ts"))
  .flatMap(procedureBlocks);

const REQUIRED_TENANT_RE = /tenantId:\s*z\.string\(\)(?!\s*\.optional)/;

function hasRequiredTenantId(b: ProcBlock): boolean {
  return REQUIRED_TENANT_RE.test(b.body);
}

function isGuarded(b: ProcBlock): boolean {
  if (b.kind === "adminProcedure" || b.kind === "operatorProcedure" || b.kind === "analystProcedure") return true;
  if (b.kind === "publicProcedure") return true; // public surface reviewed separately
  if (b.body.includes("assertTenantAccess")) return true;
  if (b.body.includes("assertNlpSessionAccess") || b.body.includes("assertTemplateAccess")) return true;
  // Inline equivalent: explicit ctx.user.tenantId comparison + FORBIDDEN.
  if (b.body.includes("ctx.user.tenantId") && b.body.includes("FORBIDDEN")) return true;
  if (b.body.includes("ctx.user?.tenantId") && b.body.includes("FORBIDDEN")) return true;
  return false;
}

describe("W12.1 authz coverage ratchet", () => {
  it("every procedure with a required tenantId input is tenant-guarded", () => {
    const offenders = allBlocks
      .filter((b) => hasRequiredTenantId(b) && !isGuarded(b))
      .map((b) => `${b.file.replace(/\.ts$/, "")}.${b.name} (${b.kind})`);
    expect(offenders).toEqual([]);
  });

  it("W12.1 id-keyed surgical guards stay in place", () => {
    const expectGuarded: Array<[string, string, string]> = [
      // [file, procedure, guard marker]
      ["invoice.ts", "send", "assertTenantAccess"],
      ["invoice.ts", "markPaid", "assertTenantAccess"],
      ["invoice.ts", "get", "assertTenantAccess"],
      ["conversation.ts", "updateStatus", "assertTenantAccess"],
      ["cogsDispute.ts", "review", "FORBIDDEN"],
      ["logistics.ts", "simulateDelivery", "assertTenantAccess"],
      ["marketplace.ts", "listSellers", "assertTenantAccess"],
      ["broadcast.ts", "cancel", "assertTenantAccess"],
      ["broadcast.ts", "simulateDelivery", "assertTenantAccess"],
      ["nlp.ts", "resetSession", "assertNlpSessionAccess"],
      ["nlp.ts", "syncOfflineQueue", "assertNlpSessionAccess"],
      ["nlp.ts", "getOfflineQueueCount", "assertNlpSessionAccess"],
      ["nlp.ts", "getQueuedMessages", "assertNlpSessionAccess"],
      ["slaExtension.ts", "listByEscrow", "assertTenantAccess"],
      ["templateVersions.ts", "list", "assertTemplateAccess"],
      ["templateVersions.ts", "create", "assertTemplateAccess"],
      ["whatsappNotifications.ts", "sendOrderNotif", "assertTenantAccess"],
      ["whatsappNotifications.ts", "getOrderNotifStatus", "assertTenantAccess"],
      ["whatsappNotifications.ts", "resendNotification", "assertTenantAccess"],
      ["whatsappNotifications.ts", "getCustomerReplies", "assertTenantAccess"],
      ["onboarding.ts", "getProgress", "assertTenantAccess"],
    ];
    const missing: string[] = [];
    for (const [file, proc, marker] of expectGuarded) {
      const block = allBlocks.find((b) => b.file === file && b.name === proc);
      if (!block) {
        missing.push(`${file}:${proc} (procedure not found)`);
      } else if (!block.body.includes(marker)) {
        missing.push(`${file}:${proc} (missing ${marker})`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("W12.1 optional-tenantId filter guards and admin-only procedures stay in place", () => {
    const expectGuarded: Array<[string, string, string]> = [
      ["agent.ts", "listAuditLog", "assertTenantAccess"],
      ["broadcast.ts", "list", "assertTenantAccess"],
      ["hermes.ts", "getEventLog", "assertTenantAccess"],
      ["hermes.ts", "getPOQueue", "assertTenantAccess"],
      ["logistics.ts", "listShipments", "assertTenantAccess"],
      ["marketplace.ts", "listCommissions", "assertTenantAccess"],
      ["temporal.ts", "startInventorySync", "assertTenantAccess"],
      ["payment.ts", "getLedgerBalance", "Admin access required"],
    ];
    const missing: string[] = [];
    for (const [file, proc, marker] of expectGuarded) {
      const block = allBlocks.find((b) => b.file === file && b.name === proc);
      if (!block) {
        missing.push(`${file}:${proc} (procedure not found)`);
      } else if (!block.body.includes(marker)) {
        missing.push(`${file}:${proc} (missing ${marker})`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("guard count ratchet: assertTenantAccess call sites never regress", () => {
    const count = allBlocks.reduce(
      (n, b) => n + (b.body.match(/assertTenantAccess\(/g)?.length ?? 0),
      0,
    );
    // W12.1 baseline after this hardening wave. Only ever increase this.
    expect(count).toBeGreaterThanOrEqual(100);
  });
});
