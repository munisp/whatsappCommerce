#!/usr/bin/env bash
# Store the shared platform WhatsApp number's credentials in the cluster (server/services/sharedNumber.ts) and
# restart the server so it picks them up. The access token is read without echo and never printed.
#
#   scripts/set-shared-number-secret.sh [kube-context]      (default context: kind-newwave-dev)
set -euo pipefail
CTX="${1:-kind-newwave-dev}"
NS=whatsapp-commerce

read -r -p "Phone number ID (WhatsApp Manager → API setup, a long number): " PNID
read -r -s -p "Permanent access token (System User token, input hidden): " TOKEN; echo
read -r -p "The number buyers will see, international format (e.g. +234 800 000 0000): " DISPLAY
read -r -p "Platform name shown to buyers (e.g. Naija Market): " NAME

[[ "$PNID" =~ ^[0-9]{6,}$ ]] || { echo "Phone number ID should be digits only." >&2; exit 1; }
[[ -n "$TOKEN" ]] || { echo "Access token is required." >&2; exit 1; }

kubectl --context "$CTX" -n "$NS" create secret generic whatsapp-shared-number \
  --from-literal=phoneNumberId="$PNID" \
  --from-literal=token="$TOKEN" \
  --from-literal=displayNumber="$DISPLAY" \
  --from-literal=platformName="$NAME" \
  --dry-run=client -o yaml | kubectl --context "$CTX" -n "$NS" apply -f -
unset TOKEN

# Every WhatsApp webhook is verified against ONE app secret (WHATSAPP_APP_SECRET). If this number lives in a new
# Meta app, its App Secret must replace the old one — and every other connected number must be in that app too.
read -r -s -p "New Meta app's App Secret (App settings → Basic; leave blank to keep the current one): " APPSECRET; echo
if [[ -n "$APPSECRET" ]]; then
  kubectl --context "$CTX" -n "$NS" create secret generic whatsapp-server-app-secret \
    --from-literal=value="$APPSECRET" --dry-run=client -o yaml | kubectl --context "$CTX" -n "$NS" apply -f -
  echo "App secret replaced."
fi
unset APPSECRET

kubectl --context "$CTX" -n "$NS" rollout restart deploy/server
kubectl --context "$CTX" -n "$NS" rollout status deploy/server --timeout=300s
echo "Done. Send \"hi\" to the platform number from your phone: you should get the platform welcome."
