# Security Audit — WhatsApp Commerce Platform

Branch: `fix/verify-security` · Base: `main` (e7d6337) · Scope: multi-tenant isolation,
tRPC authorization matrix, injection/traversal spot-check, APISIX + Permify enforcement,
JWT structure, Keycloak revocation/expiry behavior.

All fixes are pinned by `server/tenantIsolation.test.ts` (69 tests),
`server/jwtStructure.test.ts` (18 tests) and
`services/gateway/internal/middleware/keycloak_test.go` (10 tests).

Legend: ✅ secured · 🔧 fixed in this branch · ⚠️ residual risk / documented gap

---

## 1. Multi-tenant isolation — route → verdict matrix

Tenant model: `users.tenantId` binds a merchant to a tenant; `users.role=admin` is a
**platform** admin (bypasses tenant scoping by design). Guard: shared
`assertTenantAccess(user, tenantId)` in `server/_core/trpc.ts` (FORBIDDEN unless admin
or same-tenant).

| Procedure | Auth (before) | Tenant scope (before) | Verdict | Fix |
|---|---|---|---|---|
| `escrow.createHold` | protected | `assertTenantAccess` | ✅ already scoped | — |
| `escrow.confirmDelivery` | protected | **none** | 🔧 any user could transition ANY tenant's escrow | `assertTenantAccess(ctx.user, escrow.tenantId)` |
| `escrow.buyerConfirm` | protected | buyer email/phone match (`assertBuyerOrAdmin`) | ✅ already scoped | — |
| `escrow.bankSettlementConfirmed` | admin | n/a (platform op) | ✅ | — |
| `escrow.initiateRefund` | admin | n/a | ✅ | — |
| `escrow.bulkUpdateState` | admin | n/a | ✅ | — |
| `escrow.getByOrder` | protected | **none** | 🔧 cross-tenant escrow read | `assertTenantAccess(escrow.tenantId)` |
| `escrow.listAll` | protected | optional `tenantId` filter | 🔧 cross-tenant list (comment said "admin") | non-admin forced to own tenant, mismatch → FORBIDDEN |
| `escrow.getStats` | protected | cross-tenant aggregate | 🔧 platform financials readable by any user | now `adminProcedure` |
| `escrow.getTimeline` | protected | **none** | 🔧 cross-tenant timeline read | `assertTenantAccess(escrow.tenantId)` |
| `escrow.setConfig` | admin | n/a | ✅ | — |
| `escrowDispute.raise` | protected | input tenantId only, **no caller check** | 🔧 any user could FREEZE any tenant's escrow | `assertTenantAccess(input.tenantId)` |
| `escrowDispute.list` | protected | optional filter | 🔧 omitting tenantId listed ALL disputes | non-admin forced to own tenant |
| `escrowDispute.getByOrder` | protected | **none** | 🔧 cross-tenant dispute read | order tenant resolved + asserted |
| `escrowDispute.review` | admin | n/a | ✅ | — |
| `escrowDispute.escalate` | protected | **none** | 🔧 cross-tenant escalate | `assertTenantAccess(dispute.tenantId)` |
| `escrowDispute.escalationSlaStats` | protected | cross-tenant aggregate | 🔧 | now `adminProcedure` |
| `wallet.getBalance` / `listTransactions` / `requestWithdrawal` / `exportLedgerCsv` / `topUp` | protected | `assertTenantAccess` | ✅ already scoped | — |
| `wallet.getStats` | protected | cross-tenant aggregate | 🔧 | now `adminProcedure` |
| `wallet.reconcileTopUps` | admin | n/a | ✅ | — |
| `timelineAttachment.add` | protected | **none**; client-supplied `uploadedBy` | 🔧 cross-tenant write + identity spoof + unsanitized filename in storage key | tenant assert; `uploadedBy` derived from session; filename sanitized |
| `timelineAttachment.list` | protected | **none** | 🔧 cross-tenant read | tenant assert |
| `payment.list` | protected | **none** | 🔧 cross-tenant intent read | `assertTenantAccess` |
| `payment.initiate` | protected | **none** | 🔧 cross-tenant payment initiation | `assertTenantAccess` (before any Redis/DB work) |
| `payment.confirm` | admin | n/a | ✅ | — |
| `payment.stats` / `reconcileLedger` | protected | **none** | 🔧 cross-tenant financial read | `assertTenantAccess` |
| `payment.getLedgerBalance` | protected | accountId-only (ledger service) | ⚠️ no tenant dimension in TigerBeetle account ids; accept + document | — |
| `paymentGateway.configure` | protected | inline tenant check | ✅ (prior hardening) | — |
| `paymentGateway.getConfig` | protected | **none** | 🔧 cross-tenant config read (masked secrets) | `assertTenantAccess` |
| `paymentGateway.initiate` / `verify` / `listTransactions` / `verifyWebhookSignature` | protected | **none** | 🔧 cross-tenant money ops | `assertTenantAccess` |
| `orderCrud.create` | protected | **none** | 🔧 cross-tenant order creation | `assertTenantAccess` |
| `orderCrud.get` / `updateStatus` / `cancel` / `refund` | protected | **none** | 🔧 cross-tenant read/mutate/refund | order tenant resolved + asserted |
| `orderCrud.listRefunds` / `processRefund` | protected | **none** | 🔧 cross-tenant refund read/approval | tenant asserted |
| `tenant.list/get/create/update/stats` | admin (router-local) | n/a | ✅ | — |
| `tenant.getWhatsAppConfig` / `updateWhatsAppConfig` | admin (router-local) | n/a | ✅ non-admin → FORBIDDEN | — |
| `odoo.configure` / `syncAll`, `twenty.configure` / `syncContacts` | protected | router-local `assertTenantAccess` | ✅ (prior hardening) | — |
| `odoo.getConfig/saveConfig`, `twenty.getConfig/saveConfig`, `twenty.syncAll` | protected | `ctx.user.tenantId ?? DEMO_TENANT` | ⚠️ a user with NO tenantId falls back to shared `demo-tenant-001` credentials scope | documented; set tenantId on all accounts |
| `medusa.configure` | admin | n/a | ✅ | — |
| `apisix.listLive/deleteRoute/syncAll` | admin (+Permify defense-in-depth when `PERMIFY_URL` set) | n/a | ✅ | — |
| Cron `/api/scheduled/*` (20 routes) | `sdk.authenticateRequest` + `user.isCron` | n/a | ✅ all guarded (script-verified) | — |
| `/api/internal/events` | `x-internal-api-key` header | n/a | ✅ | — |

## 2. Authorization matrix (role sweep)

`adminProcedure` = role check (`users.role === "admin"`, authoritative) + Permify
defense-in-depth when `PERMIFY_URL` is set (fails closed in production).
Test-pinned rejections for non-admin callers: `escrow.setConfig`,
`escrow.bankSettlementConfirmed`, `escrow.initiateRefund`, `escrow.bulkUpdateState`,
`escrow.getStats`, `escrowDispute.review`, `escrowDispute.escalationSlaStats`,
`wallet.getStats`, `wallet.reconcileTopUps`, `payment.confirm`, `apisix.*`,
`tenant.*`, `medusa.configure`. Unauthenticated callers → UNAUTHORIZED on all
protected procedures. No fail-open paths found: Permify (`server/permify.ts`) and
gateway (`permify.go`) both deny on error in production-like envs; rate limiter
fails closed (503) in prod when Redis is down.

## 3. Injection / traversal / XSS spot-check

| Probe | Result |
|---|---|
| Raw SQL (`sql` template, `db.execute`) | ✅ all usages are drizzle parameterized templates (`sql\`... ${param}\`` → bound params). No `sql.raw` / string-concatenated queries found. |
| Path traversal — `mlOps.getMlflowRuns` / `getMetricHistory` | 🔧 **REAL**: user-controlled `experimentId` flowed into `path.join(MLRUNS_DIR, id)` + `fs.readdirSync` → `../../../etc` escaped the root. Fixed: strict `[A-Za-z0-9_-]+` allowlist + `path.resolve` containment check (BAD_REQUEST otherwise). Test-pinned. |
| Path traversal — `/api/evidence/:token/submit` | 🔧 hardened: `X-Filename` header flowed into the MinIO object key; now path components stripped (`/` `\` leading dots) before key construction (same for escrow timeline attachments). Storage is S3-key based (no disk path), so impact was limited — defense-in-depth. |
| XSS in client-rendered server data | ✅ React escapes by default; single `dangerouslySetInnerHTML` is the shadcn chart `<style>` block rendering local theme config, not server data. |
| Rate limiting on `/api/trpc` | ✅ two layers: APISIX `rate-limiting` plugin (200 req/60s per consumer, 429) and Express middleware (200 req/min per tenant/IP via Redis INCR+EXPIRE, fail-closed 503 in prod). |

## 4. APISIX + Permify enforcement audit

### APISIX (`services/middleware/apisix-config/`)
| Route | Authz | Rate limit | Verdict |
|---|---|---|---|
| `/api/webhook/whatsapp` | none (Meta HMAC verified downstream) | — | ⚠️ `ip-restriction` whitelist is `0.0.0.0/0` placeholder — restrict to Meta CIDRs in prod |
| `/api/trpc/*` | `jwt-auth` plugin | 200/60s per consumer | ✅ |
| `/api/external/*` | `key-auth` (X-API-Key) | 60/60s per IP | ✅ |
| Admin API (9180) | `${APISIX_ADMIN_KEY}` env | n/a | ✅ key not hardcoded |

⚠️ CORS on the tRPC route is `allow_origins: "*"` — acceptable only because auth is
Bearer/cookie-less for cross-origin; tighten to known origins if cookies are used cross-site.

### Gateway (`services/gateway/cmd/main.go`) route → Permify matrix
| Route group | JWT | Permify / role check | Verdict |
|---|---|---|---|
| `/health`, `/ready` | — | — | ✅ public by design |
| `/internal/waf/events`, `/internal/events/*` | internal token | — | ✅ |
| `/webhooks/*` | — | provider signature downstream | ✅ by design |
| `/api/v1/conversations*` | Keycloak RS256 | `RequirePermify(tenant:view)` | ✅ |
| `/api/v1/products` GET, `inventory/:sku` | Keycloak | **none** | ⚠️ catalog reads are authenticated but not Permify-checked (tenant filter is downstream) |
| `/api/v1/products` POST/PUT/DELETE | Keycloak | `tenant:edit/delete` | ✅ |
| `/api/v1/carts*` | Keycloak | **none** | ⚠️ same as above (cart ownership enforced in commerce-engine) |
| `/api/v1/orders` list | Keycloak | `tenant:view` | ✅ |
| `/api/v1/orders/:id` (+cancel/confirm) | Keycloak | `order:view/cancel/fulfill` | ✅ |
| `/api/v1/payments/initiate`, `/payments/:id/status` | Keycloak | **none** | ⚠️ money-adjacent endpoints without Permify; covered by idempotency + downstream tenant checks |
| `/api/v1/payments/:id/refund` | Keycloak | `tenant:edit` | ✅ |
| `/api/v1/ai/*`, `/api/v1/ml/*` | Keycloak | **none** | ⚠️ authenticated-only |
| `/api/v1/admin/*` | Keycloak | `RequireRole(admin, platform_engineer)` + `RequirePermify(system:manage)` | ✅ |

Permify failure policy: `failClosed = cfg.IsProductionLike()` — unconfigured /
unreachable / 5xx / unparseable ⇒ DENY in production (mirrors `server/permify.ts`).
Gateway admin routes all return "not implemented" stubs, so no unguarded data paths.

## 5. JWT structure validation

| Layer | Structure | Alg | iss | exp | aud | Verdict |
|---|---|---|---|---|---|---|
| Gateway `KeycloakJWTAuth` (`keycloak.go`) | jwt/v5 parser (rejects non-3-part) | RS256 only (`WithValidMethods` + keyfunc type assert) | `WithIssuer` | `WithExpirationRequired` | `WithAudience` when configured | ✅ test-pinned (alg=none, malformed, expired, wrong iss/aud/key all → 401) |
| Gateway legacy `JWTAuth` (`middleware.go`) | jwt/v5 | HMAC-only keyfunc check | — | required by lib | — | ✅ dev fallback only; disabled when Keycloak configured |
| Server Keycloak bearer (`sdk.ts`) | jose `jwtVerify` | `algorithms:["RS256"]` | `issuer` pinned to realm URL | enforced by jose | enforced when `KEYCLOAK_AUDIENCE` set | ✅ test-pinned vs local JWKS server |
| Server `wa_session` / legacy cookie (`auth.ts`, `sdk.verifySession`) | jsonwebtoken / jose | HS256 pinned | — | enforced | — | ✅ test-pinned (alg=none, 2/4-part, wrong secret, expired) |

## 6. Keycloak revocation & expiry under load

- **Expiry honored**: gateway requires `exp` and rejects expired tokens (test:
  64 concurrent expired ⇒ 64×401, 64 concurrent valid ⇒ 64×200 against the shared
  JWKS cache). Server side: jose enforces `exp`; concurrency test-pinned.
- **JWKS cache TTL**: gateway = explicit `10 * time.Minute` (`jwksCache.ttl`,
  asserted ≤10min by `TestJWKSCacheTTL`); server = jose `createRemoteJWKSet`
  defaults (`cacheMaxAge` 10 min, `cooldownDuration` 30 s). Both ≤10 min ⇒ key
  rotation/revocation propagates within ≤10 minutes.
- **Revocation (immediate)**: JWTs are self-contained — a revoked-but-unexpired
  token verifies until `exp`. Mitigations in place: short Keycloak access-token
  lifetimes (realm setting), ≤10-min JWKS refresh for key-level revocation, and
  gateway **introspection fallback** (`introspectToken`) when the kid is unknown.
  ⚠️ For sub-token-lifetime revocation guarantees, reduce Keycloak access-token
  TTL or route sensitive ops through introspection.
- **alg=none / confusion**: rejected at every layer (tests in both stacks).

## Validation

- `npx tsc --noEmit` → **0 errors**
- `npx vitest run` → **15 files, 489 passed / 7 skipped / 0 failed**
- `go build ./...` (services/gateway, `GOPROXY=https://goproxy.cn,direct`) → **clean**
- `go test ./internal/middleware/` → **ok** (10/10 JWT tests pass)
