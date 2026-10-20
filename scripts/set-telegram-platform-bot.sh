#!/usr/bin/env bash
# Connect the platform's Telegram bot (server/services/telegramPlatformBot.ts), where businesses open their shop by
# chat. Make the bot first: in Telegram, message @BotFather → /newbot → copy the token it gives you.
#
# This stores the token and a freshly generated webhook secret in the cluster, restarts the server, and points the
# bot's webhook at <app url>/api/webhooks/telegram-platform. The token is read without echo and never printed.
#
#   scripts/set-telegram-platform-bot.sh [kube-context] [app-url]
#   (defaults: kind-newwave-dev, https://wa-app.newfire.app)
set -euo pipefail
CTX="${1:-kind-newwave-dev}"
APP_URL="${2:-https://wa-app.newfire.app}"
NS=whatsapp-commerce

read -r -s -p "Bot token from @BotFather (input hidden): " TOKEN; echo
[[ "$TOKEN" =~ ^[0-9]+:[A-Za-z0-9_-]{30,}$ ]] || { echo "That doesn't look like a bot token (123456:ABC…)." >&2; exit 1; }

ME=$(curl -fsS "https://api.telegram.org/bot${TOKEN}/getMe") || { echo "Telegram rejected the token." >&2; exit 1; }
BOT=$(printf '%s' "$ME" | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["username"])')
SECRET=$(openssl rand -hex 32)

kubectl --context "$CTX" -n "$NS" create secret generic telegram-platform-bot \
  --from-literal=token="$TOKEN" --from-literal=webhookSecret="$SECRET" \
  --dry-run=client -o yaml | kubectl --context "$CTX" -n "$NS" apply -f -
kubectl --context "$CTX" -n "$NS" rollout restart deploy/server
kubectl --context "$CTX" -n "$NS" rollout status deploy/server --timeout=300s

curl -fsS "https://api.telegram.org/bot${TOKEN}/setWebhook" \
  --data-urlencode "url=${APP_URL%/}/api/webhooks/telegram-platform" \
  --data-urlencode "secret_token=${SECRET}" \
  --data-urlencode 'allowed_updates=["message","callback_query"]' >/dev/null
unset TOKEN SECRET
echo "Done. Open https://t.me/${BOT} and send /start: the bot should ask for your phone number."
