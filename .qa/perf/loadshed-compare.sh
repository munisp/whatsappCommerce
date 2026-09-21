#!/usr/bin/env bash
# QA-040: does load shedding bound the tail? Same server image, same load, shedding OFF vs ON. Local docker only —
# never the shared cluster. Needs: docker, node, an image built from the current tree.
#
#   .qa/perf/loadshed-compare.sh [image] [duration-seconds]
#
# It starts throwaway postgres + redis + the server on a private network, drives /api/trpc/auth.me (a trivial tRPC call,
# the same endpoint the baseline in summary.md used) at rising concurrency with scripts/perf/load.mjs, and prints one JSON
# result per (mode, concurrency). Everything is removed on exit.
set -u
cd "$(dirname "$0")/../.."
IMG="${1:-registry.digitalocean.com/talentgraph-auth/whatsapp-server:qa-local8}"
DUR="${2:-20}"
NET=perfshed-net; PORT=3999; OUT="${OUT:-.qa/perf/loadshed/latest.jsonl}"
cleanup() { docker rm -f perfshed-server perfshed-pg perfshed-redis >/dev/null 2>&1; docker network rm $NET >/dev/null 2>&1; }
trap cleanup EXIT; cleanup
docker network create $NET >/dev/null
docker run -d --name perfshed-pg --network $NET -e POSTGRES_DB=whatsapp_commerce -e POSTGRES_USER=wc_user -e POSTGRES_PASSWORD=wc_secret postgres:16-alpine >/dev/null
docker run -d --name perfshed-redis --network $NET redis:7-alpine redis-server --save "" --appendonly no >/dev/null
: > "$OUT"

# DRIVER=host      the load generator runs on THIS machine and reaches the server through Docker Desktop's port proxy.
# DRIVER=container  it runs in a container on the same private network, hitting the server directly. The host driver
#                   showed worst-case latencies equal to the whole test duration (a few connections starved for 20 s) —
#                   a signature of the client/proxy path, not of the server — so the container driver exists to separate
#                   the two. Default is `container`; use `host` only to reproduce the old numbers.
DRIVER="${DRIVER:-container}"
# RATE=<rps> switches to OPEN-LOOP (see scripts/perf/load.mjs --rate): arrivals do not wait for replies. That is the honest
# way to test overload — closed-loop clients slow down with the server, so a queue can never grow without bound.
drive() { # concurrency -> one JSON result on stdout
  local extra=()
  [ -n "${RATE:-}" ] && extra=(--rate "$RATE")
  if [ "$DRIVER" = host ]; then
    node scripts/perf/load.mjs --url "http://localhost:$PORT/api/trpc/auth.me" --concurrency "$1" --duration "$DUR" --random-tenant "${extra[@]}"
  else
    docker run --rm --network $NET -v "$PWD/scripts/perf:/perf:ro" node:22-bookworm-slim \
      node /perf/load.mjs --url "http://perfshed-server:3000/api/trpc/auth.me" --concurrency "$1" --duration "$DUR" --random-tenant "${extra[@]}"
  fi
}

run_mode() { # label, LOAD_SHED_ENABLED value, [LOAD_SHED_START_MS [LOAD_SHED_ALL_MS]]
  local label="$1" enabled="$2" start="${3:-}" all="${4:-}"
  docker rm -f perfshed-server >/dev/null 2>&1
  docker run -d --name perfshed-server --network $NET -p $PORT:3000 --cpus=2 \
    -e NODE_ENV=test -e PORT=3000 -e APP_URL=http://localhost:$PORT -e JWT_SECRET=e2e-jwt-secret -e INTERNAL_API_KEY=e2e-internal-key \
    -e DATABASE_URL="postgres://wc_user:wc_secret@perfshed-pg:5432/whatsapp_commerce?sslmode=disable" -e REDIS_URL=redis://perfshed-redis:6379 \
    -e LOAD_SHED_ENABLED="$enabled" ${start:+-e LOAD_SHED_START_MS="$start"} ${all:+-e LOAD_SHED_ALL_MS="$all"} "$IMG" >/dev/null
  for i in $(seq 1 60); do curl -fs -m 2 "http://localhost:$PORT/health" >/dev/null 2>&1 && break; sleep 1; done
  curl -fs -m 2 "http://localhost:$PORT/health" >/dev/null 2>&1 || { echo "server did not come up ($label)"; docker logs perfshed-server 2>&1 | tail -20; return 1; }
  # warm-up so JIT and connection pools are not part of the first measurement
  drive 20 >/dev/null 2>&1
  for c in ${LEVELS:-400 800}; do
    echo "### $label  auth.me c=$c ${DUR}s (driver: ${DRIVER})" >&2
    drive "$c" \
      | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);console.log(JSON.stringify({mode:process.argv[1],c:+process.argv[2],...r}))})' "$label" "$c" >> "$OUT"
  done
  docker logs perfshed-server 2>&1 | grep -c "\[load-shed\]" | sed "s/^/  load-shed log lines ($label): /" >&2
}
# ABBA order (OFF, ON, ON, OFF), not OFF-then-ON: a laptop's thermals, Docker VM and page cache drift over a long run, and
# with a single ordering "the second run was slower" is indistinguishable from "shedding made it slower".
for m in ${MODES:-off on on off}; do
  case "$m" in
    off)      run_mode shed-OFF false ;;
    on)       run_mode shed-ON true ;;
    on-never) run_mode shed-ON-neverfires true 1000000000 2000000000 ;; # enabled, sampler + middleware running, thresholds so high it can never shed
  esac
done
echo "results: $OUT" >&2
