/**
 * J81 — Meta embedded signup e2e (W16 F9).
 *
 * NOTE (W16): the exchange/discovery calls run against a scripted injected
 * fetch (completeEmbeddedSignup's fetchFn seam — zero real network). The
 * journey ends with ONE real waSender send to prove the exchanged token
 * lands exactly where the production send path reads it; transcripts/J81.json
 * therefore contains exactly that one outbound message.
 *
 * Flow:
 *   1. Error taxonomy: expired_code / permission_denied / no_waba_selected /
 *      meta_api_error map from scripted Meta failures; secrets never echo.
 *   2. Happy path WITHOUT session-info hints: code → token exchange →
 *      debug_token WABA discovery → phone_numbers assignment (3 Meta calls);
 *      credentials persist onto tenants.whatsappBusinessAccountId /
 *      whatsappPhoneNumberId + settings.whatsapp.* (the waSender keys).
 *   3. Replay of the same code → replayed:true with ZERO Meta calls.
 *   4. A real sendWhatsAppText leaves the process against pn_j81 with the
 *      exchanged bearer token (metaMock authToken side-channel).
 *   5. Coexistence signup (hints, coexistence:true) → 1 Meta call, flag
 *      persisted, coexistenceLimitations reports 5 limited features.
 */
import { eq } from "drizzle-orm";
import {
  assert,
  META_APP_ID_VALUE,
  PHONE_NUMBER_ID,
  TENANT_ID,
  WABA_ID,
  WA_ACCESS_TOKEN,
  type World,
} from "../world";
import type { Journey } from "../runner";

function metaResponse(status: number, data: unknown): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

export const journey: Journey = {
  id: "J81",
  name: "embedded signup e2e",
  feature: "code exchange + discovery → idempotent replay → error taxonomy → waSender credential seam → coexistence",
  async run(world) {
    const schema = await import("../../drizzle/schema");
    const es = await import("../../server/services/embeddedSignup");
    const { readCredentialState, coexistenceLimitations } = await import("../../server/services/embeddedSignup/coexistence");
    const { resolveWabaCredentials } = await import("../../server/services/waTemplates");
    const { sendWhatsAppText } = await import("../../server/services/waSender");

    const calls: Array<{ url: string; method: string }> = [];
    /** Scripted Meta Graph: behavior switches on the scripted `mode`. */
    let mode:
      | "expired"
      | "permission"
      | "no_waba"
      | "meta500"
      | "happy"
      | "happy_hints" = "happy";
    const fakeMeta = async (url: string, init?: RequestInit): Promise<Response> => {
      calls.push({ url, method: String(init?.method ?? "GET") });
      const u = new URL(url);
      if (u.pathname.endsWith("/oauth/access_token")) {
        assert(u.searchParams.get("client_id") === META_APP_ID_VALUE, "exchange uses the configured app id");
        switch (mode) {
          case "expired":
            return metaResponse(400, { error: { message: "The authorization code has expired", code: 190, type: "OAuthException" } });
          case "permission":
            return metaResponse(403, { error: { message: "Permission denied for sim-meta-app-secret-0123456789", code: 200 } });
          case "meta500":
            return metaResponse(500, { error: { message: "internal boom" } });
          default:
            return metaResponse(200, { access_token: mode === "happy_hints" ? "meta-token-j81b" : "meta-token-j81" });
        }
      }
      if (u.pathname.endsWith("/debug_token")) {
        if (mode === "no_waba") return metaResponse(200, { data: { granular_scopes: [] } });
        return metaResponse(200, {
          data: { granular_scopes: [{ scope: "whatsapp_business_management", target_ids: ["waba_j81"] }] },
        });
      }
      if (u.pathname.endsWith("/phone_numbers")) {
        return metaResponse(200, {
          data: [{ id: "pn_j81", display_phone_number: "+234 701 111 2222", verified_name: "Sim J81" }],
        });
      }
      return metaResponse(404, { error: { message: `unscripted ${u.pathname}` } });
    };

    const tenantRow = async () => {
      const [t] = await world.db
        .select({
          wabaId: schema.tenants.whatsappBusinessAccountId,
          phoneNumberId: schema.tenants.whatsappPhoneNumberId,
          settings: schema.tenants.settings,
        })
        .from(schema.tenants)
        .where(eq(schema.tenants.id, TENANT_ID))
        .limit(1);
      return t;
    };

    const expectError = async (code: string, label: string) => {
      try {
        await es.completeEmbeddedSignup(world.db, { tenantId: TENANT_ID, code: `code-j81-${label}` }, fakeMeta as any);
        throw new Error(`${label}: expected EmbeddedSignupError, got success`);
      } catch (e: any) {
        assert(e instanceof es.EmbeddedSignupError, `${label}: structured error type (got ${e?.message})`);
        assert(e.code === code, `${label}: code=${code} (got ${e.code})`);
      }
    };

    try {
      // ── 1. Error taxonomy ────────────────────────────────────────────────
      mode = "expired";
      await expectError("expired_code", "expired");
      mode = "permission";
      try {
        await es.completeEmbeddedSignup(world.db, { tenantId: TENANT_ID, code: "code-j81-perm" }, fakeMeta as any);
        assert(false, "permission case must throw");
      } catch (e: any) {
        assert(e?.code === "permission_denied", `permission_denied (got ${e?.code})`);
        assert(
          !String(e?.message ?? "").includes("sim-meta-app-secret-0123456789"),
          "app secret redacted from error text",
        );
      }
      mode = "no_waba";
      await expectError("no_waba_selected", "nowaba");
      mode = "meta500";
      await expectError("meta_api_error", "meta500");
      const callsAfterErrors = calls.length;

      // ── 2. Happy path with full discovery (no hints) ────────────────────
      mode = "happy";
      const result = await es.completeEmbeddedSignup(
        world.db,
        { tenantId: TENANT_ID, code: "code-j81" },
        fakeMeta as any,
      );
      assert(result.replayed === false, "first exchange is not a replay");
      assert(result.record.wabaId === "waba_j81" && result.record.phoneNumberId === "pn_j81", "WABA + phone discovered");
      assert(result.record.displayPhoneNumber === "+234 701 111 2222", "display phone captured");
      assert(result.record.onboardingStatus === "completed", "onboarding completed");
      assert(calls.length === callsAfterErrors + 3, "exchange + debug_token + phone_numbers = 3 Meta calls");

      // ── 3. Idempotent replay: zero Meta calls ───────────────────────────
      const replay = await es.completeEmbeddedSignup(
        world.db,
        { tenantId: TENANT_ID, code: "code-j81" },
        fakeMeta as any,
      );
      assert(replay.replayed === true, "replay flagged");
      assert(replay.record.phoneNumberId === "pn_j81", "replay returns the recorded state");
      assert(calls.length === callsAfterErrors + 3, "replay made ZERO Meta calls");

      // ── 4. Credentials land where waSender reads them ───────────────────
      const row = await tenantRow();
      assert(row?.wabaId === "waba_j81", "tenants.whatsappBusinessAccountId updated");
      assert(row?.phoneNumberId === "pn_j81", "tenants.whatsappPhoneNumberId updated");
      const wa = ((row?.settings as any)?.whatsapp ?? {}) as Record<string, unknown>;
      assert(wa.accessToken === "meta-token-j81", "settings.whatsapp.accessToken persisted");
      assert(wa.onboardingStatus === "completed", "settings.whatsapp.onboardingStatus completed");
      const creds = await resolveWabaCredentials(world.db, TENANT_ID);
      assert(creds?.wabaId === "waba_j81" && creds.accessToken === "meta-token-j81", "resolveWabaCredentials reads the new creds");

      const outBefore = world.outbound.all().length;
      const send = await sendWhatsAppText(TENANT_ID, world.newPhone("j81"), "J81 credential-path probe");
      assert(send.sent === true, "real send path delivers with the exchanged credentials");
      const sent = world.outbound.all().slice(outBefore).pop();
      assert(sent?.url.includes("/pn_j81/messages"), "send went out on the NEW phone number id");
      assert(sent?.authToken === "meta-token-j81", "send bore the exchanged access token");

      // ── 5. Coexistence signup (hints win, 1 Meta call) ──────────────────
      mode = "happy_hints";
      const coex = await es.completeEmbeddedSignup(
        world.db,
        {
          tenantId: TENANT_ID,
          code: "code-j81b",
          wabaId: "waba_j81b",
          phoneNumberId: "pn_j81b",
          displayPhoneNumber: "+234 702 333 4444",
          coexistence: true,
        },
        fakeMeta as any,
      );
      assert(coex.record.coexistence === true, "coexistence flag recorded");
      assert(coex.record.wabaId === "waba_j81b", "session-info hint wins over discovery");
      const callsAfterCoex = calls.length;
      assert(callsAfterCoex === callsAfterErrors + 3 + 1, "hinted signup made only the exchange call");

      const coexState = readCredentialState((await tenantRow())?.settings);
      assert(coexState.coexistence === true && coexState.onboardingStatus === "completed", "credential state reflects coexistence");
      const limited = coexistenceLimitations(coexState);
      assert(limited.length === 5 && limited.every((l) => l.availability === "limited" && l.reason.length > 0),
        "all 5 coexistence limitations reported with honest reasons");
      const exclusive = coexistenceLimitations({ ...coexState, coexistence: false });
      assert(exclusive.every((l) => l.availability === "available"), "exclusive mode reports everything available");
    } finally {
      // Restore the seed tenant's WhatsApp credentials (columns + settings)
      // so later journeys keep routing via pn_sim_001 / sim-wa-access-token.
      const [t] = await world.db
        .select({ settings: schema.tenants.settings })
        .from(schema.tenants)
        .where(eq(schema.tenants.id, TENANT_ID))
        .limit(1);
      const s = { ...((t?.settings ?? {}) as Record<string, any>) };
      delete s.embeddedSignup;
      s.whatsapp = { ...(s.whatsapp as Record<string, unknown>), accessToken: WA_ACCESS_TOKEN, wabaId: WABA_ID };
      delete (s.whatsapp as Record<string, unknown>).phoneNumberId;
      delete (s.whatsapp as Record<string, unknown>).coexistence;
      delete (s.whatsapp as Record<string, unknown>).onboardingStatus;
      delete (s.whatsapp as Record<string, unknown>).displayPhoneNumber;
      await world.db
        .update(schema.tenants)
        .set({
          whatsappBusinessAccountId: WABA_ID,
          whatsappPhoneNumberId: PHONE_NUMBER_ID,
          settings: s,
          updatedAt: new Date(),
        })
        .where(eq(schema.tenants.id, TENANT_ID));
    }
  },
};
