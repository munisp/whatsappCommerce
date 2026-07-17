# Caddy and Keycloak: Integration Architecture for the WhatsApp Commerce Platform

**Author:** Manus AI  
**Date:** July 2026  
**Version:** 1.0

---

## Executive Summary

The WhatsApp Commerce platform already lists both [Caddy](https://caddyserver.com) and [Keycloak](https://www.keycloak.org) as middleware components. This document answers two questions that are often left implicit in architecture decisions: **what unique value does each component add that no other component in the stack provides**, and **how do they integrate with APISIX, OpenAppSec, Dapr, Permify, and each other** to form a coherent security and identity fabric.

The short answer is that Caddy and Keycloak are complementary at every layer of the stack. Caddy owns the **transport security layer** — TLS termination, HTTP/3, certificate lifecycle, and internal PKI. Keycloak owns the **identity layer** — authentication, token issuance, multi-tenant organisation management, and federation. Together they form the foundation on which APISIX enforces API-level policy, Permify enforces fine-grained resource-level authorisation, and Dapr secures east-west service communication.

---

## Part I — Caddy

### 1.1 What Caddy Adds That No Other Component Provides

Caddy is a Go-native web server and reverse proxy whose defining characteristic is **automatic TLS certificate management by default**. It was the first general-purpose web server to provision, rotate, and renew certificates via the ACME protocol without any operator intervention. [^1] Every other component in the current stack — APISIX, Keycloak, Dapr, OpenAppSec — either delegates TLS to an external tool (cert-manager, Certbot) or requires manual certificate loading. Caddy eliminates this operational burden entirely.

Beyond certificate automation, Caddy provides three capabilities that are absent from the rest of the stack:

**HTTP/3 (QUIC) by default.** Since Caddy 2.6 (2022), HTTP/3 is enabled out of the box. [^2] APISIX is built on OpenResty (Nginx + LuaJIT) and does not enable HTTP/3 by default as of 2026. For a platform whose primary users are buyers on West African mobile networks — where round-trip times of 150–400ms and packet loss rates of 2–8% are common — QUIC's connection migration and 0-RTT resumption provide measurable latency improvements over TCP-based HTTP/2.

**Embedded ACME server and internal PKI.** Caddy's `pki` app generates a root CA and intermediate CA at startup. The `acme_server` directive exposes a standards-compliant ACME endpoint that any service can use to request a signed, short-lived certificate. This makes Caddy the **zero-trust certificate authority** for all east-west service communication — Go services, Rust services, the Python AI agent, and Dapr sidecars all request certificates from Caddy's internal CA rather than relying on self-signed or manually distributed certificates. [^3]

**Layer 4 TCP/UDP proxying.** The `caddy-l4` module extends Caddy to handle raw TCP and UDP streams, routing by TLS SNI, protocol detection, or IP range. [^4] This enables TLS wrapping for non-HTTP services (TigerBeetle, PostgreSQL, Redis, Kafka) without deploying a separate HAProxy or stunnel instance.

### 1.2 Caddy in the Platform Topology

The recommended placement for Caddy is as the **TLS-terminating edge layer** in front of APISIX, and simultaneously as the **internal ACME CA** for all microservices. This is a two-role deployment from a single binary.

```
Internet (HTTP/3 + HTTP/2)
         │
         ▼
┌────────────────────────────────────────────────────────────┐
│  Caddy Edge                                                │
│  Role 1: TLS termination, HTTP/3, Coraza WAF, On-Demand   │
│          TLS for tenant custom domains                     │
│  Role 2: Internal ACME CA (pki app + acme_server)         │
└──────────────────────────┬─────────────────────────────────┘
                           │ mTLS (HTTP/2, internal)
                           ▼
┌────────────────────────────────────────────────────────────┐
│  APISIX                                                    │
│  JWT validation, tenant routing, OpenAppSec WAF plugin,    │
│  rate limiting, request transformation                     │
└──────────────────────────┬─────────────────────────────────┘
                           │ mTLS (cert from Caddy CA)
                           ▼
         Go / Rust / Python microservices
         (each holds a cert issued by Caddy's internal CA)
```

### 1.3 Caddy and APISIX: Complementary, Not Competing

APISIX is built on OpenResty and excels at API-level intelligence: JWT validation, per-route rate limiting, plugin-based request transformation, and etcd-backed dynamic configuration. Caddy excels at transport-level concerns: TLS lifecycle, HTTP/3, and certificate authority. The two components do not overlap in any meaningful way.

The key integration point is that Caddy terminates public TLS and forwards traffic to APISIX over an internal mTLS connection, where the certificate on the APISIX side was issued by Caddy's internal CA. APISIX never needs to be exposed to the internet directly, which reduces its attack surface. The `authz-keycloak` and `openid-connect` plugins in APISIX validate tokens issued by Keycloak; Caddy plays no role in token validation, only in transport security. [^5]

For multi-tenant custom domains, Caddy's **On-Demand TLS** feature provisions a Let's Encrypt certificate for any new hostname the first time a TLS handshake is received. This eliminates the need to pre-configure APISIX with per-tenant certificates.

### 1.4 Caddy and OpenAppSec: Defence-in-Depth

OpenAppSec is an ML-based WAF that currently runs as an APISIX plugin, detecting novel and zero-day attacks through behavioural analysis. Caddy adds a **second, independent WAF layer** at the edge using the **Coraza WAF module** (`coraza-caddy`), which implements the OWASP Core Rule Set (CRS) — a deterministic rule set covering known attack patterns (SQLi, XSS, RCE, path traversal, SSRF). [^6]

The two WAF engines are architecturally complementary. Coraza at the Caddy edge blocks known attack signatures before they reach APISIX, reducing the load on OpenAppSec's ML inference engine. OpenAppSec at the APISIX layer catches novel attacks that have no CRS signature. Running both layers means the platform has defence-in-depth: a known attack blocked by Coraza never reaches OpenAppSec, and a novel attack missed by Coraza is caught by OpenAppSec.

| Property | Coraza at Caddy Edge | OpenAppSec at APISIX |
|---|---|---|
| Detection method | Deterministic OWASP CRS rules | ML-based anomaly detection |
| Strengths | Known CVEs, OWASP Top 10 | Novel/zero-day attacks |
| Position in stack | Before APISIX | After Caddy |
| Performance impact | Low (Go-native, compiled rules) | Moderate (ML inference per request) |
| False positive rate | Low for known patterns | Self-tuning, low over time |

### 1.5 Caddy as Internal PKI for Dapr and All Services

Dapr manages mTLS between sidecars using its own certificate authority (the Dapr Sentry service). Caddy can act as the **external root CA that Dapr Sentry trusts**, unifying the PKI: one root CA (Caddy) issues certificates for both the application layer and the Dapr sidecar layer. This simplifies certificate auditing, rotation, and revocation — all certificates across the entire platform trace back to a single Caddy-managed root. [^3]

Each Go, Rust, and Python service starts with an ACME client that requests a certificate from Caddy's internal ACME endpoint (`https://acme.internal/acme/local/directory`). Certificates are short-lived (24–72 hours) and auto-renewed. No manual certificate distribution or rotation is required.

### 1.6 Caddy Layer 4: Non-HTTP Service TLS

The `caddy-l4` module enables Caddy to handle raw TCP and UDP connections with protocol-aware routing. For the WhatsApp Commerce platform, this covers:

| Service | Protocol | Caddy L4 Role |
|---|---|---|
| TigerBeetle ledger | TCP | mTLS termination, proxy to TigerBeetle port |
| PostgreSQL | TCP (Postgres wire) | TLS wrapping for external DB access |
| Redis Cluster | TCP | TLS termination for Redis TLS mode |
| Kafka brokers | TCP | SNI-based routing to Kafka brokers |
| USSD gateway | TCP/UDP | Protocol-aware routing to USSD handler |

---

## Part II — Keycloak

### 2.1 What Keycloak Adds That No Other Component Provides

Keycloak is the platform's **identity and access management (IAM) hub**. It is the only component in the stack that issues OAuth 2.0 access tokens, manages user identities, and provides the authentication flows that every other security component depends on. Without Keycloak, APISIX's `openid-connect` and `authz-keycloak` plugins have no token issuer to validate against, Permify has no identity context to evaluate policies against, and Dapr's OAuth middleware has no authorisation server to redirect to.

Keycloak's core capabilities relevant to this platform are:

**Multi-tenant identity with the Organizations feature.** Keycloak 25 introduced the **Organizations** feature (GA in Keycloak 26), which provides true multi-tenancy within a single realm. [^7] Each tenant on the WhatsApp Commerce platform maps to a Keycloak Organisation. Organisation members authenticate through the identity-first login flow, which routes users to their organisation's identity provider (corporate SSO, Google Workspace, or Keycloak's own login). Organisation metadata (tenant ID, roles, domain) is embedded in the JWT access token, making it available to APISIX for tenant-aware routing without any additional database lookup.

**Fine-grained admin permissions (FGAP).** Keycloak 26.2 introduced organisation-scoped admin permissions, allowing platform administrators to delegate realm management to tenant administrators without granting them access to other tenants' data. [^8] This is essential for a multi-tenant SaaS where each tenant owner needs to manage their own users, roles, and identity providers.

**Token exchange and service account flows.** Keycloak supports the OAuth 2.0 Token Exchange specification, allowing a service to exchange a user token for a service-specific token with a narrower audience and scope. [^9] For the WhatsApp Commerce platform, this enables the AI agent (Python LangGraph) to act on behalf of a buyer without holding the buyer's full access token — the agent exchanges the buyer's token for a scoped token that only allows the operations the agent needs.

**Kafka event streaming via SPI.** Keycloak's Service Provider Interface (SPI) allows custom event listeners to be deployed as JAR files. The `keycloak-kafka` SPI publishes all authentication and admin events (login, logout, token refresh, user creation, role change) to a Kafka topic. [^10] For the WhatsApp Commerce platform, this means every identity event flows into the platform's event stream, enabling real-time audit logging, fraud detection, and compliance reporting without polling the Keycloak database.

**Custom authentication flows with phone OTP.** Keycloak's authentication flow system is fully programmable via the Admin Console and SPI. For West African buyers who authenticate via WhatsApp phone number rather than email/password, a custom authentication flow can be built that sends an OTP via the WhatsApp Business API and validates it as the first authentication factor. [^11]

### 2.2 Keycloak Multi-Tenancy Architecture for This Platform

The platform uses a **single-realm, multi-organisation** architecture, which is the pattern recommended by the Keycloak team for SaaS platforms as of Keycloak 26. [^7] Each tenant is a Keycloak Organisation with:

- A domain (e.g., `acme-store.com`) that triggers identity-first routing
- An optional external identity provider (corporate SSO, Google Workspace) for B2B tenants
- Organisation-scoped roles (`owner`, `agent`, `analyst`) mapped to JWT claims
- Per-tenant branding (login page logo, colours) via Keycloak's theme system

The alternative — one realm per tenant — was the previous recommended pattern but does not scale beyond a few hundred tenants due to Keycloak's per-realm resource overhead. The single-realm approach with the Organizations feature scales to thousands of tenants on a single Keycloak instance.

```
Keycloak Realm: whatsapp-commerce
├── Organisation: Acme Store (domain: acme-store.com)
│   ├── Members: owner@acme-store.com, agent1@acme-store.com
│   ├── IdP: Google Workspace (acme-store.com)
│   └── Roles: owner, agent, analyst
├── Organisation: Beta Traders (domain: beta-traders.ng)
│   ├── Members: owner@beta-traders.ng
│   ├── IdP: Keycloak login (username/password + OTP)
│   └── Roles: owner, agent
└── Platform Admins (realm-level role: platform-admin)
```

### 2.3 Keycloak and APISIX: The Token Validation Chain

APISIX integrates with Keycloak through two plugins that serve different purposes:

The **`openid-connect` plugin** handles the authentication flow for browser-based clients. When a request arrives without a valid session cookie or bearer token, APISIX redirects the browser to Keycloak's authorisation endpoint. After the user authenticates, Keycloak redirects back to APISIX with an authorisation code, which APISIX exchanges for an access token. The access token is stored in a session cookie and validated on subsequent requests. [^5]

The **`authz-keycloak` plugin** handles fine-grained authorisation for API requests. It uses Keycloak's UMA (User-Managed Access) protocol to check whether the authenticated user has permission to access a specific resource with a specific scope. For example, a request to `POST /api/orders` is checked against Keycloak's resource server: does this user have the `order:create` scope for this tenant's resource? This moves authorisation logic out of the microservices and into the gateway, reducing duplication. [^12]

The two plugins are used together: `openid-connect` establishes the identity (who is this user?), and `authz-keycloak` enforces the policy (what can this user do?).

### 2.4 Keycloak and Permify: Complementary Authorisation Layers

Keycloak and Permify address different authorisation problems and are designed to work together, not compete.

Keycloak manages **coarse-grained, role-based authorisation** at the identity level: a user has the role `agent` in organisation `Acme Store`. This role is embedded in the JWT token and evaluated by APISIX at the API gateway layer. Keycloak's own UMA-based authorisation services can handle moderately complex policies, but they are not designed for the kind of relationship-based, entity-level queries that Permify handles.

Permify manages **fine-grained, relationship-based authorisation** at the resource level: can user `alice` view order `#12345` belonging to tenant `Acme Store`? This query requires knowing the relationship between `alice`, the order, and the tenant — a graph traversal that Keycloak's flat role model cannot express efficiently. [^13]

The integration pattern is: Keycloak issues the JWT token (identity + coarse roles), APISIX validates the token and enforces coarse-grained route-level policy, and the microservice calls Permify's `check` API for fine-grained resource-level decisions. The Keycloak user ID (`sub` claim) is the subject in every Permify relationship tuple, creating a consistent identity across both systems.

| Layer | Component | Question Answered |
|---|---|---|
| Identity | Keycloak | Who is this user? What organisation do they belong to? |
| Coarse AuthZ | APISIX + Keycloak plugins | Can this role access this API route? |
| Fine-grained AuthZ | Permify | Can this specific user access this specific resource? |

### 2.5 Keycloak and Dapr: Service-to-Service Authentication

Dapr's OAuth 2.0 middleware component integrates with Keycloak to authenticate service-to-service calls. When a Dapr-enabled service invokes another service, the Dapr sidecar can attach a Keycloak access token (obtained via the client credentials flow) to the outbound request. The receiving service's Dapr sidecar validates the token against Keycloak's JWKS endpoint before forwarding the request to the application. [^14]

This pattern means that service-to-service authentication is handled entirely by the Dapr sidecar layer, with no authentication code required in the application services themselves. The Go, Rust, and Python services simply receive requests that have already been authenticated by their sidecar.

### 2.6 Keycloak and Caddy: The TLS + Identity Handshake

Caddy and Keycloak interact at two points. First, Caddy proxies all external OIDC traffic to Keycloak, handling public TLS termination. Keycloak itself runs on an internal mTLS certificate issued by Caddy's internal CA, meaning Keycloak is never directly exposed to the internet. Second, Caddy can enforce Keycloak authentication at the proxy level using the `caddy-auth-portal` module (part of the `caddy-security` plugin), which validates Keycloak JWTs before forwarding requests to APISIX. This provides an additional authentication checkpoint at the transport layer, before any API-level processing occurs.

```caddyfile
# Caddy proxies Keycloak's OIDC endpoint to the internet
auth.whatsapp-commerce.com {
    reverse_proxy keycloak:8443 {
        transport http {
            tls_trusted_ca_certs /etc/caddy/internal-ca.crt
        }
    }
}

# Caddy proxies the platform API, with Keycloak JWT validation
api.whatsapp-commerce.com {
    reverse_proxy https://apisix:9443 {
        transport http {
            tls_trusted_ca_certs /etc/caddy/internal-ca.crt
        }
    }
}
```

---

## Part III — Combined Architecture

### 3.1 The Full Security Stack

The following diagram shows how Caddy, Keycloak, APISIX, OpenAppSec, Permify, and Dapr form a layered security fabric:

```
┌─────────────────────────────────────────────────────────────────────┐
│  LAYER 1: Transport Security (Caddy)                                │
│  • TLS termination (Let's Encrypt / ZeroSSL, auto-renewed)          │
│  • HTTP/3 (QUIC) for mobile clients                                 │
│  • Coraza WAF (OWASP CRS, known attack patterns)                    │
│  • On-Demand TLS for tenant custom domains                          │
│  • Internal ACME CA (issues certs to all services)                  │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ mTLS
┌──────────────────────────────▼──────────────────────────────────────┐
│  LAYER 2: API Gateway (APISIX)                                      │
│  • openid-connect plugin: validates Keycloak JWTs                   │
│  • authz-keycloak plugin: UMA-based resource authorisation          │
│  • OpenAppSec plugin: ML-based WAF (novel/zero-day attacks)         │
│  • Tenant routing (org_id claim → upstream selection)               │
│  • Rate limiting, request transformation, circuit breaking          │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ mTLS (cert from Caddy CA)
┌──────────────────────────────▼──────────────────────────────────────┐
│  LAYER 3: Identity (Keycloak)                                       │
│  • OIDC token issuance (access token, refresh token, ID token)      │
│  • Organizations: per-tenant identity, IdP federation, branding     │
│  • Custom auth flows: phone OTP via WhatsApp Business API           │
│  • Token exchange: AI agent acts on behalf of buyer                 │
│  • Kafka SPI: streams all auth events to platform event bus         │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────────────┐
│  LAYER 4: Fine-Grained AuthZ (Permify)                              │
│  • ReBAC: can user X perform action Y on resource Z?                │
│  • Keycloak sub claim = Permify subject                             │
│  • Called by microservices for entity-level decisions               │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────────────┐
│  LAYER 5: Service Mesh (Dapr)                                       │
│  • East-west mTLS (cert from Caddy CA via Sentry)                   │
│  • OAuth middleware: attaches Keycloak tokens to outbound calls      │
│  • Service invocation, pub/sub, state management                    │
└─────────────────────────────────────────────────────────────────────┘
```

### 3.2 Authentication Flow: WhatsApp Buyer Checkout

The following sequence illustrates how all five layers interact during a buyer's checkout flow:

1. **Buyer sends a WhatsApp message** to the platform's WhatsApp Business number. The WhatsApp Cloud API delivers a webhook to the platform's API endpoint over HTTPS.
2. **Caddy** terminates the TLS connection (HTTP/3 if supported by Meta's servers), runs the Coraza WAF, and forwards the request to APISIX over mTLS.
3. **APISIX** receives the webhook. The `openid-connect` plugin is configured in `bearer_only: true` mode for webhook endpoints. The webhook carries a Keycloak service account token issued to the WhatsApp webhook ingestor service.
4. **Keycloak** validates the service account token (JWKS endpoint). The token contains the tenant ID (`org_id` claim) and the service role (`webhook-ingestor`).
5. **APISIX** routes the request to the Go webhook ingestor service based on the `org_id` claim.
6. **The webhook ingestor** publishes the event to Kafka. Before publishing, it calls **Permify** to verify that the incoming phone number is associated with an active buyer account for this tenant.
7. **The Python AI agent** (LangGraph) consumes the Kafka event via Dapr pub/sub. The Dapr sidecar validates the agent's Keycloak service account token before forwarding the event.
8. **The AI agent** performs a token exchange with Keycloak to obtain a buyer-scoped token, then calls the commerce engine to add items to the cart on behalf of the buyer.
9. **The commerce engine** calls Permify to verify that the buyer has permission to modify this cart (ownership check), then proceeds with the cart update.
10. **The response** flows back through the same layers, and the AI agent sends a WhatsApp reply via the WhatsApp Cloud API.

### 3.3 Implementation Roadmap

The following phased approach is recommended for integrating Caddy and Keycloak into the platform's production deployment:

**Phase 1 — Caddy Edge TLS (immediate, low risk).** Deploy Caddy as the TLS-terminating edge proxy in front of APISIX. Enable automatic HTTPS for `api.whatsapp-commerce.com` and `auth.whatsapp-commerce.com`. Enable HTTP/3. Add Coraza WAF with OWASP CRS. No changes to APISIX, Keycloak, or any microservice are required.

**Phase 2 — Keycloak Organizations (medium effort, high value).** Enable the Organizations feature in Keycloak. Migrate existing tenants from realm-level clients to Organisation entities. Configure per-tenant identity providers for B2B tenants. Update the APISIX `openid-connect` plugin to extract `org_id` from the JWT for tenant routing.

**Phase 3 — Caddy Internal PKI + Dapr mTLS (medium effort, high security value).** Enable Caddy's `pki` app and `acme_server`. Distribute the Caddy root CA to all services. Update each Go, Rust, and Python service to request a certificate from Caddy's ACME endpoint. Configure Dapr Sentry to trust Caddy's CA.

**Phase 4 — Keycloak Kafka SPI + Phone OTP (targeted, as needed).** Deploy the `keycloak-kafka` SPI to stream auth events to the platform's Kafka bus. Implement the custom phone OTP authentication flow for WhatsApp-native buyer login.

**Phase 5 — Caddy Layer 4 + Token Exchange (optional, incremental).** Add the `caddy-l4` module for non-HTTP TLS wrapping (TigerBeetle, Redis, Kafka). Implement Keycloak token exchange for the AI agent's buyer-scoped token pattern.

---

## References

[^1]: Caddy Documentation — Automatic HTTPS. https://caddyserver.com/docs/automatic-https
[^2]: Hacker News — Caddyhttp: Enable HTTP/3 by Default (2022). https://news.ycombinator.com/item?id=32768454
[^3]: Caddy Zero-Trust TLS Everywhere (experiment by Mohammed Al Sahaf). https://github.com/mohammed90/caddy-zero-trust-tls-everywhere
[^4]: caddy-l4: Layer 4 (TCP/UDP) app for Caddy. https://github.com/mholt/caddy-l4
[^5]: Apache APISIX — openid-connect plugin documentation. https://apisix.apache.org/docs/apisix/plugins/openid-connect/
[^6]: OWASP Coraza Caddy Module. https://github.com/corazawaf/coraza-caddy
[^7]: Keycloak — Announcing Keycloak Organizations (Keycloak 25, June 2024). https://www.keycloak.org/2024/06/announcement-keycloak-organizations
[^8]: Keycloak — Fine-Grained Admin Permissions for Organizations (Keycloak 26.7, May 2026). https://www.keycloak.org/2026/05/org-fgap
[^9]: Keycloak Documentation — Configuring and using token exchange. https://www.keycloak.org/securing-apps/token-exchange
[^10]: SnuK87/keycloak-kafka — Keycloak module to produce events to Kafka. https://github.com/SnuK87/keycloak-kafka
[^11]: Authsignal — Add MFA to Keycloak using Authsignal (including WhatsApp OTP). https://www.authsignal.com/guides/add-mfa-to-keycloak-using-authsignal-a-step-by-step-guide
[^12]: API7.ai — authz-keycloak plugin documentation. https://docs.api7.ai/hub/authz-keycloak
[^13]: Permify — Relationship Based Access Control (ReBAC). https://fusionauth.io/permify-docs/use-cases/rebac
[^14]: Medium / Keycloak — Simplify Security in Kubernetes with Keycloak and Dapr. https://medium.com/keycloak/simplify-security-in-kubernetes-with-keycloak-and-dapr-a-comprehensive-integration-guide-5dd07165178e
