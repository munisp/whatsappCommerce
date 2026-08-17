/**
 * W15 catalogBootstrap router gating — protected + tenant-scoped, error-code
 * mapping. The service layer is mocked; service logic is covered in
 * services/catalogBootstrap/__tests__.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../services/catalogBootstrap", () => ({
  bootstrapCatalogFromImage: vi.fn(),
  getCatalogDraft: vi.fn(),
  confirmCatalogDraft: vi.fn(),
  rejectCatalogDraft: vi.fn(),
}));

import {
  bootstrapCatalogFromImage,
  getCatalogDraft,
  confirmCatalogDraft,
  rejectCatalogDraft,
} from "../../services/catalogBootstrap";
import { catalogBootstrapRouter } from "../catalogBootstrap";

const T1 = "tenant-1";
const T2 = "tenant-2";
const OWN = { user: { id: 2, role: "user", tenantId: T1 } } as any;
const ANON = { user: null } as any;

const mocked = {
  bootstrap: vi.mocked(bootstrapCatalogFromImage),
  get: vi.mocked(getCatalogDraft),
  confirm: vi.mocked(confirmCatalogDraft),
  reject: vi.mocked(rejectCatalogDraft),
};

beforeEach(() => vi.clearAllMocks());

describe("catalogBootstrap router gating", () => {
  it("bootstrapFromImage rejects unauthenticated callers", async () => {
    const caller = catalogBootstrapRouter.createCaller(ANON);
    await expect(
      caller.bootstrapFromImage({ tenantId: T1, imageUrl: "https://x.test/a.jpg" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("bootstrapFromImage rejects cross-tenant callers", async () => {
    const caller = catalogBootstrapRouter.createCaller(OWN);
    await expect(
      caller.bootstrapFromImage({ tenantId: T2, imageUrl: "https://x.test/a.jpg" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocked.bootstrap).not.toHaveBeenCalled();
  });

  it("bootstrapFromImage passes through for own tenant", async () => {
    mocked.bootstrap.mockResolvedValue({ ok: true, draftId: "cd_1", items: [] } as any);
    const caller = catalogBootstrapRouter.createCaller(OWN);
    const res = await caller.bootstrapFromImage({ tenantId: T1, imageUrl: "https://x.test/a.jpg" });
    expect(res).toEqual({ ok: true, draftId: "cd_1", items: [] });
    expect(mocked.bootstrap).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: T1, imageUrl: "https://x.test/a.jpg" }),
    );
  });

  it("bootstrapFromImage maps extraction_disabled → PRECONDITION_FAILED", async () => {
    mocked.bootstrap.mockResolvedValue({ ok: false, error: "extraction_disabled" } as any);
    const caller = catalogBootstrapRouter.createCaller(OWN);
    await expect(
      caller.bootstrapFromImage({ tenantId: T1, imageUrl: "https://x.test/a.jpg" }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("getDraft: cross-tenant rejected before the service runs", async () => {
    const caller = catalogBootstrapRouter.createCaller(OWN);
    await expect(caller.getDraft({ tenantId: T2, draftId: "cd_1" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocked.get).not.toHaveBeenCalled();
  });

  it("getDraft maps draft_not_found → NOT_FOUND", async () => {
    mocked.get.mockResolvedValue({ ok: false, error: "draft_not_found" } as any);
    const caller = catalogBootstrapRouter.createCaller(OWN);
    await expect(caller.getDraft({ tenantId: T1, draftId: "cd_x" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("confirmDraft: unauthenticated + cross-tenant rejected; own-tenant ok", async () => {
    const anon = catalogBootstrapRouter.createCaller(ANON);
    await expect(anon.confirmDraft({ tenantId: T1, draftId: "cd_1" })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    const own = catalogBootstrapRouter.createCaller(OWN);
    await expect(own.confirmDraft({ tenantId: T2, draftId: "cd_1" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    mocked.confirm.mockResolvedValue({ ok: true, draftId: "cd_1", productIds: ["p1"] } as any);
    const res = await own.confirmDraft({ tenantId: T1, draftId: "cd_1", approveItemIds: ["ci_1"] });
    expect(res).toEqual({ ok: true, draftId: "cd_1", productIds: ["p1"] });
    expect(mocked.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: T1, draftId: "cd_1", approveItemIds: ["ci_1"] }),
    );
  });

  it("rejectDraft: cross-tenant rejected; own-tenant ok", async () => {
    const own = catalogBootstrapRouter.createCaller(OWN);
    await expect(own.rejectDraft({ tenantId: T2, draftId: "cd_1" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    mocked.reject.mockResolvedValue({ ok: true } as any);
    await expect(own.rejectDraft({ tenantId: T1, draftId: "cd_1", reason: "bad photo" })).resolves.toEqual({ ok: true });
  });
});
