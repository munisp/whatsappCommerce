/**
 * J611 — Telegram chat onboarding, on the platform's own bot.
 *
 * Proves:
 *  1. off by default — no token/secret → 404, whatever is sent.
 *  2. wrong secret → 401, and nothing is sent.
 *  3. no session starts until the person shares their OWN contact; a typed
 *     number or someone else's contact is not accepted.
 *  4. sharing it starts a copilot session on the telegram channel, keyed by
 *     that phone, and the greeting goes out on Telegram (never on WhatsApp).
 *  5. a re-delivered update is acked as a duplicate and not processed again.
 *  6. /start mid-chat is a nudge, and the conversation continues on the same session.
 */
import { assert, type World } from "../world";
import type { Journey } from "../runner";
import { tg } from "../metaMock";
import { onboardingSessionByPhone } from "./helpers";

const TOKEN = "987654321:simonboardingbottokenabcdefgh012345";
const SECRET = "sim-onboarding-webhook-secret-0123456789";
const CHAT = 880011;
const USER = 880011;
const PHONE = "2348055500611";

async function post(world: World, secret: string | null, update: Record<string, unknown>) {
  const res = await fetch(`${world.baseUrl}/api/webhooks/telegram-onboarding`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(secret ? { "x-telegram-bot-api-secret-token": secret } : {}) },
    body: JSON.stringify(update),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

const from = { id: USER, first_name: "Ada", language_code: "en" };
const chat = { id: CHAT, type: "private" };
const text = (id: number, body: string) => ({ update_id: id, message: { message_id: id, from, chat, date: 1788000000, text: body } });
const contact = (id: number, userId: number, phone: string) => ({
  update_id: id,
  message: { message_id: id, from, chat, date: 1788000000, contact: { user_id: userId, phone_number: phone, first_name: "Ada" } },
});

export const journey: Journey = {
  id: "J611",
  name: "telegram chat onboarding",
  feature: "Same copilot on the platform's Telegram bot: off until configured, starts only on a self-shared contact",
  async run(world: World) {
    delete process.env.ONBOARDING_TELEGRAM_BOT_TOKEN;
    delete process.env.ONBOARDING_TELEGRAM_WEBHOOK_SECRET;
    assert((await post(world, SECRET, text(611001, "hi"))).status === 404, "off until both settings exist");

    process.env.ONBOARDING_TELEGRAM_BOT_TOKEN = TOKEN;
    process.env.ONBOARDING_TELEGRAM_WEBHOOK_SECRET = SECRET;
    try {
      tg.reset();
      const sends = () => tg.calls.filter((c) => c.method === "sendMessage" && c.token === TOKEN);

      assert((await post(world, "wrong", text(611002, "hi"))).status === 401, "a wrong secret is refused");
      assert((await post(world, null, text(611003, "hi"))).status === 401, "a missing secret is refused");
      await world.settle();
      assert(sends().length === 0, "nothing is sent for a refused update");

      await post(world, SECRET, text(611004, "/start"));
      await world.waitFor(() => sends().length === 1, 5000, "contact request");
      assert(sends()[0].body.reply_markup?.keyboard?.[0]?.[0]?.request_contact === true, "asks with the share-contact button");

      await post(world, SECRET, text(611005, PHONE));
      await world.waitFor(() => sends().length === 2, 5000, "second contact request");
      assert(sends()[1].body.reply_markup?.keyboard?.[0]?.[0]?.request_contact === true, "a typed number isn't accepted");
      assert(!(await onboardingSessionByPhone(PHONE)), "typing a number starts no session");

      await post(world, SECRET, contact(611006, USER + 1, PHONE));
      await world.waitFor(() => sends().length === 3, 5000, "own-contact prompt");
      assert(!(await onboardingSessionByPhone(PHONE)), "someone else's contact starts no session");

      const beforeShare = sends().length;
      await post(world, SECRET, contact(611007, USER, `+${PHONE}`));
      await world.waitFor(() => sends().length >= beforeShare + 2, 8000, "tick + greeting");
      const session = await onboardingSessionByPhone(PHONE);
      assert(session?.channel === "telegram", `session is on telegram (got ${session?.channel})`);
      assert(sends().at(-1)!.body.reply_markup?.keyboard === undefined, "the greeting isn't another contact request");

      const beforeStart = sends().length;
      await post(world, SECRET, text(611010, "/start"));
      await world.waitFor(() => sends().length > beforeStart, 5000, "nudge");
      const nudged = await onboardingSessionByPhone(PHONE);
      assert(!nudged?.intake?.facts?.businessName, "/start in a running chat doesn't become the shop's name");

      const again = await post(world, SECRET, contact(611007, USER, `+${PHONE}`));
      assert(again.json.duplicate === true, "a re-delivered update is a duplicate");

      const beforeTurn = sends().length;
      await post(world, SECRET, text(611008, "I sell shoes in Lagos"));
      await world.waitFor(() => sends().length > beforeTurn, 8000, "copilot reply");
      const after = await onboardingSessionByPhone(PHONE);
      assert(after?.id === session?.id, "the conversation stays on the same session");
    } finally {
      delete process.env.ONBOARDING_TELEGRAM_BOT_TOKEN;
      delete process.env.ONBOARDING_TELEGRAM_WEBHOOK_SECRET;
    }
  },
};
