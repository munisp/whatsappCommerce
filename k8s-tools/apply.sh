#!/usr/bin/env bash
# Deploy the cluster-wide Kafka / Redis / Postgres UIs (see cluster-ui.yaml for design notes).
#
#   ./k8s-tools/apply.sh                    deploy the three new UIs
#   ./k8s-tools/apply.sh --secure-temporal  ALSO put the shared basic-auth in front of the
#                                           already-public, unauthenticated temporal-web.newfire.app
#
# Idempotent. The generated password is printed ONCE, only on first creation.
set -euo pipefail
CTX=kind-newwave-dev
K="kubectl --context $CTX"
DIR="$(cd "$(dirname "$0")" && pwd)"

$K get ns cluster-tools >/dev/null 2>&1 || $K create namespace cluster-tools

if $K -n cluster-tools get secret cluster-tools-basic-auth >/dev/null 2>&1; then
  echo "secret cluster-tools-basic-auth already exists — leaving the password unchanged"
else
  PASS="$(openssl rand -base64 24 | tr -d '/+=')"
  $K -n cluster-tools create secret generic cluster-tools-basic-auth \
    --from-literal=username=cluster-admin --from-literal=password="$PASS"
  echo ""
  echo "=== SHARED LOGIN (shown once) ==="
  echo "username: cluster-admin"
  echo "password: $PASS"
  echo "Read it again later with:"
  echo "  kubectl --context $CTX -n cluster-tools get secret cluster-tools-basic-auth -o jsonpath='{.data.password}' | base64 -d"
  echo "================================="
fi

$K apply -f "$DIR/cluster-ui.yaml"

# RedisInsight -> the shared Redis. It starts empty unless it is given a login (see cluster-ui.yaml).
#   default : copy the login out of the app's own secret (whatsapp-commerce/whatsapp-redis-url). It is parsed
#             straight into the new Secret and never printed. CAVEAT: that is the APP's credential — full
#             read/write/DELETE on a Redis shared with other teams (Twenty job queues, lanai, velma), behind
#             only the shared basic-auth. Prefer a read-only ACL user:
#               REDIS_UI_USER=ui_readonly REDIS_UI_PASSWORD='...' ./k8s-tools/apply.sh
#             created on the Redis with (suggested, untested — RedisInsight's browser needs SCAN/TYPE/TTL/
#             PTTL/MEMORY USAGE/INFO/DBSIZE and the client handshake commands):
#               ACL SETUSER ui_readonly on >'<password>' ~* -@all +@read +scan +type +ttl +pttl +dbsize +info
#                 +memory|usage +client|setname +client|setinfo +hello +ping +command|info +command|docs +config|get
NEW_REDIS_SECRET=0
if $K -n cluster-tools get secret cluster-tools-redis >/dev/null 2>&1; then
  echo "secret cluster-tools-redis already exists — leaving it unchanged (delete it and re-run to change the Redis login)"
else
  if [ -n "${REDIS_UI_PASSWORD:-}" ]; then
    RUSER="${REDIS_UI_USER:-default}"; RPASS="$REDIS_UI_PASSWORD"; echo "RedisInsight login: REDIS_UI_USER/REDIS_UI_PASSWORD you supplied"
  else
    # Capture FIRST, split after. (Do not write `IFS=... read ... < <($K ...)`: the IFS assignment is still
    # in effect while the process substitution expands, so $K is no longer word-split and kubectl is
    # "command not found".)
    CREDS="$($K -n whatsapp-commerce get secret whatsapp-redis-url -o jsonpath='{.data.REDIS_URL}' | base64 -d | python3 -c '
import sys, urllib.parse as u
p = u.urlparse(sys.stdin.read().strip())
print(u.unquote(p.username or "default") + "\t" + u.unquote(p.password or ""))')"
    RUSER="${CREDS%%$'\t'*}"; RPASS="${CREDS#*$'\t'}"; unset CREDS
    echo "RedisInsight login: copied from the app's own Redis secret (NOT printed) — full access, see the caveat in this script"
  fi
  [ -n "$RPASS" ] || { echo "no Redis password found — refusing to create an empty secret" >&2; exit 1; }
  # process substitution + printf builtin: the values never appear in any process's argv
  $K -n cluster-tools create secret generic cluster-tools-redis \
    --from-file=username=<(printf %s "$RUSER") --from-file=password=<(printf %s "$RPASS")
  unset RUSER RPASS
  NEW_REDIS_SECRET=1
fi
# env from a Secret is read at pod start: restart only when the Secret is new
if [ "$NEW_REDIS_SECRET" = 1 ]; then
  $K -n cluster-tools rollout restart deploy/redisinsight
fi

for d in kafka-ui redisinsight adminer; do
  $K -n cluster-tools rollout status deploy/$d --timeout=240s
done

if [ "${1:-}" = "--secure-temporal" ]; then
  # Same plugins as the new routes. Adds auth to the existing temporal-web route (http[0]).
  $K -n temporal patch apisixroute temporal-web --type=json -p '[
    {"op":"add","path":"/spec/http/0/plugins","value":[
      {"name":"basic-auth","enable":true,"config":{"hide_credentials":true}},
      {"name":"consumer-restriction","enable":true,"config":{"type":"consumer_name","whitelist":["cluster_tools_cluster_tools_admin"]}}
    ]}]'
  echo "temporal-web.newfire.app now requires the shared login."
fi

echo ""
echo "URLs (401 without the login is correct):"
echo "  https://kafka-ui.newfire.app   https://redis-ui.newfire.app   https://pg-ui.newfire.app"
