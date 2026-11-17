// === W67 opendal ===
/**
 * J632 — uc-docs statement write+read through the OpenDAL facade: a wallet
 * statement generation persists the PDF via docsPut (fs scheme keeps the
 * exact UC_DOCS_DIR layout — asserted on disk), the manifest RMW round-trips
 * through the facade, and docsGet returns the same bytes.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { seedUcTenant } from "./w46-uc-docs-seed";

export const journey: Journey = {
  id: "J632",
  name: "uc-docs statement write+read through the OpenDAL facade (manifest RMW)",
  feature: "W67 OpenDAL storage layer",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "j632-ucdocs-"));
    const prevDocs = process.env.UC_DOCS_DIR;
    const prevScheme = process.env.OPENDAL_SCHEME;
    process.env.UC_DOCS_DIR = dir;
    process.env.OPENDAL_SCHEME = "fs";
    try {
      const od = await import("../../server/services/opendalStorage");
      od._resetOpendalForTests();
      const svc = await import("../../server/services/walletStatements");
      const { tenantId } = await seedUcTenant(world, "632", 6320);
      const walletId = "wal-w67-632";
      await world.db.insert(schema.merchantWallets).values({
        id: walletId, tenantId, availableBalance: "100.00", currency: "NGN", isActive: true,
      }).onConflictDoNothing();
      await world.db.insert(schema.walletTransactions).values({
        id: "wtx-632-0", walletId, tenantId, type: "escrow_release", amount: "100.00",
        balanceBefore: "0.00", balanceAfter: "100.00", currency: "NGN", reference: "J632",
        createdAt: new Date("2025-08-05T10:00:00Z"),
      } as any);

      const from = new Date("2025-08-01T00:00:00Z");
      const to = new Date("2025-09-01T00:00:00Z");
      const gen = await svc.generateWalletStatement(world.db, { tenantId, from, to });
      assert(gen.regenerated === false, "first generation");

      // fs scheme keeps the byte-identical on-disk layout.
      const abs = path.join(dir, gen.record.pdfPath);
      assert(fs.existsSync(abs), "PDF persisted at the same UC_DOCS_DIR path as pre-OpenDAL");
      const onDisk = fs.readFileSync(abs);
      assert(onDisk.subarray(0, 5).toString("ascii") === "%PDF-", "real PDF bytes on disk");

      // Same bytes readable through the facade docs namespace.
      const viaFacade = await od.docsGet("uc-docs", gen.record.pdfPath);
      assert(viaFacade !== null && viaFacade.equals(onDisk), "docsGet returns the on-disk bytes");

      // Manifest RMW round-trips through the facade.
      const manifest = await svc.readStatementManifest(tenantId);
      assert(manifest.length === 1 && manifest[0]!.id === gen.record.id, "manifest readable through the facade");
      const manifestAbs = path.join(dir, String(tenantId).replace(/[^A-Za-z0-9_.-]/g, "_"), "wallet-statements", "manifest.json");
      assert(fs.existsSync(manifestAbs), "manifest.json persisted at the same path as pre-OpenDAL");

      // Idempotent regeneration still yields exactly one manifest entry.
      const regen = await svc.generateWalletStatement(world.db, { tenantId, from, to });
      assert(regen.regenerated === true, "regeneration detected");
      assert((await svc.readStatementManifest(tenantId)).length === 1, "still one manifest entry");
    } finally {
      if (prevDocs === undefined) delete process.env.UC_DOCS_DIR; else process.env.UC_DOCS_DIR = prevDocs;
      if (prevScheme === undefined) delete process.env.OPENDAL_SCHEME; else process.env.OPENDAL_SCHEME = prevScheme;
      const od = await import("../../server/services/opendalStorage");
      od._resetOpendalForTests();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
};
