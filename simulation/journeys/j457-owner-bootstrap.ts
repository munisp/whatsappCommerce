// === W47 crosscutting ===
/**
 * J457 — ONB-SM-1 / ONB-M-4: chat-copilot go-live bootstraps an OWNER.
 *
 * Full copilot onboarding → go-live approval now MUST produce:
 *   - settings.adminPhone = the onboarding phone (verified by delivery),
 *   - a users row keyed to that phone (openId wa-onb:<phone>),
 *   - an owner tenant_memberships row,
 *   - a phone-bound portal invite (tenant_invite_tokens.boundPhone set),
 *   - success copy that delivers the SECURE login link (fragment-carried)
 *     instead of pointing at a bare portal the merchant can't log into.
 */
import { eq, and } from "drizzle-orm";
import { assert, assertIncludes, bodyText, type World } from "../world";
import type { Journey } from "../runner";
import { registerGraphObject } from "../metaMock";
import {
  approvePendingViaButtons,
  onboardingSessionByPhone,
  tenantRowById,
} from "./helpers";

const PNID = "109000123457457";
const WA_TOKEN = "EAAj457prospecttoken0123456789";

export const journey: Journey = {
  id: "J457",
  name: "copilot go-live bootstraps tenant owner + phone-bound invite",
  feature: "ONB-SM-1 / ONB-M-4 owner bootstrap",
  async run(world: World) {
    const schema = await import("../../drizzle/schema");
    const phone = world.newPhone("onb457");
    process.env.WAC_WHATSAPP_TOKEN = "sim-wa-access-token";
    process.env.WAC_WHATSAPP_PHONE_ID = PNID;
    try {
      // ── Copilot intake → proposals → approvals → creds → go-live ────────
      await world.onboardingText(phone, "hello", { profileName: "Bola" });
      await world.onboardingText(
        phone,
        "I run Bola's Beads in Ibadan, coral beads + bracelets, delivery within Ibadan, bank transfer",
      );
      await approvePendingViaButtons(world, phone, ["waMenu", "useCases", "branding", "integrations"]);
      const s3 = await onboardingSessionByPhone(phone);
      assert(s3?.tenantId, "tenant provisioned on first apply");
      const tenantId = s3!.tenantId!;
      assert(s3!.state === "configuring", `awaiting creds (got ${s3!.state})`);
      registerGraphObject(PNID);
      await world.onboardingText(phone, `phone number id is ${PNID} token is ${WA_TOKEN}`);
      const s4 = await onboardingSessionByPhone(phone);
      const goLive = s4?.proposals.find((p: any) => p.kind === "goLive" && p.status === "pending");
      assert(goLive, "goLive proposal pending");
      // W47 MERGER: ONB-M-2 (J428) made copilot go-live KYB-gated — approve
      // KYB + mark validation passed before the go-live approval, matching
      // the gated contract (bootstrap assertions below are unchanged).
      const { setOnboardingStatus } = await import("../../server/services/onboarding");
      await setOnboardingStatus(tenantId, "validating", { validationPassed: true });
      const { approveKyb } = await import("./helpers");
      await approveKyb(world, tenantId);
      await world.onboardingButtonReply(phone, `onb_approve:${goLive!.id}`, "Approve");
      await world.waitFor(async () => {
        const { sql } = await import("drizzle-orm");
        const rows = (await world.db.execute(sql`
          SELECT state FROM onboarding_sessions WHERE phone = ${phone} ORDER BY created_at DESC LIMIT 1`)) as unknown as any[];
        const r = (Array.isArray(rows) ? rows : (rows as any).rows ?? [])[0];
        return r?.state === "live";
      });

      // ── Owner bootstrap artifacts ───────────────────────────────────────
      const tenant = await tenantRowById(world, tenantId);
      const settings = (tenant?.settings ?? {}) as Record<string, any>;
      const digits = (v: string) => v.replace(/\D/g, "");
      assert(digits(String(settings.adminPhone ?? "")) === digits(phone),
        `adminPhone recorded (got ${settings.adminPhone})`);
      const adminPhone = String(settings.adminPhone);

      const [owner] = await world.db.select().from(schema.users)
        .where(eq(schema.users.openId, `wa-onb:${adminPhone}`)).limit(1);
      assert(owner, "owner users row keyed to the onboarding phone exists");
      assert(owner.phoneVerified === true, "owner phone marked verified (webhook delivery proof)");

      const [membership] = await world.db.select().from(schema.tenantMemberships)
        .where(and(
          eq(schema.tenantMemberships.tenantId, tenantId),
          eq(schema.tenantMemberships.userId, String(owner.id)),
        )).limit(1);
      assert(membership, "owner membership row exists");
      assert(membership.role === "owner", `membership role is owner (got ${membership.role})`);

      const invites = await world.db.select().from(schema.tenantInviteTokens)
        .where(eq(schema.tenantInviteTokens.tenantId, tenantId));
      assert(invites.length >= 1, "phone-bound first-login invite minted");
      assert(invites[0].boundPhone === adminPhone, `invite bound to adminPhone (got ${invites[0].boundPhone})`);
      assert(invites[0].consumedAt == null, "invite unconsumed");

      // ── Success copy: secure link delivered, not a bare portal ──────────
      const inviteMsgs = world.outbound.findByBody("secure portal login link", phone);
      assert(inviteMsgs.length > 0, "live reply carries the secure login link");
      const wire = bodyText(inviteMsgs[inviteMsgs.length - 1]);
      assertIncludes(wire, "/portal/login#token=", "invite URL is fragment-carried (no access-log leak)");
      const termMsgs = world.outbound.findByBody("your store is live", phone);
      assert(termMsgs.length > 0, "terminal live follow-up delivered");
      const termText = bodyText(termMsgs[termMsgs.length - 1]);
      assert(!termText.includes(`Manage everything from your admin portal`), "old bare-portal copy gone");
      assertIncludes(termText, "secure login link", "terminal copy references the bound login link");

      // ── Idempotent: a second bootstrap call adopts, never duplicates ────
      const { bootstrapTenantOwner } = await import("../../server/services/onboardingCopilot");
      const again = await bootstrapTenantOwner({ tenantId, phone, actorId: "copilot:j457" });
      assert(again.ownerUserId === owner.id, "repeat bootstrap adopts the same owner user");
      assert(again.userCreated === false, "repeat bootstrap does not recreate the user");
    } finally {
      delete process.env.WAC_WHATSAPP_TOKEN;
      delete process.env.WAC_WHATSAPP_PHONE_ID;
    }
  },
};
