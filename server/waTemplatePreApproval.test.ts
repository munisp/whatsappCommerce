/**
 * W16 template pre-approval submission tests: submit idempotency, status
 * transitions (incl. rejected-with-reason), error paths, persistence shape.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  parseSubmissionState,
  submitTemplate,
  syncTemplateStatuses,
} from "./services/waTemplates/preApproval";

const CREDS_TENANT = {
  settings: { whatsapp: { accessToken: "tok", wabaId: "waba-1" } },
};

function makeDb(tenantRow: any = CREDS_TENANT) {
  const updates: any[] = [];
  const db: any = {
    select: vi.fn(() => {
      const c: any = {
        from: vi.fn(),
        where: vi.fn(),
        limit: vi.fn(() => Promise.resolve(tenantRow ? [tenantRow] : [])),
        catch: vi.fn(() => Promise.resolve(tenantRow ? [tenantRow] : [])),
      };
      c.from.mockReturnValue(c);
      c.where.mockReturnValue(c);
      return c;
    }),
    update: vi.fn(() => ({
      set: vi.fn((v: any) => {
        updates.push(v);
        return { where: vi.fn(() => Promise.resolve()) };
      }),
    })),
  };
  return { db, updates };
}

function jsonFetch(payload: any, status = 200) {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  })) as any;
}

beforeEach(() => vi.clearAllMocks());

describe("submitTemplate", () => {
  it("submits a library template to the WABA and records it", async () => {
    const { db, updates } = makeDb();
    const f = jsonFetch({ id: "mt-1", status: "PENDING" });
    const res = await submitTemplate(db, "t1", "order_confirmation", "en", f);
    expect(res).toMatchObject({ ok: true, idempotent: false });
    if (res.ok) {
      expect(res.submission.status).toBe("submitted");
      expect(res.submission.metaTemplateId).toBe("mt-1");
    }
    // Graph payload: correct name/category/language/body with example params.
    const body = JSON.parse(String(f.mock.calls[0][1]?.body));
    expect(body.name).toBe("w16_order_confirmation");
    expect(body.category).toBe("UTILITY");
    expect(body.language).toBe("en");
    expect(body.components[0].example.body_text[0]).toEqual(["sample1", "sample2", "sample3"]);
    expect(updates).toHaveLength(1);
  });

  it("is idempotent per (tenant, key, language): no second Meta call", async () => {
    const settings = {
      whatsapp: { accessToken: "tok", wabaId: "waba-1" },
      waTemplateLibrary: {
        submissions: [{
          templateKey: "order_confirmation", language: "en", name: "w16_order_confirmation",
          category: "UTILITY", metaTemplateId: "mt-1", status: "submitted",
          rejectionReason: null, submittedAt: "x", updatedAt: "x",
        }],
      },
    };
    const { db, updates } = makeDb({ settings });
    const f = jsonFetch({ id: "mt-2", status: "PENDING" });
    const res = await submitTemplate(db, "t1", "order_confirmation", "en", f);
    expect(res).toMatchObject({ ok: true, idempotent: true });
    if (res.ok) expect(res.submission.metaTemplateId).toBe("mt-1");
    expect(f).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it("idempotency is tenant-scoped: another tenant submits fresh", async () => {
    const { db } = makeDb();
    const f = jsonFetch({ id: "mt-9", status: "PENDING" });
    const res = await submitTemplate(db, "t2", "order_confirmation", "en", f);
    expect(res).toMatchObject({ ok: true, idempotent: false });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("re-submits after rejection (new Meta call, fresh record)", async () => {
    const settings = {
      whatsapp: { accessToken: "tok", wabaId: "waba-1" },
      waTemplateLibrary: {
        submissions: [{
          templateKey: "order_confirmation", language: "en", name: "w16_order_confirmation",
          category: "UTILITY", metaTemplateId: "mt-1", status: "rejected",
          rejectionReason: "SCAM", submittedAt: "x", updatedAt: "x",
        }],
      },
    };
    const { db } = makeDb({ settings });
    const f = jsonFetch({ id: "mt-2", status: "PENDING" });
    const res = await submitTemplate(db, "t1", "order_confirmation", "en", f);
    expect(res).toMatchObject({ ok: true, idempotent: false });
    if (res.ok) {
      expect(res.submission.status).toBe("submitted");
      expect(res.submission.rejectionReason).toBeNull();
      expect(res.submission.metaTemplateId).toBe("mt-2");
    }
  });

  it("rejects unknown template keys", async () => {
    const { db } = makeDb();
    const res = await submitTemplate(db, "t1", "nope", "en", jsonFetch({}));
    expect(res).toMatchObject({ ok: false, error: "unknown_template" });
  });

  it("rejects languages outside the library", async () => {
    const { db } = makeDb();
    const res = await submitTemplate(db, "t1", "order_confirmation", "fr", jsonFetch({}));
    expect(res).toMatchObject({ ok: false, error: "unsupported_language" });
  });

  it("maps Meta create failures to meta_api_error without persisting", async () => {
    const { db, updates } = makeDb();
    const f = jsonFetch({ error: { message: "invalid" } }, 400);
    const res = await submitTemplate(db, "t1", "order_confirmation", "en", f);
    expect(res).toMatchObject({ ok: false, error: "meta_api_error" });
    expect(updates).toHaveLength(0);
  });

  it("returns meta_api_error when the tenant is missing", async () => {
    const { db } = makeDb(null);
    const res = await submitTemplate(db, "ghost", "order_confirmation", "en", jsonFetch({}));
    expect(res).toMatchObject({ ok: false, error: "meta_api_error" });
  });
});

describe("syncTemplateStatuses", () => {
  const submittedState = (status = "submitted") => ({
    settings: {
      whatsapp: { accessToken: "tok", wabaId: "waba-1" },
      waTemplateLibrary: {
        submissions: [{
          templateKey: "order_confirmation", language: "en", name: "w16_order_confirmation",
          category: "UTILITY", metaTemplateId: "mt-1", status,
          rejectionReason: null, submittedAt: "x", updatedAt: "x",
        }],
      },
    },
  });

  it("advances submitted → approved", async () => {
    const { db, updates } = makeDb(submittedState());
    const f = jsonFetch({
      data: [{ id: "mt-1", name: "w16_order_confirmation", language: "en", status: "APPROVED", category: "UTILITY", components: [] }],
    });
    const res = await syncTemplateStatuses(db, "t1", f);
    expect(res.updated).toBe(1);
    expect(res.submissions[0].status).toBe("approved");
    expect(res.submissions[0].rejectionReason).toBeNull();
    expect(updates).toHaveLength(1);
  });

  it("advances submitted → rejected and captures the rejection reason", async () => {
    const { db } = makeDb(submittedState());
    const f = jsonFetch({
      data: [{
        id: "mt-1", name: "w16_order_confirmation", language: "en", status: "REJECTED",
        rejected_reason: "PROMOTIONAL_CONTENT_IN_UTILITY", category: "UTILITY", components: [],
      }],
    });
    const res = await syncTemplateStatuses(db, "t1", f);
    expect(res.updated).toBe(1);
    expect(res.submissions[0].status).toBe("rejected");
    expect(res.submissions[0].rejectionReason).toBe("PROMOTIONAL_CONTENT_IN_UTILITY");
  });

  it("keeps PENDING submissions submitted and does not rewrite state", async () => {
    const { db, updates } = makeDb(submittedState());
    const f = jsonFetch({
      data: [{ id: "mt-1", name: "w16_order_confirmation", language: "en", status: "PENDING", components: [] }],
    });
    const res = await syncTemplateStatuses(db, "t1", f);
    expect(res.updated).toBe(0);
    expect(res.submissions[0].status).toBe("submitted");
    expect(updates).toHaveLength(0);
  });

  it("ignores remote templates that are not tracked locally", async () => {
    const { db, updates } = makeDb(submittedState());
    const f = jsonFetch({
      data: [{ id: "mt-x", name: "other_template", language: "en", status: "APPROVED", components: [] }],
    });
    const res = await syncTemplateStatuses(db, "t1", f);
    expect(res.updated).toBe(0);
    expect(updates).toHaveLength(0);
  });

  it("fails when WABA credentials are not configured", async () => {
    const { db } = makeDb({ settings: {} });
    await expect(syncTemplateStatuses(db, "t1", jsonFetch({}))).rejects.toThrow(/not configured/);
  });
});

describe("parseSubmissionState", () => {
  it("parses valid state and drops malformed rows", () => {
    const s = parseSubmissionState({
      waTemplateLibrary: {
        submissions: [
          { templateKey: "k", language: "en", status: "approved" },
          { nope: true },
          { templateKey: "k2", language: "ha", status: "bogus" },
        ],
      },
    });
    expect(s.submissions).toHaveLength(2);
    expect(s.submissions[0].status).toBe("approved");
    expect(s.submissions[1].status).toBe("draft"); // unknown → draft
  });

  it("returns empty state for missing settings", () => {
    expect(parseSubmissionState(undefined).submissions).toEqual([]);
    expect(parseSubmissionState({}).submissions).toEqual([]);
  });
});
