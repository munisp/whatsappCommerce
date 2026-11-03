/**
 * Point the onboarding bot at this deployment. Run once after setting the env vars:
 *   ONBOARDING_TELEGRAM_BOT_TOKEN, ONBOARDING_TELEGRAM_WEBHOOK_SECRET, and PUBLIC_APP_URL or APP_URL.
 */
import { registerWebhook } from "../server/services/telegramSetup";
import { telegramOnboardingConfig } from "../server/services/tgOnboarding";

const cfg = telegramOnboardingConfig();
const origin = (process.env.PUBLIC_APP_URL || process.env.APP_URL || "").replace(/\/+$/, "");
if (!cfg || !origin.startsWith("https://")) {
  console.error("Set ONBOARDING_TELEGRAM_BOT_TOKEN, ONBOARDING_TELEGRAM_WEBHOOK_SECRET and an https PUBLIC_APP_URL or APP_URL.");
  process.exit(2);
}
const result = await registerWebhook({ token: cfg.token, url: `${origin}/api/webhooks/telegram-onboarding`, secret: cfg.secret });
if (!result.ok) {
  console.error(`Telegram refused: ${result.message}`);
  process.exit(1);
}
console.log(`Registered ${result.result.url}. Pending updates: ${result.result.pendingUpdateCount}.`);
