#!/usr/bin/env bash
# Local load/stress/spike/soak run against the e2e docker-compose stack (never the shared cluster).
# usage: PLATFORM_URL=... DATABASE_URL=... .qa/perf/run-perf.sh <soak-seconds>
set -u
cd "$(dirname "$0")/../.."
SOAK="${1:-600}"
OUT=.qa/perf/results.txt
: > "$OUT"
run() { # label, args...
  local label="$1"; shift
  { echo; echo "### $label"; node scripts/perf/load.mjs "$@" 2>&1; } | tee -a "$OUT"
}
eval "$(JWT_SECRET=e2e-jwt-secret npx tsx .qa/perf/mint.ts)"
INPUT=$(node -e 'process.stdout.write(encodeURIComponent(JSON.stringify({json:{tenantId:process.argv[1]}})))' "$TENANT")
H="$PLATFORM_URL/health"
ME="$PLATFORM_URL/api/trpc/auth.me"
PL="$PLATFORM_URL/api/trpc/product.list?input=$INPUT"

echo "started $(date -u +%FT%TZ)  platform=$PLATFORM_URL" | tee -a "$OUT"
docker stats --no-stream --format 'baseline docker-stats {{.Name}} cpu={{.CPUPerc}} mem={{.MemUsage}}' 2>/dev/null | grep -E "platform|postgres|redis" | tee -a "$OUT"

# BASELINE (normal expected traffic)
run "BASELINE /health c=20 15s"            --url "$H"  --concurrency 20  --duration 15
run "BASELINE auth.me c=20 15s"            --url "$ME" --concurrency 20  --duration 15 --random-tenant
# LOAD (expected peak)
run "LOAD /health c=100 20s"               --url "$H"  --concurrency 100 --duration 20
run "LOAD auth.me c=100 20s"               --url "$ME" --concurrency 100 --duration 20 --random-tenant
# DB-backed authenticated read (per-tenant limiter is expected to engage: 200 req/min)
run "AUTHED product.list c=20 30s (limiter expected to engage)" --url "$PL" --concurrency 20 --duration 30 --header "Authorization: Bearer $TOKEN"
# STRESS / BREAKPOINT (ramp until it degrades)
for c in 200 400 800; do
  run "STRESS auth.me c=$c 20s"            --url "$ME" --concurrency $c --duration 20 --random-tenant
done
# SPIKE: calm -> spike -> calm, does latency recover?
run "SPIKE-1 calm c=10 10s"                --url "$ME" --concurrency 10  --duration 10 --random-tenant
run "SPIKE-2 spike c=400 10s"              --url "$ME" --concurrency 400 --duration 10 --random-tenant
run "SPIKE-3 recovery c=10 10s"            --url "$ME" --concurrency 10  --duration 10 --random-tenant

# SOAK: sustained load; sample container memory to catch leaks
( for i in $(seq 0 $((SOAK/30))); do
    docker stats --no-stream --format "soak t=$((i*30))s docker-stats {{.Name}} cpu={{.CPUPerc}} mem={{.MemUsage}}" 2>/dev/null | grep -E "platform|postgres|redis" >> "$OUT"
    sleep 30
  done ) &
SAMPLER=$!
run "SOAK auth.me c=50 ${SOAK}s"           --url "$ME" --concurrency 50  --duration "$SOAK" --random-tenant
kill $SAMPLER 2>/dev/null
echo "finished $(date -u +%FT%TZ)" | tee -a "$OUT"
