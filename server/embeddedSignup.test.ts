/**
 * W16 embeddedSignup service tests: code exchange (success + taxonomy),
 * idempotent replay, token redaction, coexistence persistence, timeout.
 * Meta Graph calls use an injected fetch; db is mocked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.hoisted(() => {
  process.env.META_APP_ID = "app-1";
  process.env.META_APP_SECRET = "super-secret-app-secret";
  process.env.META_GRAPH_BASE_URL = "https://graph.test/v21.0";
  process.env.META_EMBEDDED_SIGNUP_TIMEOUT_MS = "50";
});

import {
  completeEmbeddedSignup,
  EmbeddedSignupError,
  exchangeCodeForToken,
  parseEmbeddedSignupRecord,
  redactSecrets,
} from "./services/embeddedSignup";
import {
  coexistenceLimitations,
  readCredentialState,
} from "./services/embeddedSignup/coexistence";

function makeDb(tenantRow: any) {
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

/** Pull embedded parameter strings out of a drizzle sql`` fragment. */
function sqlStrings(fragment: any): string {
  const chunks = fragment?.queryChunks ?? [];
  return chunks
    .map((c: any) => {
      if (typeof c === "string") return c;
      if (typeof c?.value === "string") return c.value;
      if (Array.isArray(c?.value)) return c.value.filter((v: any) => typeof v === "string").join("");
      return "";
    })
    .join("");
}

function jsonResponse(payload: any, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  } as any;
}

/** Fetch stub routing by URL. */
function routeFetch(routes: Record<string, { payload: any; status?: number }>) {
  return vi.fn(async (input: any) => {
    const url = String(input);
    for (const [needle, r] of Object.entries(routes)) {
      if (url.includes(needle)) return jsonResponse(r.payload, r.status ?? 200);
    }
    return jsonResponse({ error: { message: `unrouted ${url}` } }, 500);
  }) as any;
}

const FULL_ROUTES = {
  "oauth/access_token": { payload: { access_token: "meta-token-abc123" } },
  debug_token: {
    payload: {
      data: {
        granular_scopes: [
          { scope: "whatsapp_business_management", target_ids: ["waba-9"] },
        ],
      },
    },
  },
  "waba-9/phone_numbers": {
    payload: { data: [{ id: "pn-7", display_phone_number: "+2348012345678" }] },
  },
};

beforeEach(() => vi.clearAllMocks());

describe("exchangeCodeForToken", () => {
  it("exchanges a code for an access token", async () => {
    const f = routeFetch({ "oauth/access_token": { payload: { access_token: "tok-1" } } });
    const token = await exchangeCodeForToken("code-1", f);
    expect(token).toBe("tok-1");
    const url = String(f.mock.calls[0][0]);
    expect(url).toContain("client_id=app-1");
    expect(url).toContain("code=code-1");
  });

  it("maps an expired/used code to expired_code", async () => {
    const f = routeFetch({
      "oauth/access_token": {
        status: 400,
        payload: { error: { message: "This authorization code has expired", code: 100, error_subcode: 36003 } },
      },
    });
    await expect(exchangeCodeForToken("code-x", f)).rejects.toMatchObject({
      name: "EmbeddedSignupError",
      code: "expired_code",
    });
  });

  it("maps OAuthException code 190 to expired_code", async () => {
    const f = routeFetch({
      "oauth/access_token": { status: 400, payload: { error: { message: "Invalid OAuth access token", code: 190 } } },
    });
    await expect(exchangeCodeForToken("code-x", f)).rejects.toMatchObject({ code: "expired_code" });
  });

  it("maps permission errors to permission_denied", async () => {
    const f = routeFetch({
      "oauth/access_token": { status: 403, payload: { error: { message: "Insufficient permission", code: 200 } } },
    });
    await expect(exchangeCodeForToken("code-x", f)).rejects.toMatchObject({ code: "permission_denied" });
  });

  it("maps other Graph failures to meta_api_error", async () => {
    const f = routeFetch({
      "oauth/access_token": { status: 500, payload: { error: { message: "boom", code: 1 } } },
    });
    await expect(exchangeCodeForToken("code-x", f)).rejects.toMatchObject({ code: "meta_api_error" });
  });

  it("never echoes the app secret in error messages", async () => {
    const f = routeFetch({
      "oauth/access_token": {
        status: 400,
        payload: { error: { message: "bad secret super-secret-app-secret leaked", code: 1 } },
      },
    });
    const err = (await exchangeCodeForToken("code-x", f).catch((e) => e)) as EmbeddedSignupError;
    expect(err).toBeInstanceOf(EmbeddedSignupError);
    expect(err.message).not.toContain("super-secret-app-secret");
    expect(err.message).toContain("[redacted]");
  });

  it("times out into meta_api_error", async () => {
    const f = vi.fn(async (_url: any, init: any) => {
      await new Promise((_r, _rej) => {
        init.signal.addEventListener("abort", () => {
          const e = new Error("aborted");
          (e as any).name = "AbortError";
          _rej(e);
        });
      });
      return jsonResponse({});
    }) as any;
    // META_EMBEDDED_SIGNUP_TIMEOUT_MS=50 (set at file top, before imports).
    await expect(exchangeCodeForToken("code-x", f)).rejects.toMatchObject({ code: "meta_api_error" });
  });
});

describe("redactSecrets", () => {
  it("redacts known secrets and leaves other text", () => {
    expect(redactSecrets("token abcdefgh failed", "abcdefgh")).toBe("token [redacted] failed");
    expect(redactSecrets("no secrets here", undefined, null, "")).toBe("no secrets here");
  });
});

describe("completeEmbeddedSignup", () => {
  it("exchanges, discovers WABA + phone number and persists credentials", async () => {
    const { db, updates } = makeDb({ settings: {} });
    const f = routeFetch(FULL_ROUTES);
    const res = await completeEmbeddedSignup(
      db,
      { tenantId: "t1", code: "code-1" },
      f,
    );
    expect(res.replayed).toBe(false);
    expect(res.record.wabaId).toBe("waba-9");
    expect(res.record.phoneNumberId).toBe("pn-7");
    expect(res.record.displayPhoneNumber).toBe("+2348012345678");
    expect(res.record.coexistence).toBe(false);
    expect(updates).toHaveLength(1);
    // Credential columns + settings jsonb patch both carry the assignment.
    expect(updates[0].whatsappBusinessAccountId).toBe("waba-9");
    expect(updates[0].whatsappPhoneNumberId).toBe("pn-7");
    const patchText = sqlStrings(updates[0].settings);
    expect(patchText).toContain("waba-9");
    expect(patchText).toContain("pn-7");
    expect(patchText).toContain("meta-token-abc123");
  });

  it("honours session-info hints without discovery calls", async () => {
    const { db } = makeDb({ settings: {} });
    const f = routeFetch({
      "oauth/access_token": { payload: { access_token: "tok" } },
    });
    const res = await completeEmbeddedSignup(
      db,
      { tenantId: "t1", code: "code-1", wabaId: "waba-hint", phoneNumberId: "pn-hint", displayPhoneNumber: "+2341" },
      f,
    );
    expect(res.record.wabaId).toBe("waba-hint");
    expect(res.record.phoneNumberId).toBe("pn-hint");
    // Only the token exchange — no debug_token / phone_numbers calls.
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("is idempotent: replaying the same code returns stored state, no Meta calls", async () => {
    const settings = {
      embeddedSignup: {
        code: "code-1",
        wabaId: "waba-9",
        phoneNumberId: "pn-7",
        displayPhoneNumber: "+234",
        coexistence: true,
        onboardingStatus: "completed",
        onboardedAt: "2026-01-01T00:00:00.000Z",
      },
    };
    const { db, updates } = makeDb({ settings });
    const f = vi.fn();
    const res = await completeEmbeddedSignup(db, { tenantId: "t1", code: "code-1" }, f as any);
    expect(res.replayed).toBe(true);
    expect(res.record.wabaId).toBe("waba-9");
    expect(res.record.coexistence).toBe(true);
    expect(f).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it("throws no_waba_selected when the token grants no WABA", async () => {
    const { db } = makeDb({ settings: {} });
    const f = routeFetch({
      "oauth/access_token": { payload: { access_token: "tok" } },
      debug_token: { payload: { data: { granular_scopes: [] } } },
    });
    await expect(
      completeEmbeddedSignup(db, { tenantId: "t1", code: "code-1" }, f),
    ).rejects.toMatchObject({ code: "no_waba_selected" });
  });

  it("throws no_waba_selected when the WABA has no phone numbers", async () => {
    const { db } = makeDb({ settings: {} });
    const f = routeFetch({
      "oauth/access_token": { payload: { access_token: "tok" } },
      debug_token: {
        payload: { data: { granular_scopes: [{ scope: "whatsapp_business_management", target_ids: ["waba-9"] }] } },
      },
      "waba-9/phone_numbers": { payload: { data: [] } },
    });
    await expect(
      completeEmbeddedSignup(db, { tenantId: "t1", code: "code-1" }, f),
    ).rejects.toMatchObject({ code: "no_waba_selected" });
  });

  it("persists the coexistence flag when requested", async () => {
    const { db, updates } = makeDb({ settings: {} });
    const f = routeFetch(FULL_ROUTES);
    const res = await completeEmbeddedSignup(
      db,
      { tenantId: "t1", code: "code-1", coexistence: true },
      f,
    );
    expect(res.record.coexistence).toBe(true);
    expect(sqlStrings(updates[0].settings)).toContain('"coexistence":true');
  });
});

describe("parseEmbeddedSignupRecord", () => {
  it("returns null for missing/malformed state and parses valid state", () => {
    expect(parseEmbeddedSignupRecord({})).toBeNull();
    expect(parseEmbeddedSignupRecord({ embeddedSignup: { code: 1 } })).toBeNull();
    const rec = parseEmbeddedSignupRecord({
      embeddedSignup: { code: "c", wabaId: "w", phoneNumberId: "p", coexistence: true },
    });
    expect(rec).toMatchObject({ code: "c", wabaId: "w", coexistence: true, onboardingStatus: "completed" });
  });
});

describe("coexistence limitations", () => {
  it("marks exclusive-control features limited when coexistence is on", () => {
    const state = readCredentialState({ whatsapp: { wabaId: "w", coexistence: true, onboardingStatus: "completed" } });
    const l = coexistenceLimitations(state);
    expect(l.length).toBeGreaterThanOrEqual(5);
    expect(l.every((x) => x.availability === "limited")).toBe(true);
    expect(l.every((x) => x.reason.length > 0)).toBe(true);
    expect(l.map((x) => x.feature)).toContain("message_history_sync");
  });

  it("reports everything available when coexistence is off", () => {
    const state = readCredentialState({ whatsapp: { wabaId: "w", coexistence: false } });
    const l = coexistenceLimitations(state);
    expect(l.every((x) => x.availability === "available")).toBe(true);
  });

  it("derives onboardingStatus from settings", () => {
    expect(readCredentialState({}).onboardingStatus).toBe("not_started");
    expect(readCredentialState({ whatsapp: { wabaId: "w" } }).onboardingStatus).toBe("completed");
    expect(readCredentialState({ whatsapp: { onboardingStatus: "pending" } }).onboardingStatus).toBe("pending");
  });
});
