/**
 * W16 router gating tests: embeddedSignup (operator-scoped) + waTemplates
 * library procs (protected+tenant / operator). Services are mocked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../db", () => ({ getDb: vi.fn() }));
vi.mock("../../services/embeddedSignup", async (importOriginal) => {
  const orig = (await importOriginal()) as any;
  return { ...orig, completeEmbeddedSignup: vi.fn() };
});
vi.mock("../../services/membership", () => ({ getMembership: vi.fn() }));
vi.mock("../../services/waTemplates/preApproval", async (importOriginal) => {
  const orig = (await importOriginal()) as any;
  return { ...orig, submitTemplate: vi.fn(), syncTemplateStatuses: vi.fn() };
});

import { getDb } from "../../db";
import { completeEmbeddedSignup, EmbeddedSignupError } from "../../services/embeddedSignup";
import { getMembership } from "../../services/membership";
import { submitTemplate, syncTemplateStatuses } from "../../services/waTemplates/preApproval";
import { embeddedSignupRouter } from "../embeddedSignup";
import { waTemplatesRouter } from "../waTemplates";

const T1 = "tenant-1";
const T2 = "tenant-2";
const OPERATOR = { user: { id: 7, role: "user", tenantId: null } } as any;
const OWNER_T1 = { user: { id: 2, role: "user", tenantId: T1 } } as any;
const ANON = { user: null } as any;

function fakeDb(settings: any = {}) {
  return {
    select: vi.fn(() => {
      const c: any = {
        from: vi.fn(),
        where: vi.fn(),
        limit: vi.fn(() => Promise.resolve([{ settings }])),
        catch: vi.fn(() => Promise.resolve([{ settings }])),
      };
      c.from.mockReturnValue(c);
      c.where.mockReturnValue(c);
      return c;
    }),
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getMembership).mockResolvedValue({ role: "operator" } as any);
  vi.mocked(getDb).mockResolvedValue(fakeDb() as any);
});

describe("embeddedSignup router gating", () => {
  it("exchange rejects unauthenticated callers", async () => {
    await expect(
      embeddedSignupRouter.createCaller(ANON).exchange({ tenantId: T1, code: "c" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("exchange rejects non-member callers", async () => {
    vi.mocked(getMembership).mockResolvedValue(null);
    await expect(
      embeddedSignupRouter.createCaller(OPERATOR).exchange({ tenantId: T1, code: "c" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(vi.mocked(completeEmbeddedSignup)).not.toHaveBeenCalled();
  });

  it("exchange rejects viewer-role members", async () => {
    vi.mocked(getMembership).mockResolvedValue({ role: "viewer" } as any);
    await expect(
      embeddedSignupRouter.createCaller(OPERATOR).exchange({ tenantId: T1, code: "c" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("exchange returns the persisted assignment + limitations for operators", async () => {
    vi.mocked(completeEmbeddedSignup).mockResolvedValue({
      replayed: false,
      record: {
        status: "completed", code: "c", wabaId: "w", phoneNumberId: "p",
        displayPhoneNumber: "+234", coexistence: true,
        onboardingStatus: "completed", onboardedAt: "now",
      },
    } as any);
    const res = await embeddedSignupRouter.createCaller(OPERATOR).exchange({ tenantId: T1, code: "c", coexistence: true });
    expect(res.wabaId).toBe("w");
    expect(res.limitations.every((l) => l.availability === "limited")).toBe(true);
    expect(vi.mocked(completeEmbeddedSignup)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tenantId: T1, code: "c", coexistence: true }),
    );
  });

  it("exchange maps permission_denied → FORBIDDEN, others → BAD_REQUEST", async () => {
    vi.mocked(completeEmbeddedSignup).mockRejectedValue(new EmbeddedSignupError("permission_denied", "nope"));
    await expect(
      embeddedSignupRouter.createCaller(OPERATOR).exchange({ tenantId: T1, code: "c" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringContaining("permission_denied") });

    vi.mocked(completeEmbeddedSignup).mockRejectedValue(new EmbeddedSignupError("expired_code", "old"));
    await expect(
      embeddedSignupRouter.createCaller(OPERATOR).exchange({ tenantId: T1, code: "c" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("expired_code") });
  });

  it("complete returns onboarding state and rejects cross-tenant", async () => {
    vi.mocked(getDb).mockResolvedValue(fakeDb({ whatsapp: { wabaId: "w", coexistence: true } }) as any);
    const res = await embeddedSignupRouter.createCaller(OPERATOR).complete({ tenantId: T1 });
    expect(res.wabaId).toBe("w");
    expect(res.coexistence).toBe(true);
    expect(res.limitations.length).toBeGreaterThan(0);

    vi.mocked(getMembership).mockResolvedValue(null);
    await expect(
      embeddedSignupRouter.createCaller(OPERATOR).complete({ tenantId: T2 }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("waTemplates library router gating", () => {
  it("listLibrary rejects unauthenticated and cross-tenant callers", async () => {
    await expect(
      waTemplatesRouter.createCaller(ANON).listLibrary({ tenantId: T1 }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      waTemplatesRouter.createCaller(OWNER_T1).listLibrary({ tenantId: T2 }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("listLibrary returns the library merged with tenant submission state", async () => {
    vi.mocked(getDb).mockResolvedValue(fakeDb({
      waTemplateLibrary: {
        submissions: [{
          templateKey: "order_confirmation", language: "en", name: "w16_order_confirmation",
          category: "UTILITY", metaTemplateId: "mt-1", status: "approved",
          rejectionReason: null, submittedAt: "x", updatedAt: "x",
        }],
      },
    }) as any);
    const res = await waTemplatesRouter.createCaller(OWNER_T1).listLibrary({ tenantId: T1 });
    expect(res.enabled).toBe(true);
    expect(res.templates.length).toBeGreaterThanOrEqual(10);
    const oc = res.templates.find((t) => t.key === "order_confirmation")!;
    const en = oc.languages.find((l) => l.language === "en")!;
    const ha = oc.languages.find((l) => l.language === "ha")!;
    expect(en.status).toBe("approved");
    expect(ha.status).toBe("draft");
  });

  it("submit is operator-gated and maps unknown_template → BAD_REQUEST", async () => {
    vi.mocked(getMembership).mockResolvedValue(null);
    await expect(
      waTemplatesRouter.createCaller(OPERATOR).submit({ tenantId: T1, templateKey: "k", language: "en" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(vi.mocked(submitTemplate)).not.toHaveBeenCalled();

    vi.mocked(getMembership).mockResolvedValue({ role: "operator" } as any);
    vi.mocked(submitTemplate).mockResolvedValue({ ok: false, error: "unknown_template", message: "x" } as any);
    await expect(
      waTemplatesRouter.createCaller(OPERATOR).submit({ tenantId: T1, templateKey: "k", language: "en" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("submit passes through successful submissions", async () => {
    vi.mocked(submitTemplate).mockResolvedValue({
      ok: true, idempotent: false,
      submission: { templateKey: "k", language: "en", status: "submitted" },
    } as any);
    const res = await waTemplatesRouter.createCaller(OPERATOR).submit({ tenantId: T1, templateKey: "k", language: "en" });
    expect(res).toMatchObject({ ok: true });
    expect(vi.mocked(submitTemplate)).toHaveBeenCalledWith(expect.anything(), T1, "k", "en");
  });

  it("syncStatus is operator-gated and returns the sync result", async () => {
    vi.mocked(getMembership).mockResolvedValue(null);
    await expect(
      waTemplatesRouter.createCaller(OPERATOR).syncStatus({ tenantId: T1 }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    vi.mocked(getMembership).mockResolvedValue({ role: "operator" } as any);
    vi.mocked(syncTemplateStatuses).mockResolvedValue({ updated: 2, submissions: [] } as any);
    const res = await waTemplatesRouter.createCaller(OPERATOR).syncStatus({ tenantId: T1 });
    expect(res).toEqual({ updated: 2, submissions: [] });
  });

  it("syncStatus maps service failures → BAD_REQUEST", async () => {
    vi.mocked(syncTemplateStatuses).mockRejectedValue(new Error("not configured"));
    await expect(
      waTemplatesRouter.createCaller(OPERATOR).syncStatus({ tenantId: T1 }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
