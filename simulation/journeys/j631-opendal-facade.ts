// === W67 opendal ===
/**
 * J631 — OpenDAL facade roundtrip on the fs scheme: put/get/stat/list/
 * presign-fallback/serve/delete through server/services/opendalStorage.ts.
 * The fs scheme has no presign capability, so presignRead must fall back to
 * the app-proxied /api/storage/{key} URL (capability-token auth unchanged).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assert, type World } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J631",
  name: "opendal facade put/get/list/stat/presign fallback roundtrip (fs scheme)",
  feature: "W67 OpenDAL storage layer",
  async run(_world: World) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "j631-opendal-"));
    const prevScheme = process.env.OPENDAL_SCHEME;
    const prevRoot = process.env.OPENDAL_ROOT;
    process.env.OPENDAL_SCHEME = "fs";
    process.env.OPENDAL_ROOT = dir;
    try {
      const od = await import("../../server/services/opendalStorage");
      od._resetOpendalForTests();

      // put + stat + get
      await od.put("uploads/j631/hello.txt", "hello opendal", "text/plain");
      const st = await od.stat("uploads/j631/hello.txt");
      assert(st !== null, "stat finds the object");
      assert(st!.contentLength === Buffer.byteLength("hello opendal"), "contentLength matches");
      const got = await od.get("uploads/j631/hello.txt");
      assert(got.toString("utf8") === "hello opendal", "get returns the exact bytes");

      // binary put
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
      await od.put("product-images/j631/x.png", png, "image/png");
      assert((await od.get("product-images/j631/x.png")).equals(png), "binary roundtrip is byte-exact");

      // list (directories filtered)
      const keys = await od.list("uploads/");
      assert(keys.includes("uploads/j631/hello.txt"), "list returns the object key");
      assert(keys.every((k) => !k.endsWith("/")), "list filters directory entries");

      // presign fallback: fs scheme has no presign → app-proxied route URL
      const url = await od.presignRead("uploads/j631/hello.txt", 60);
      assert(url === "/api/storage/uploads/j631/hello.txt", `fs presign falls back to app route (got ${url})`);
      await assertThrows(async () => od.presignWrite("uploads/j631/x.txt", 60), "presignWrite throws on fs scheme");

      // serveStream + extension mime guess
      const { stream, contentType } = await od.serveStream("product-images/j631/x.png");
      assert(contentType === "image/png", `fs serve guesses mime from extension (got ${contentType})`);
      let acc = Buffer.alloc(0);
      for await (const c of stream as any) acc = Buffer.concat([acc, c as Buffer]);
      assert(acc.equals(png), "serveStream bytes are byte-exact");
      await assertThrows(() => od.serveStream("uploads/j631/nope.txt"), "serveStream throws on missing object");

      // getOrNull + idempotent delete
      await od.deleteObject("uploads/j631/hello.txt");
      assert((await od.stat("uploads/j631/hello.txt")) === null, "stat null after delete");
      await od.deleteObject("uploads/j631/hello.txt"); // second delete must not throw
      assert((await od.getOrNull("uploads/j631/hello.txt")) === null, "getOrNull null after delete");

      // backend info
      const info = od.storageBackendInfo();
      assert(info.scheme === "fs" && info.root === dir, "backend info reflects fs scheme + root");
    } finally {
      if (prevScheme === undefined) delete process.env.OPENDAL_SCHEME; else process.env.OPENDAL_SCHEME = prevScheme;
      if (prevRoot === undefined) delete process.env.OPENDAL_ROOT; else process.env.OPENDAL_ROOT = prevRoot;
      const od = await import("../../server/services/opendalStorage");
      od._resetOpendalForTests();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
};

async function assertThrows(fn: () => Promise<unknown>, msg: string): Promise<void> {
  try {
    await fn();
  } catch {
    return;
  }
  assert(false, msg);
}
