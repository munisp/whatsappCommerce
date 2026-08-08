# E2E Test Suite

End-to-end integration tests that run against the **real** platform server and
its real backing services — no mocks of the system under test. The suite lives
in `tests/e2e/` and is orchestrated by `scripts/run-e2e.sh`.

```
tests/e2e/
├── vitest.config.ts          # single-fork, sequential files, 60s test timeout
├── docker-compose.test.yml   # ephemeral full stack (postgres/redis/tb-sidecar/
│                             # ledger-bridge/recon-worker/commerce-engine/
│                             # api-gateway/platform + ml-inference profile)
├── platform.Dockerfile       # platform image: pnpm install + drizzle migrate + tsx boot
├── fixtures/tb-sidecar.mjs   # in-memory TigerBeetle HTTP double (node:http only)
├── helpers/stack.ts          # CFG, tRPC client, JWT minters, SQL helpers,
│                             # reachable()/serviceConfigured() gates
├── smoke.test.ts             # every service answers its health route
├── trpc-contract.test.ts     # ~27 tRPC procedures, response shapes + auth levels
├── webhook-security.test.ts  # webhook signature/API-key enforcement (negative)
├── funds-flow.test.ts        # money-movement invariants (exactly-once, no negative)
└── service-to-service.test.ts# cross-service hops (ML, ledger, recon, gateway)
```

## Running — Docker path (canonical)

```bash
scripts/run-e2e.sh                  # full stack incl. the ml-inference profile
scripts/run-e2e.sh --no-ml          # skip ml-inference (ML tests self-skip)
scripts/run-e2e.sh --no-teardown    # keep the stack up afterwards (debugging)
scripts/run-e2e.sh -- funds-flow    # extra args are forwarded to vitest
```

The script builds the images, starts the stack with **ephemeral host ports**,
waits for all healthchecks (the platform container runs `drizzle-kit migrate`
on boot — its healthcheck doubles as the fresh-DB migration proof), resolves
the ports via `docker compose port`, exports the connection env vars
(`PLATFORM_URL`, `GATEWAY_URL`, `COMMERCE_URL`, `LEDGER_URL`, `RECON_URL`,
`ML_URL`, `DATABASE_URL`, `JWT_SECRET`, `INTERNAL_API_KEY`,
`PAYSTACK_WEBHOOK_SECRET`), runs vitest, and tears the stack down. The vitest
exit code propagates.

Env overrides: `COMPOSE_PROJECT` (default `wc-e2e`), `HEALTH_TIMEOUT`
(seconds, default 300).

## Running — local path (no Docker for the platform)

Useful for iterating on a single suite. You need a Postgres the tests can
reach (a throwaway container is fine) and optionally Redis.

```bash
# 1. deps + database
pnpm install
docker run -d --name wc-e2e-pg -p 5432:5432 \
  -e POSTGRES_DB=whatsapp_commerce -e POSTGRES_USER=wc_user \
  -e POSTGRES_PASSWORD=wc_secret postgres:16-alpine

# 2. schema
DATABASE_URL=postgres://wc_user:wc_secret@localhost:5432/whatsapp_commerce \
  pnpm db:push        # drizzle-kit generate && migrate

# 3. boot the platform (separate shell; tsx, not a build)
DATABASE_URL=postgres://wc_user:wc_secret@localhost:5432/whatsapp_commerce \
JWT_SECRET=e2e-jwt-secret \
INTERNAL_API_KEY=e2e-internal-key \
PAYSTACK_WEBHOOK_SECRET=e2e-paystack-webhook-secret \
NODE_ENV=test PORT=3000 \
  pnpm exec tsx server/_core/index.ts

# 4. run the suite (helpers/stack.ts defaults already point at localhost)
export DATABASE_URL=postgres://wc_user:wc_secret@localhost:5432/whatsapp_commerce
export JWT_SECRET=e2e-jwt-secret
export INTERNAL_API_KEY=e2e-internal-key
export PAYSTACK_WEBHOOK_SECRET=e2e-paystack-webhook-secret
pnpm exec vitest run --config tests/e2e/vitest.config.ts
```

Notes on the local path:

- `REDIS_URL` is optional outside production — the platform degrades with loud
  warnings (payment idempotency fail-open, rate limiting fail-open). The
  funds-flow idempotency test (c) needs Redis to exercise the CONFLICT path;
  run `docker run -d -p 6379:6379 redis:7-alpine` and export
  `REDIS_URL=redis://localhost:6379` for full fidelity.
- `LEDGER_BRIDGE_URL`, `ML_STACK_URL`, gateway/commerce/recon URLs are only
  needed for `service-to-service.test.ts`; unset services self-skip there
  (and make `payment.initiate` fail, which suite (c) surfaces — run those
  services or accept the failures when working locally).
- Suite env vars are read once at import time from `helpers/stack.ts` `CFG`;
  every value has a localhost default matching the compose secrets.

## Coverage map

| Suite | What it proves |
| --- | --- |
| `smoke.test.ts` | All 8 services answer their documented health routes with 200 (platform `/api/health/{postgres,redis,tigerbeetle}`, gateway `/health`+`/ready`, commerce-engine/ledger-bridge/recon-worker/ml-inference `/health`). |
| `trpc-contract.test.ts` | ~27 representative tRPC procedures across auth/system, infra/temporal/apisix/mlOps, product CRUD, orders (incl. oversell guard), conversations, payments, wallet, escrow config — validating response **shapes** and auth levels (UNAUTHORIZED floor, admin-only procedures). |
| `webhook-security.test.ts` | Negative tests: invalid/missing Paystack signatures are never accepted; `/api/internal/events` enforces `INTERNAL_API_KEY`; malformed escrow-bank callbacks 400. `it.todo`s pin the strict 401/200/503 contract for the webhook-hardening branch. |
| `funds-flow.test.ts` | Money invariants: (a) 10× concurrent `escrow.buyerConfirm` ⇒ exactly one state transition, one `escrow_release` wallet tx, one net credit (+ FORBIDDEN for non-buyers); (b) `wallet.requestWithdrawal` atomic conditional debit ⇒ over-balance and second withdrawals rejected with `INSUFFICIENT_FUNDS`, balance never negative, same-reference replays don't double-debit; (c) 5× concurrent `payment.initiate` with the same idempotency key ⇒ exactly one `payment_intents` row (CONFLICT or idempotent replay for losers); (d) Paystack webhook replay ⇒ `already-completed`, no double escrow hold or wallet credit. |
| `service-to-service.test.ts` | Cross-service hops: platform→ml `POST /predict` fraud score + source (live only with `ML_URL`/`ML_STACK_URL`); ledger-bridge reserve→commit / reserve→void balance deltas and idempotent replay through the tb-sidecar; recon-worker `/recon/trigger` + `/recon/last`; gateway `/api/v1` proxy mode detection (404 path-mismatch pin / 401 Keycloak, never 502). |

## Adding tests

1. Create `tests/e2e/<name>.test.ts`; files run sequentially in one fork
   (`fileParallelism: false`, `singleFork: true`) because they share one DB.
2. Use `helpers/stack.ts` — never hand-roll clients:
   - `trpcQuery`/`trpcMutation` speak the server's superjson transformer;
   - `mintPlatformSession(openId)` + `seedUser({...})` for platform auth
     (HS256 JWT; the openId must exist in `users`);
   - `mintGatewayJwt({ sub, tenant_id, role })` for the gateway's legacy mode;
   - `getSql()` for DB seeding/assertions (remember: `payment_intents` and
     `users`/`orders` use quoted camelCase columns, the escrow/wallet tables
     are snake_case — check `drizzle/schema.ts`, not the TS property names);
   - `uniqueId(prefix)` for tenant/order/customer ids so reruns never collide.
3. Gate tests that need optional services with `await reachable(url)` /
   `serviceConfigured("ENV_VAR")` + `ctx.skip()` — a missing optional service
   must never fail the suite.
4. Use `it.todo(...)` with a precise blocker description (file:line evidence)
   for behavior that is known-broken on main; don't assert aspirational
   contracts as live tests.
5. Verify every procedure name, route, and column you touch against the
   source with grep before pushing — the suites are expected to be
   self-documenting about the evidence (see the header comments).

## Known pins / todos

- **Gateway path mismatch** (`service-to-service.test.ts`, pinned + `it.todo`):
  `ForwardTo` (`services/gateway/internal/proxy/proxy.go:32`) preserves the
  full request URI, so `GET /api/v1/products` reaches commerce-engine as
  `/api/v1/products` while the engine mounts `/products`
  (`services/commerce-engine/cmd/main.go:38`) ⇒ 404 in legacy-HS256 mode. The
  200 contract is a todo until the route uses `ForwardToStripPrefix` (or the
  upstream mounts `/api/v1`). In Keycloak mode the same probe returns 401
  (minted HS256 tokens are rejected) — the test detects the mode by response.
- **Webhook middleware ordering** (`webhook-security.test.ts`, todos): the
  global `express.json()` runs before the route-level `express.raw()` on
  `/api/webhooks/paystack`; `toRawBody()` re-serializes the parsed object, so
  signatures verify against `JSON.stringify(body)` — compact-JSON round-trips
  byte-identically (this is why `funds-flow.test.ts` signs the exact compact
  body it sends). The strict 401/200 contract pins and the fail-closed
  `PAYSTACK_WEBHOOK_SECRET`-unset behavior land with the webhook-hardening
  branch; `/api/webhooks/escrow-bank` HMAC enforcement is likewise a todo.
- **Live-ML skips**: `service-to-service.test.ts`'s `/predict` test and
  `smoke.test.ts`'s ml-inference health check require the `ml` compose profile
  (`run-e2e.sh` default; `--no-ml` ⇒ the live assertions skip).
- **`escrow_config.platform_fee_rate` rounding**: the column is
  `numeric(6,4)`, so the seeded `0.03125` is stored as `0.0313`. Funds-flow
  reads the fee back from the escrow row instead of assuming a value.
