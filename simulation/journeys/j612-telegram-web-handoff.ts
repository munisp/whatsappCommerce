/**
 * J612 — Telegram onboarding in partial mode: share contact → say what the business is → a draft shop
 * and owner are created, and a web link to finish setup comes back on Telegram.
 *
 * Proves the path real merchants take: the shop stays a draft (not live, not sellable), it is marked
 * for the web wizard, it is owned by the shared phone, and the link is delivered on Telegram.
 */
import { ENV } from "../../server/_core/env";
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { tg } from "../metaMock";
import { onboardingSessionById, onboardingSessionByPhone, tenantRowById } from "./helpers";

const TOKEN = "987654321:simonboardingbottokenabcdefgh012345";
const SECRET = "sim-onboarding-webhook-secret-0123456789";
const CHAT = 880012;
const PHONE = "2348055500612";

async function post(world: World, update: Record<string, unknown>) {
  await fetch(`${world.baseUrl}/api/webhooks/telegram-onboarding`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": SECRET },
    body: JSON.stringify(update),
  });
}

const from = { id: CHAT, first_name: "Ada", language_code: "en" };
const chat = { id: CHAT, type: "private" };

export const journey: Journey = {
  id: "J612",
  name: "telegram onboarding hands off to the web",
  feature: "Partial mode on Telegram: draft shop + owner + web link, delivered on Telegram",
  async run(world: World) {
    const mode = ENV.onboardingChatMode;
    process.env.ONBOARDING_TELEGRAM_BOT_TOKEN = TOKEN;
    process.env.ONBOARDING_TELEGRAM_WEBHOOK_SECRET = SECRET;
    (ENV as any).onboardingChatMode = "partial";
    try {
      tg.reset();
      const sends = () => tg.calls.filter((c) => c.method === "sendMessage" && c.token === TOKEN);
      await post(world, { update_id: 612001, message: { message_id: 1, from, chat, date: 1788000000, contact: { user_id: CHAT, phone_number: PHONE, first_name: "Ada" } } });
      await world.waitFor(() => sends().length >= 2, 8000, "tick + greeting");
      const session = await onboardingSessionByPhone(PHONE);
      assert(session?.channel === "telegram", "session on telegram");

      const before = sends().length;
      await post(world, { update_id: 612002, message: { message_id: 2, from, chat, date: 1788000000, text: "I run Ada's Fabrics in Enugu, ankara + lace, delivery within Enugu, bank transfer" } });
      await world.waitFor(() => sends().length > before, 8000, "hand-off reply");

      const reply = String(sends().at(-1)!.body.text ?? "");
      assert(/portal\/login#token=/.test(reply), `the reply carries the web link (got: ${reply.slice(0, 160)})`);
      const after = await onboardingSessionById(session!.id);
      assert(after?.state === "handed_off", `session handed off (got ${after?.state})`);
      const tenant = await tenantRowById(world, after!.tenantId!);
      assert(tenant, "a shop was created");
      const onboarding = (tenant.settings as any)?.onboarding ?? {};
      assert(onboarding.webHandoffPending === true, "marked to finish on the web");
      assert(onboarding.status !== "live", `the shop isn't live (got ${onboarding.status})`);
      assert(String((tenant.settings as any)?.adminPhone ?? "").includes(PHONE), "owned by the phone that was shared");
    } finally {
      (ENV as any).onboardingChatMode = mode;
      delete process.env.ONBOARDING_TELEGRAM_BOT_TOKEN;
      delete process.env.ONBOARDING_TELEGRAM_WEBHOOK_SECRET;
    }
  },
};
