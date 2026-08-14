/**
 * W12.1 + A2-02 authorization-coverage ratchet (source scan).
 *
 * Scans every router file and proves that tenant-scoped procedures cannot
 * silently lose their guard again:
 *   1. Procedures whose input REQUIRES `tenantId` must call
 *      assertTenantAccess (or an equivalent inline tenant check / a
 *      role-scoped procedure such as adminProcedure / operatorProcedure).
 *   2. A2-02: module-level `const X = z.object({...})` schemas used via
 *      `.input(X)` are resolved before the check (closes the
 *      hermes.saveConfig evasion class).
 *   3. A2-02: id-keyed inputs (*Id/*id: orderId, poId, accountId, …) are
 *      tenant-relevant even without a literal tenantId and require a guard
 *      on comment-stripped source, or a parsed `// authz:exempt <reason>`
 *      marker.
 *   4. A2-02: guard detection runs on comment-stripped source — a guard
 *      mentioned only in a comment no longer counts.
 *   5. The W12.1 surgical guards (id-keyed lookups, optional-tenantId list
 *      filters, admin-only procedures) stay in place.
 *   6. The total count of guarded procedures is a ratchet — it may only go
 *      up. Lower the number only by deleting a procedure, never a guard.
 *
 * This test caught onboarding.getProgress (direct tenantId read with no
 * guard) when first introduced.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  procedureBlocksFromSource,
  scanRouterDir,
  isTenantRelevant,
  isGuarded,
  type ProcBlock,
} from "./authzScan.lib";

const ROUTERS_DIR = join(__dirname, "..");

const allBlocks: ProcBlock[] = scanRouterDir(ROUTERS_DIR);

describe("W12.1/A2-02 authz coverage ratchet", () => {
  it("every tenant-relevant procedure is guarded or carries a parsed exemption", () => {
    const offenders = allBlocks
      .filter((b) => isTenantRelevant(b) && !isGuarded(b))
      .map((b) => `${b.file.replace(/\.ts$/, "")}.${b.name} (${b.kind})`);
    expect(offenders).toEqual([]);
  });

  it("exemption count is capped (each must carry a parsed reason)", () => {
    const exempt = allBlocks.filter((b) => b.exempt);
    // Emit the full list so reviews see every exemption.
    console.log(
      "authz exemptions:\n" +
        exempt
          .map((b) => `  ${b.file.replace(/\.ts$/, "")}.${b.name} — ${b.exempt}`)
          .join("\n"),
    );
    // A2-02 genuine-exemption count after the hardening pass; only lower this
    // by fixing procedures, raise it only with an audit-reviewed reason.
    expect(exempt.length).toBeLessThanOrEqual(17);
    for (const b of exempt) {
      expect(b.exempt!.length).toBeGreaterThan(10); // real reason, not a token
    }
  });

  it("A2-02 fixture: scanner catches the three evasion classes", () => {
    const fixtureSrc = readFileSync(
      join(__dirname, "fixtures", "evasion.fixture.ts"),
      "utf8",
    );
    const blocks = procedureBlocksFromSource(fixtureSrc, "evasion.fixture.ts");
    const flagged = new Set(
      blocks.filter((b) => isTenantRelevant(b) && !isGuarded(b)).map((b) => b.name),
    );
    // 1. module-level-schema unguarded saveConfig pattern
    expect(flagged.has("saveConfig")).toBe(true);
    // 2. id-keyed unguarded proc
    expect(flagged.has("deletePriceTier")).toBe(true);
    // 3. comment-only guard does not satisfy the scanner
    expect(flagged.has("updateSettings")).toBe(true);
    // Controls: real guard and parsed exemption must NOT be flagged
    expect(flagged.has("saveConfigGuarded")).toBe(false);
    expect(flagged.has("publicWebhookish")).toBe(false);
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
      // A2-02 hardening wave (load-then-assert on id-keyed procedures)
      ["b2b.ts", "deletePriceTier", "assertTenantAccess"],
      ["b2b.ts", "quoteRfq", "assertTenantAccess"],
      ["b2b.ts", "updateRfqStatus", "assertTenantAccess"],
      ["b2b.ts", "approvePurchaseOrder", "assertTenantAccess"],
      ["b2b.ts", "updatePoStatus", "assertTenantAccess"],
      ["broadcast.ts", "get", "assertTenantAccess"],
      ["compliance.ts", "submitTaxFiling", "assertTenantAccess"],
      ["compliance.ts", "updateCacStatus", "assertTenantAccess"],
      ["compliance.ts", "submitProcurementBid", "assertTenantAccess"],
      ["logistics.ts", "getShipment", "assertTenantAccess"],
      ["marketplace.ts", "getSeller", "assertTenantAccess"],
      ["marketplace.ts", "settleCommission", "assertTenantAccess"],
      ["medusa.ts", "importProductsToMenu", "assertTenantAccess"],
      ["productImages.ts", "updateBbox", "assertTenantAccess"],
      ["productImages.ts", "rateImage", "assertTenantAccess"],
      ["productImages.ts", "deleteImage", "assertTenantAccess"],
      ["serviceCommerce.ts", "updateAppointmentStatus", "assertTenantAccess"],
      ["serviceCommerce.ts", "cancelSubscription", "assertTenantAccess"],
      ["templateVersions.ts", "publish", "assertTemplateAccess"],
      ["templateVersions.ts", "revert", "assertTemplateAccess"],
      ["templateVersions.ts", "archive", "assertTemplateAccess"],
      ["whatsappNotifications.ts", "suggestReply", "assertTenantAccess"],
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

  it("A2-02 admin/operator-scoped procedures stay role-scoped", () => {
    const expectKind: Array<[string, string, string]> = [
      ["webhookDlq.ts", "retryEvent", "adminProcedure"],
      ["webhookDlq.ts", "dismissEvent", "adminProcedure"],
      ["keycloak.ts", "testConnection", "operatorProcedure"],
    ];
    const wrong: string[] = [];
    for (const [file, proc, kind] of expectKind) {
      const block = allBlocks.find((b) => b.file === file && b.name === proc);
      if (!block) wrong.push(`${file}:${proc} (procedure not found)`);
      else if (block.kind !== kind) wrong.push(`${file}:${proc} (is ${block.kind}, want ${kind})`);
    }
    expect(wrong).toEqual([]);
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
    // W12.1+A2-02 baseline after this hardening wave. Only ever increase this.
    expect(count).toBeGreaterThanOrEqual(115);
  });

  it("scanned-procedure count ratchet: a reindent cannot silently un-scan files", () => {
    // 616 procedures at W12.1; 632 after later waves. Only ever increase.
    expect(allBlocks.length).toBeGreaterThanOrEqual(630);
  });
});
