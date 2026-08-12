# Wave 12 — Security & Compliance Model

This document is the canonical security model for the platform as of wave 12:
RBAC, membership, session policy, the KYB lifecycle and its gates, the new
business-registry verification and sanctions-screening adapters, the
`DEMO_TENANT` removal, rate-limit posture, secrets at rest, and residual
risks.

---

## 1. RBAC matrix

Roles are carried on the session JWT (`role` claim, see
`server/_core/auth.ts`) and enforced in `server/_core/trpc.ts`
(`protectedProcedure` / `adminProcedure`). `adminProcedure` is additionally
defended in depth by a Permify check when `PERMIFY_*` is configured; in
production a Permify outage **denies** rather than falls open.

| Surface | user | operator | analyst | admin |
|---|---|---|---|---|
| Own tenant data (orders, inventory, conversations, broadcasts) | RW | RW (assigned tenants) | R | RW |
| Tenant settings / channel linking | RW (own) | RW (assigned) | R | RW |
| KYB application submit (own tenant) | W | W | – | W |
| KYB review queue (approve / reject) | – | – | R (view only) | RW |
| Supplier directory listing toggle | W (own) | W (assigned) | R | RW |
| Credit limit approval (trade credit) | – | – | R | RW |
| User / role management | – | – | – | RW |
| Platform infra surfaces (apisix, metering, mlOps, heartbeat) | – | R (diag) | R | RW |
| Payment gateway credential config | – | – | – | RW |
| Audit log export | – | – | R | R |

Notes:
- `user` is strictly scoped to `tenantId` from the session; cross-tenant reads
  are rejected by the tenant-scoping middleware (`server/_core/tenantDomain.ts`
  + per-router `tenantId` predicates).
- `operator` is a support role: it can act on tenants explicitly assigned to
  it (membership table) but cannot touch platform config or KYB decisions.
- `analyst` is read-only everywhere; it exists for fraud/compliance review
  without grant of any mutation path.
- The JWT role check is the authoritative gate; Permify is layered on top for
  `adminProcedure`. A Permify failure in production is fail-closed.

## 2. Membership model

- Users belong to tenants via a membership relation (tenant ↔ user, with
  per-tenant role override where present).
- The session JWT carries `tenantId`; any request body `tenantId` that does
  not match the session tenant (or an assigned-tenant grant for operators) is
  rejected.
- There is no anonymous access to any tenant surface; `publicProcedure` is
  reserved for health checks and the OAuth/Keycloak callback.

## 3. Session policy

- Sessions are HS256 JWTs signed with `JWT_SECRET` (`server/_core/auth.ts`),
  transported in the `wa_session` cookie (HttpOnly) or `Authorization: Bearer`.
- **TTL: 12 hours** (`SESSION_TTL` = `12h`). Legacy `365d` tokens are no
  longer issued; any token older than the TTL fails verification.
- Revocation: logout rotates a per-user `sessionVersion` claim; admin
  "revoke all sessions" bumps it globally. Tokens with a stale version are
  rejected even if unexpired.
- Keycloak OIDC is supported when `KEYCLOAK_URL` is configured; the issued
  platform session still follows the same 12h TTL and revocation rules.

## 4. KYB lifecycle & gates

Lifecycle (persisted on `kycApplications`, router `server/routers/kyc.ts`):

```
not_started → in_progress → pending → (verified | rejected | expired)
```

Automated pre-checks (wave 12, `server/services/compliance/`) run
`runKybChecks({ businessName, registrationNumber, country })` when the
application is submitted and produce an **advisory** recommendation:

| Condition | Recommendation |
|---|---|
| Sanctions list hit (name fuzzy ≥ 0.8 token overlap or exact reg-number id) | `reject` |
| Sanctions screening **degraded** (list unavailable, no cache, no fallback) | `manual_review` |
| Registry `unavailable` / `not_found` / `mismatch` | `manual_review` |
| Registry `verified` and no sanctions hit | `auto_approve` |

`auto_approve` only **pre-fills** the review queue — a human admin still
clicks approve. `reject` blocks `kyc.submit` from proceeding to `pending`.

Gates enforced by KYB status:

| Gate | Required status |
|---|---|
| Go-live (WhatsApp channel activation) | `verified` |
| Supplier listing in marketplace directory | `verified` |
| Trade-credit limit approval | `verified` + admin credit review |

In production with `KYB_GATE_ACTIVE != 'false'`, a registry provider that is
`unavailable` **must not** count as verified
(`isVerifiedForGate()` in `registryVerify.ts` enforces fail-closed semantics).

## 5. Registry & sanctions adapters

### Business-registry verification (`registryVerify.ts`)

Adapter pattern mirroring the wave-11 payment provider framework. Selected by
`COMPLIANCE_REGISTRY_PROVIDER`:

| Provider | Env config | Behavior |
|---|---|---|
| `cac` | `CAC_API_BASE`, `CAC_API_KEY` | Nigeria Corporate Affairs Commission public registry API. Looks up by RC number, compares returned company name to the submitted name (normalized: case/diacritics/punctuation; token-overlap ≥ 0.8). |
| `customHttp` | `COMPLIANCE_REGISTRY_BASE_URL`, `COMPLIANCE_REGISTRY_API_KEY` (opt), `COMPLIANCE_REGISTRY_AUTH_HEADER` (opt) | Declarative HTTP adapter for any registry with a `/verify?registrationNumber=&country=` endpoint. |
| `disabled` (default) | — | Always returns `status: 'unavailable'`. |

Guarantees: 8s hard timeout, **no retry on 4xx**, API keys redacted from all
log lines (`redactSecrets`), never throws — every failure collapses to
`status: 'unavailable'` which is fail-closed at the gate.

### Sanctions screening (`sanctions.ts`)

- Source: `SANCTIONS_LIST_URL` (OFAC/UN/EU consolidated format, CSV or JSON),
  fetched with an 8s timeout and cached **24h** in-process.
- Failure cascade: fresh cache → remote refetch → stale cache (`staleCache`
  flag) → bundled minimal dev list (only when not production and
  `SANCTIONS_ALLOW_BUNDLED != 'false'`).
- **Degraded mode (production fail-closed):** if no list is available from
  any source, screening returns `{ hit: true, matches: [], degraded: true }`
  so callers route the entity to manual review. An unscreened entity is never
  auto-passed.
- Matching: normalize case/diacritics/punctuation; token overlap (containment)
  ≥ 0.8 is a fuzzy hit; exact registration-number ↔ entry `id` match is a
  hard hit.

### New env vars (wave 12 — owned by W12-B in `env.ts`; listed here for the .env contract)

```
COMPLIANCE_REGISTRY_PROVIDER=cac|customHttp|disabled   # default disabled
CAC_API_BASE=
CAC_API_KEY=
COMPLIANCE_REGISTRY_BASE_URL=
COMPLIANCE_REGISTRY_API_KEY=
COMPLIANCE_REGISTRY_AUTH_HEADER=                       # default Authorization
SANCTIONS_LIST_URL=
SANCTIONS_LIST_LABEL=                                  # default REMOTE
SANCTIONS_ALLOW_BUNDLED=true|false                     # default true (dev only)
KYB_GATE_ACTIVE=true|false                             # default true
```

## 6. DEMO_TENANT removal

Routers previously fell back to a hard-coded `DEMO_TENANT = "demo-tenant-001"`
when `ctx.user.tenantId` was absent — an implicit cross-tenant read path.
Wave 12 removes every fallback: a missing tenant context is now an error, not
a default. Client code must resolve the active tenant explicitly
(`useActiveTenant()`), never a constant.

## 7. Rate-limit posture

- Login/session endpoints: strict per-IP + per-account limits (fail-closed on
  limiter outage in production).
- KYB registry/sanctions adapters are **not** retried in-process (8s timeout,
  no 4xx retry) which bounds per-submission outbound amplification to one
  request per upstream.
- Webhook endpoints authenticate first (HMAC signature) and rate-limit second,
  so unauthenticated floods are dropped before signature work.

## 8. Secrets at rest (recap)

- Payment gateway credentials: AES-256-GCM in `payment_gateway_configs`
  (`server/services/crypto/secrets.ts`), decrypted only in memory at the
  provider boundary.
- Session signing: `JWT_SECRET` env-only, never persisted.
- Registry/sanctions API keys: env-only; never written to the database and
  redacted from all compliance log lines.

## 9. Residual risks

1. **Chatwoot token plaintext** — the Chatwoot integration token is stored
   unencrypted. Migrate to the AES-256-GCM secrets service.
2. **Payment-gateway KYC outsourced** — merchant-of-record KYC performed by
   the payment gateway (Paystack/Monnify/Flutterwave) is trusted as-is; its
   verdict is not independently re-verified.
3. **PEP screening limited to list quality** — sanctions/PEP coverage is only
   as good as the configured `SANCTIONS_LIST_URL`; the bundled fallback list
   is a minimal dev aid, and fuzzy matching at 0.8 can miss deliberate
   obfuscation (e.g. token reordering with added noise). Degraded mode
   mitigates list outages but not list incompleteness.
4. **In-process sanctions cache** — the 24h cache is per-process; multi-replica
   deployments should move it to shared storage to keep cache-hit semantics
   uniform.

## 10. W12.1 hardening wave

### Authorization coverage ratchet

`server/routers/__tests__/authzCoverage.test.ts` source-scans every router
file and fails CI if any procedure with a required `tenantId` input loses its
`assertTenantAccess` (or equivalent inline/role-scoped) guard. It also pins
the W12.1 surgical guards by name, so a guard can never be deleted silently —
only ever add procedures and guards. The ratchet caught
`onboarding.getProgress` (unguarded direct-tenantId read) when introduced.

### SSO rebind lock (keycloak)

Once a `tenant_sso_profiles` row exists, the tenant's SSO identity is locked
to the bound Keycloak subject: `keycloak.exchangeCode` rejects any different
`sub` with FORBIDDEN — even when the token's email matches a tenant user
(first-bind email verification is NOT a rebind path). The only rebind route
is `keycloak.rebindSsoProfile` (adminProcedure), which records an audit
warning (`[keycloak] SSO REBIND ...`) with the admin id and old/new subjects.

### KYB batch lookup

The procurement supplier directory resolves KYB trust flags via
`approvedKybTenantIds()` — ONE `inArray` query over `kyc_applications` per
directory page instead of N per-supplier round-trips. Fail-closed semantics
are unchanged: any query error yields an empty set (no tenant flagged
verified).

### KYC document-verification gate

`kyc.review` can no longer approve an application while any of its documents
is still awaiting OCR/VLM verification (`processedAt` unset) — the call fails
closed with PRECONDITION_FAILED naming the pending document types. An admin
may explicitly override with `waivePendingDocuments=true`; the waiver is
recorded on each pending document (`verificationNotes`) and in the
application's `reviewNotes` with the reviewer name and timestamp.

### Permify production gate (opt-in)

`adminProcedure` layers Permify on top of the role check only when
`PERMIFY_URL` is set. Setting `REQUIRE_PERMIFY=true` makes a production-like
boot refuse to start when `PERMIFY_URL` is unset (instead of silently
running without the defense-in-depth layer); outside production it downgrades
to a warning. Default off.

```
REQUIRE_PERMIFY=true|false   # default false; prod-fatal when PERMIFY_URL unset
```

### Id-keyed and list-filter guards

Id-keyed procedures now resolve the row's tenant and assert access before
reading/writing (invoice.send/markPaid/get, conversation.updateStatus,
logistics.simulateDelivery, broadcast.cancel/simulateDelivery,
slaExtension.listByEscrow, templateVersions.list/create via the owning
template, whatsappNotifications.sendOrderNotif/getOrderNotifStatus/
resendNotification/getCustomerReplies, and the nlp offline-queue procedures
via `assertNlpSessionAccess`). Optional-`tenantId` list filters
(agent.listAuditLog, broadcast.list, hermes.getEventLog/getPOQueue,
logistics.listShipments, marketplace.listCommissions,
temporal.startInventorySync) must pass `assertTenantAccess` when given, and
non-admin callers without a filter are scoped to their own tenant.
`cogsDispute.review` and `payment.getLedgerBalance` are admin-only.
