#!/usr/bin/env bash
# Set a new password for a dev test account in Keycloak (realm wacommerce), without the password ever being printed.
#
#   bash scripts/reset-keycloak-password.sh [email]          (default: testadmin@gmail.com)
#
# You type the new password (hidden, twice). The Keycloak admin password is read from the cluster secret
# keycloak/keycloak-admin-secret at run time and never shown. Dev only (kind-newwave-dev).
set -euo pipefail
CTX="kind-newwave-dev"
KC="https://keycloak-servers.newfire.app"
REALM="wacommerce"
EMAIL="${1:-testadmin@gmail.com}"

read -r -p "Keycloak admin username [admin]: " ADMIN_USER; ADMIN_USER="${ADMIN_USER:-admin}"
ADMIN_PASS="$(kubectl --context "$CTX" -n keycloak get secret keycloak-admin-secret -o jsonpath='{.data.KEYCLOAK_ADMIN_PASSWORD}' | base64 -d)"

read -r -s -p "New password for $EMAIL: " P1; echo
read -r -s -p "Same password again: " P2; echo
[ "$P1" = "$P2" ] || { echo "The two passwords differ — nothing changed." >&2; exit 1; }
[ "${#P1}" -ge 8 ] || { echo "Use at least 8 characters — nothing changed." >&2; exit 1; }

TOKEN="$(curl -fsS "$KC/realms/master/protocol/openid-connect/token" \
  -d client_id=admin-cli -d grant_type=password --data-urlencode "username=$ADMIN_USER" --data-urlencode "password=$ADMIN_PASS" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["access_token"])')" || { echo "Keycloak refused the admin login." >&2; exit 1; }
unset ADMIN_PASS

USER_ID="$(curl -fsS -H "Authorization: Bearer $TOKEN" --get "$KC/admin/realms/$REALM/users" --data-urlencode "email=$EMAIL" -d exact=true \
  | python3 -c 'import json,sys; u=json.load(sys.stdin); print(u[0]["id"] if u else "")')"
[ -n "$USER_ID" ] || { echo "No user $EMAIL in realm $REALM — nothing changed." >&2; exit 1; }

BODY="$(P="$P1" python3 -c 'import json,os; print(json.dumps({"type":"password","value":os.environ["P"],"temporary":False}))')"
unset P1 P2
curl -fsS -X PUT -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  "$KC/admin/realms/$REALM/users/$USER_ID/reset-password" --data-binary @- <<<"$BODY" >/dev/null
unset BODY TOKEN
echo "Done. $EMAIL can now sign in at https://wa-app.newfire.app with the password you just typed."
