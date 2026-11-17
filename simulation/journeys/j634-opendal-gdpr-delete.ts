// === W67 opendal ===
/**
 * J634 — GDPR erasure delete contract survives the backend swap
 * (kycPrivacy.storageDelete, W40 TEN-5): deleting a non-existent key is
 * idempotent success, while an UNREACHABLE backend must THROW so the erasure
 * sweep can tombstone + retry instead of silently losing the deletion.
 * Also: the facade is fail-closed in production when OPENDAL_SCHEME is unset.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assert, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J634",
  name: "GDPR delete contract: idempotent delete, throw-on-unreachable, prod fail-closed",
  feature: "W67 OpenDAL storage layer",
  async run(_world: World) {
    const prev = {
      scheme: process.env.OPENDAL_SCHEME,
      root: process.env.OPENDAL_ROOT,
      nodeEnv: process.env.NODE_ENV,
      ep: process.env.OPENDAL_S3_ENDPOINT,
      bkt: process.env.OPENDAL_S3_BUCKET,
      ak: process.env.OPENDAL_S3_ACCESS_KEY_ID,
      sk: process.env.OPENDAL_S3_SECRET_ACCESS_KEY,
    };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "j634-opendal-"));
    try {
      const od = await import("../../server/services/opendalStorage");
      const storage = await import("../../server/storage");

      // 1. Idempotent delete on the fs scheme (missing key = success).
      process.env.OPENDAL_SCHEME = "fs";
      process.env.OPENDAL_ROOT = dir;
      od._resetOpendalForTests();
      await storage.storageDelete("kyc/app-j634/id.png");
      await storage.storageDelete("kyc/app-j634/id.png");
      await storage.storagePut("kyc/app-j634/id.png", Buffer.from("kyc-bytes"), "image/png");
      await storage.storageDelete("kyc/app-j634/id.png");
      await storage.storageDelete("kyc/app-j634/id.png");
      assert((await od.getOrNull("kyc/app-j634/id.png")) === null, "deleted object stays deleted");

      // 2. Throw-on-unreachable: s3 scheme against a dead endpoint must throw
      //    (the GDPR sweep retries; a swallowed error would lose the erasure).
      process.env.OPENDAL_SCHEME = "s3";
      process.env.OPENDAL_S3_ENDPOINT = "http://127.0.0.1:1";
      process.env.OPENDAL_S3_BUCKET = "wacommerce";
      process.env.OPENDAL_S3_ACCESS_KEY_ID = "x";
      process.env.OPENDAL_S3_SECRET_ACCESS_KEY = "y";
      od._resetOpendalForTests();
      let threw = false;
      try {
        await storage.storageDelete("kyc/app-j634/id.png");
      } catch {
        threw = true;
      }
      assert(threw, "storageDelete THROWS when the backend is unreachable (GDPR retry contract)");

      // 3. Fail-closed in production: no OPENDAL_SCHEME → throw, no silent fs fallback.
      delete process.env.OPENDAL_SCHEME;
      process.env.NODE_ENV = "production";
      od._resetOpendalForTests();
      threw = false;
      try {
        od.opendalScheme();
      } catch (e: any) {
        threw = /fail-closed|OPENDAL_SCHEME/.test(String(e?.message ?? e));
      }
      assert(threw, "production without OPENDAL_SCHEME is fail-closed");
    } finally {
      const restore = (k: string, v: string | undefined) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
      restore("OPENDAL_SCHEME", prev.scheme);
      restore("OPENDAL_ROOT", prev.root);
      restore("NODE_ENV", prev.nodeEnv);
      restore("OPENDAL_S3_ENDPOINT", prev.ep);
      restore("OPENDAL_S3_BUCKET", prev.bkt);
      restore("OPENDAL_S3_ACCESS_KEY_ID", prev.ak);
      restore("OPENDAL_S3_SECRET_ACCESS_KEY", prev.sk);
      const od = await import("../../server/services/opendalStorage");
      od._resetOpendalForTests();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
};
