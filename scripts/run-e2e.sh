#!/usr/bin/env bash
# run-e2e.sh — build the E2E stack, wait for health, run the vitest E2E suite,
# tear down. Exit code propagates from vitest.
#
# Usage:
#   scripts/run-e2e.sh                  # full stack incl. ml-inference profile
#   scripts/run-e2e.sh --no-ml          # skip the ml-inference profile
#   scripts/run-e2e.sh --no-teardown    # keep the stack running after tests
#   scripts/run-e2e.sh -- <vitest args> # extra args forwarded to vitest
#
# Env overrides: COMPOSE_PROJECT (default wc-e2e), HEALTH_TIMEOUT (secs, 300).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="${ROOT}/tests/e2e/docker-compose.test.yml"
PROJECT="${COMPOSE_PROJECT:-wc-e2e}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-300}"
WITH_ML=1
TEARDOWN=1
VITEST_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-ml) WITH_ML=0; shift ;;
    --no-teardown) TEARDOWN=0; shift ;;
    --) shift; VITEST_ARGS+=("$@"); break ;;
    *) VITEST_ARGS+=("$1"); shift ;;
  esac
done

COMPOSE=(docker compose -p "${PROJECT}" -f "${COMPOSE_FILE}")
PROFILES=()
if [[ "${WITH_ML}" -eq 1 ]]; then
  PROFILES=(--profile ml)
fi

log() { printf '\033[1;34m[e2e]\033[0m %s\n' "$*"; }
err() { printf '\033[1;31m[e2e]\033[0m %s\n' "$*" >&2; }

# Resolve an ephemeral host port for a service → "host:port".
resolve_port() {
  local service="$1" container_port="$2" out
  out="$("${COMPOSE[@]}" port "${service}" "${container_port}" 2>/dev/null)" || return 1
  # `docker compose port` prints e.g. 0.0.0.0:32777 (or [::]:32777).
  out="${out##*$'\n'}"
  echo "127.0.0.1:${out##*:}"
}

EXIT_CODE=0
TEARDOWN_DONE=0
cleanup() {
  if [[ "${TEARDOWN}" -eq 1 && "${TEARDOWN_DONE}" -eq 0 ]]; then
    TEARDOWN_DONE=1
    log "tearing down (down -v)"
    "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1
  fi
}
trap cleanup EXIT INT TERM

# ── 1. build ──────────────────────────────────────────────────────────────────
log "building images"
if ! "${COMPOSE[@]}" "${PROFILES[@]}" build; then
  err "compose build failed"
  exit 1
fi

# ── 2. up ─────────────────────────────────────────────────────────────────────
log "starting stack (project=${PROJECT})"
if ! "${COMPOSE[@]}" "${PROFILES[@]}" up -d; then
  err "compose up failed"
  exit 1
fi

# ── 3. wait for health ────────────────────────────────────────────────────────
# The platform container runs drizzle-kit migrate before tsx boots, so it is
# the long pole; its healthcheck doubles as the fresh-DB migration gate.
log "waiting for services to become healthy (timeout ${HEALTH_TIMEOUT}s)"
deadline=$(( $(date +%s) + HEALTH_TIMEOUT ))
while :; do
  # healthy services: postgres, redis, tb-sidecar, platform
  unhealthy="$("${COMPOSE[@]}" ps --format '{{.Service}} {{.Health}}' 2>/dev/null \
    | awk '$2 != "" && $2 != "healthy" {print $1}')"
  starting="$("${COMPOSE[@]}" ps --format '{{.Service}} {{.State}}' 2>/dev/null \
    | awk '$2 != "running" {print $1}')"
  if [[ -z "${unhealthy}" && -z "${starting}" ]]; then
    break
  fi
  if [[ "$(date +%s)" -ge "${deadline}" ]]; then
    err "timed out waiting for health; not ready: ${unhealthy} ${starting}"
    "${COMPOSE[@]}" ps >&2
    "${COMPOSE[@]}" logs --tail=50 platform ledger-bridge >&2 2>/dev/null
    exit 1
  fi
  sleep 3
done
log "all healthchecks green"

# ── 4. export connection settings for the suite ───────────────────────────────
export PLATFORM_URL="http://$(resolve_port platform 3000)"
export GATEWAY_URL="http://$(resolve_port api-gateway 8080)"
export COMMERCE_URL="http://$(resolve_port commerce-engine 8083)"
export LEDGER_URL="http://$(resolve_port ledger-bridge 8095)"
export RECON_URL="http://$(resolve_port recon-worker 8096)"
export DATABASE_URL="postgres://wc_user:wc_secret@$(resolve_port postgres 5432)/whatsapp_commerce"
export JWT_SECRET="e2e-jwt-secret"
export INTERNAL_API_KEY="e2e-internal-key"
export PAYSTACK_WEBHOOK_SECRET="e2e-paystack-webhook-secret"
if [[ "${WITH_ML}" -eq 1 ]]; then
  export ML_URL="http://$(resolve_port ml-inference 8099)"
fi
log "PLATFORM_URL=${PLATFORM_URL}  DATABASE_URL=${DATABASE_URL}"

# ── 5. run the suite ──────────────────────────────────────────────────────────
cd "${ROOT}"
log "running vitest e2e suite"
if command -v pnpm >/dev/null 2>&1; then
  pnpm exec vitest run --config tests/e2e/vitest.config.ts "${VITEST_ARGS[@]}"
  EXIT_CODE=$?
else
  npx vitest run --config tests/e2e/vitest.config.ts "${VITEST_ARGS[@]}"
  EXIT_CODE=$?
fi

# ── 6. teardown + exit propagation ────────────────────────────────────────────
if [[ "${EXIT_CODE}" -ne 0 ]]; then
  err "e2e suite FAILED (exit ${EXIT_CODE}); recent platform logs:"
  "${COMPOSE[@]}" logs --tail=80 platform >&2 2>/dev/null
fi
cleanup
TEARDOWN_DONE=1
if [[ "${TEARDOWN}" -eq 0 ]]; then
  log "--no-teardown: stack still running (project=${PROJECT})"
fi
log "done (exit ${EXIT_CODE})"
exit "${EXIT_CODE}"
