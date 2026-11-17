// === W67 opendal ===
/**
 * J633 — storage auth-policy regression after the backend swap: the
 * storageSecurity helpers (public namespaces, tenant scoping, content
 * sniffing, risky-type forcing) and the storage.ts delegates
 * (storagePut → storageServe roundtrip, /api/storage URL shape) must behave
 * identically on the OpenDAL backend.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assert, type World, TENANT_ID } from "../world";
import type { Journey } from "../runner";

export const journey: Journey = {
  id: "J633",
  name: "storage route auth policy + delegates regression on the OpenDAL backend",
  feature: "W67 OpenDAL storage layer",
  async run(_world: World) {
    const sec = await import("../../server/services/storageSecurity");

    // Public namespaces unchanged (Meta/Telegram fetch without a session).
    assert(sec.isPublicStorageKey("product-images/cat/x.png"), "product-images stays public");
    assert(sec.isPublicStorageKey(`tenant-branding/${TENANT_ID}/logo.png`), "tenant-branding stays public");
    assert(!sec.isPublicStorageKey(`whatsapp-media/${TENANT_ID}/m.jpg`), "whatsapp-media stays gated");
    assert(!sec.isPublicStorageKey("kyc/app-1/id.png"), "kyc stays gated");

    // Tenant scoping unchanged.
    assert(sec.keyTenantScope(`whatsapp-media/${TENANT_ID}/m.jpg`) === TENANT_ID, "scoped prefix yields tenant");
    assert(sec.keyTenantScope("product-images/cat/x.png") === null, "product-images is not tenant-scoped");
    assert(sec.keyTenantScope("kyc/app-1/id.png") === null, "kyc not in the scoped set (capability-token path)");
    assert(sec.sessionMayReadScopedKey({ role: "admin" }, "t-other"), "admin bypasses scope");
    assert(sec.sessionMayReadScopedKey({ tenantId: TENANT_ID }, TENANT_ID), "owning tenant reads");
    assert(!sec.sessionMayReadScopedKey({ tenantId: TENANT_ID }, "t-other"), "foreign tenant denied");
    assert(sec.sessionMayReadScopedKey({ tenantId: "x", memberships: [TENANT_ID] }, TENANT_ID), "membership reads");

    // Content sniffing / risky-type forcing unchanged.
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert(sec.sniffMime(png) === "image/png", "PNG magic bytes sniffed");
    const html = Buffer.from("<!doctype html><script>alert(1)</script>");
    assert(sec.sniffMime(html) === "text/html", "HTML sniffed");
    const pol = sec.servedContentPolicy("image/png", html);
    assert(pol.disposition === "attachment" && pol.contentType === "application/octet-stream",
      "HTML masquerading as image is forced to attachment (stored-XSS guard)");

    // storage.ts delegates roundtrip on the fs scheme.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "j633-opendal-"));
    const prevScheme = process.env.OPENDAL_SCHEME;
    const prevRoot = process.env.OPENDAL_ROOT;
    process.env.OPENDAL_SCHEME = "fs";
    process.env.OPENDAL_ROOT = dir;
    try {
      const od = await import("../../server/services/opendalStorage");
      od._resetOpendalForTests();
      const storage = await import("../../server/storage");
      const key = `product-images/j633/${TENANT_ID}.png`;
      const put = await storage.storagePut(key, png, "image/png");
      assert(put.key === key && put.url === `/api/storage/${key}`, "storagePut URL shape unchanged");
      const served = await storage.storageServe(key);
      assert(served.contentType === "image/png", "serve content-type");
      let acc = Buffer.alloc(0);
      for await (const c of served.stream as any) acc = Buffer.concat([acc, c as Buffer]);
      assert(acc.equals(png), "served bytes match");
      // Sniffing the served head through the same policy the route uses.
      const servedPol = sec.servedContentPolicy(served.contentType, acc.subarray(0, 512));
      assert(servedPol.contentType === "image/png" && servedPol.disposition === "inline",
        "public image serves inline as image/png");
      // storageGet falls back to the app-proxied URL on the fs scheme.
      const got = await storage.storageGet(key);
      assert(got.url === `/api/storage/${key}`, "storageGet app-proxied fallback on fs");
      assert(storage.generateStorageKey("photo.jpg").startsWith("uploads/"), "generateStorageKey unchanged");
      await storage.storageDelete(key);
      await assertThrows(() => storage.storageServe(key), "serve throws after delete");
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
