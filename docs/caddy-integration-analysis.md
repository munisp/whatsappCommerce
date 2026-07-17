# Caddy Integration Analysis: Value and Architecture for the WhatsApp Commerce Platform

**Author:** Manus AI  
**Date:** July 2026  
**Version:** 1.0

---

## Executive Summary

[Caddy](https://caddyserver.com) is a modern, Go-native web server and reverse proxy that brings three capabilities to the WhatsApp Commerce platform that no other single component in the current stack provides: **automatic TLS certificate lifecycle management**, **an embedded ACME certificate authority for internal mTLS**, and **HTTP/3 (QUIC) as a first-class default**. Rather than replacing APISIX or OpenAppSec, Caddy occupies a distinct and complementary layer — the **TLS edge and internal PKI layer** — that sits in front of APISIX for external traffic and acts as the mTLS certificate authority for all east-west service communication. This document explains what Caddy adds, how it integrates with each platform component, and provides a concrete deployment architecture.

---

## 1. What Caddy Is

Caddy is a production-grade, extensible server platform written entirely in Go. Its architecture is built around a **module system**: every capability (HTTP server, TLS manager, reverse proxy, ACME server, Layer 4 proxy) is a pluggable module compiled into a single binary using `xcaddy`. This design means Caddy can be precisely composed for a given role without carrying unused dependencies.

The three properties that define Caddy's identity are:

**Automatic HTTPS by default.** Caddy was the first web server to provision, rotate, and renew TLS certificates automatically using the ACME protocol (Let's Encrypt, ZeroSSL). No cron jobs, no Certbot, no manual renewal. Certificate provisioning happens at startup and renewal happens in the background with zero downtime. [^1]

**Embedded ACME server and internal PKI.** Caddy ships a built-in certificate authority (`pki` app) and an ACME server (`acme_server` directive). Any ACME-compatible client — including other Caddy instances, Go services, or Rust services — can request a signed certificate from Caddy's internal CA. This makes Caddy the natural **zero-trust PKI root** for a microservices cluster. [^2]

**HTTP/3 (QUIC) enabled by default.** Since Caddy 2.6 (2022), HTTP/3 is on by default. For a WhatsApp Commerce platform where buyers connect from West African mobile networks with high latency and packet loss, QUIC's connection migration and 0-RTT resumption provide measurable improvements over TCP-based HTTP/2. [^3]

---

## 2. The Current Platform Stack and the Gap Caddy Fills

The WhatsApp Commerce platform currently runs the following network-layer components:

| Layer | Component | Responsibility |
|---|---|---|
| External edge | APISIX | API gateway, rate limiting, JWT auth, tenant routing, plugin ecosystem |
| WAF | OpenAppSec | ML-based threat prevention, OWASP rule enforcement |
| Auth | Keycloak | OIDC/SAML identity provider, token issuance |
| AuthZ | Permify | Fine-grained relationship-based access control |
| Service mesh | Dapr | East-west service invocation, pub/sub, state management |
| Observability | OpenSearch | Log aggregation, distributed tracing |

**The gap:** None of these components manages TLS certificates for the services themselves, and none provides HTTP/3 to external clients. APISIX handles routing but relies on external certificate management (typically a manual process or a separate cert-manager). Dapr's mTLS is self-managed but not integrated with a shared PKI. There is no single authority that issues and rotates certificates for all services.

Caddy fills this gap by acting as:

1. **The TLS-terminating edge proxy** in front of APISIX, handling HTTP/3, automatic public certificate management, and ECH (Encrypted ClientHello).
2. **The internal ACME CA** that issues short-lived mTLS certificates to all microservices (Go, Rust, Python) for east-west encryption.
3. **A Layer 4 TCP/UDP proxy** for non-HTTP protocols (database connections, Kafka, Redis) that need TLS wrapping without HTTP overhead.

---

## 3. Caddy and APISIX: Complementary, Not Competing

A common question is whether Caddy replaces APISIX. The answer is no — they serve different purposes and work best in a **two-tier architecture**.

### 3.1 Recommended Topology

```
Internet
    │
    ▼
┌─────────────────────────────────────────────────────────┐
│  Caddy (Edge Layer)                                     │
│  • Terminates TLS (Let's Encrypt / ZeroSSL)             │
│  • Serves HTTP/3 (QUIC) to mobile clients               │
│  • Enforces Coraza WAF (OWASP CRS) at L7                │
│  • Strips and re-issues mTLS certs for upstream         │
│  • Rate-limits by IP before traffic reaches APISIX      │
└──────────────────────┬──────────────────────────────────┘
                       │ HTTP/2 (internal, mTLS)
                       ▼
┌─────────────────────────────────────────────────────────┐
│  APISIX (API Gateway Layer)                             │
│  • JWT validation, tenant routing, plugin ecosystem     │
│  • Per-route rate limiting, request transformation      │
│  • OpenAppSec plugin for ML-based WAF (second layer)    │
│  • Routes to Go/Rust/Python microservices               │
└─────────────────────────────────────────────────────────┘
```

In this topology, Caddy handles everything that requires TLS and HTTP/3 at the edge, while APISIX handles everything that requires API-level intelligence (JWT validation, tenant-aware routing, plugin-based transformations). Neither component duplicates the other's work.

### 3.2 Why Not Put APISIX at the Edge Directly?

APISIX is built on OpenResty (Nginx + LuaJIT). While it supports TLS termination, it does not provide automatic certificate management — certificates must be provisioned externally and loaded into APISIX's etcd configuration. For a multi-tenant SaaS platform where each tenant may have a custom domain, managing certificates for hundreds of domains manually is operationally expensive. Caddy's **On-Demand TLS** feature solves this: it provisions a certificate for any new hostname the first time a TLS handshake is received, with no pre-configuration required. [^1]

### 3.3 Configuration Example

```caddyfile
# Caddy edge: terminates TLS, proxies to APISIX over mTLS
{
    order coraza_waf first
    acme_ca https://acme.internal.whatsapp-commerce.com/acme/local/directory
}

# Wildcard tenant domains — On-Demand TLS
*.tenants.whatsapp-commerce.com {
    tls {
        on_demand
        issuer acme {
            ca https://acme.letsencrypt.org/directory
        }
    }
    coraza_waf {
        load_owasp_crs
        directives `
            Include @coraza.conf-recommended
            Include @crs-setup.conf.example
            Include @owasp_crs/*.conf
            SecRuleEngine On
        `
    }
    reverse_proxy https://apisix:9443 {
        transport http {
            tls_trusted_ca_certs /etc/caddy/internal-ca.crt
        }
    }
}

# Platform API
api.whatsapp-commerce.com {
    reverse_proxy https://apisix:9443 {
        transport http {
            tls_trusted_ca_certs /etc/caddy/internal-ca.crt
        }
    }
}
```

---

## 4. Caddy and OpenAppSec: Defence-in-Depth

OpenAppSec is an ML-based WAF that currently runs as an APISIX plugin. Caddy adds a **second, independent WAF layer** at the edge using the **Coraza WAF module** (`coraza-caddy`), which is 100% compatible with OWASP Core Rule Set (CRS) and ModSecurity syntax. [^4]

### 4.1 Why Two WAF Layers?

OpenAppSec uses machine learning to detect novel attacks without requiring rule updates. Coraza/Caddy uses the OWASP CRS, a deterministic rule set covering known attack patterns (SQLi, XSS, RCE, path traversal, etc.). The two approaches are complementary:

| Property | Coraza (Caddy edge) | OpenAppSec (APISIX) |
|---|---|---|
| Detection method | Deterministic OWASP CRS rules | ML-based anomaly detection |
| Strengths | Known CVEs, OWASP Top 10, zero false negatives on known attacks | Novel/zero-day attacks, adaptive learning |
| Position | L7 edge, before APISIX | API gateway layer, after Caddy |
| Performance impact | Low (Go-native, compiled rules) | Moderate (ML inference per request) |
| Configuration | ModSecurity SecLang directives | Policy-based, self-tuning |

Running Coraza at the Caddy edge means that known attack patterns are blocked before they ever reach APISIX or OpenAppSec, reducing the load on the ML engine and providing a hard deterministic backstop.

### 4.2 OpenAppSec and Caddy: Direct Integration

OpenAppSec currently supports NGINX and NGINX Proxy Manager as attachment points. [^5] It does not yet ship a native Caddy module. The recommended integration pattern is therefore **sequential**: Caddy (with Coraza) at the edge, OpenAppSec attached to APISIX (which runs on OpenResty/Nginx) as the second layer. This gives the platform two independent WAF engines with different detection philosophies.

If a future version of OpenAppSec ships a Caddy module (the project is actively adding integrations), it could replace Coraza at the edge for a unified ML-first approach.

---

## 5. Caddy as Internal PKI: mTLS for All Services

The most strategically important use of Caddy in this platform is as the **internal certificate authority**. Caddy's `pki` app generates a root CA and an intermediate CA at startup. The embedded `acme_server` directive exposes a standards-compliant ACME endpoint that any service can use to request a signed certificate.

### 5.1 How It Works

```
┌─────────────────────────────────────────────────────────┐
│  Caddy PKI App                                          │
│  Root CA: whatsapp-commerce-root                        │
│  Intermediate CA: whatsapp-commerce-intermediate        │
│  ACME endpoint: https://acme.internal/acme/local/dir    │
└──────────────────────────────────────────────────────────┘
         │ issues certs to
    ┌────┴──────────────────────────────────────────┐
    │                                               │
    ▼                                               ▼
Go services                                 Rust services
(api-gateway, webhook-ingestor,             (event-processor,
 commerce-engine, payment-orch)              ledger-bridge, recon-worker)
    │                                               │
    ▼                                               ▼
Python AI agent                             Dapr sidecars
(langraph-orchestrator)                     (use Caddy CA for mTLS)
```

Each service starts with an ACME client (Go: `golang.org/x/crypto/acme`, Rust: `instant-acme`) that requests a certificate from Caddy's internal ACME server. Certificates are short-lived (24–72 hours) and auto-renewed. This eliminates the operational burden of manual certificate rotation and provides true zero-trust east-west encryption.

### 5.2 Integration with Dapr

Dapr already manages mTLS between sidecars using its own certificate authority (the Dapr control plane). Caddy can replace or augment this by acting as the external CA that Dapr's `sentry` service trusts. This unifies the PKI: one root CA (Caddy) issues certificates for both the application layer and the Dapr sidecar layer, simplifying certificate auditing and rotation. [^6]

### 5.3 Integration with Keycloak

Keycloak's HTTPS endpoint can be backed by a certificate issued by Caddy's internal CA. Caddy proxies external OIDC traffic to Keycloak, handling the public TLS termination, while Keycloak itself runs on an internal mTLS certificate. This means Keycloak never needs to be exposed directly to the internet.

```caddyfile
auth.whatsapp-commerce.com {
    reverse_proxy keycloak:8443 {
        transport http {
            tls_trusted_ca_certs /etc/caddy/internal-ca.crt
        }
    }
}
```

---

## 6. Caddy Layer 4: TCP/UDP Proxying for Non-HTTP Services

The `caddy-l4` module extends Caddy to handle raw TCP and UDP connections. [^7] For the WhatsApp Commerce platform, this enables several use cases that HTTP-only proxies cannot address:

| Use Case | Protocol | Caddy L4 Role |
|---|---|---|
| TigerBeetle ledger access | TCP | Terminate mTLS, proxy to TigerBeetle port |
| PostgreSQL connections | TCP (Postgres wire) | TLS wrapping for external DB access |
| Redis Cluster | TCP | TLS termination for Redis TLS mode |
| Kafka broker access | TCP | SNI-based routing to Kafka brokers |
| USSD gateway | TCP/UDP | Protocol-aware routing to USSD handler |

The L4 module can inspect the beginning of a TCP stream to detect the protocol (TLS SNI, HTTP, SSH, Postgres, etc.) and route accordingly — all within a single Caddy process. This eliminates the need for separate HAProxy or stunnel instances for non-HTTP TLS termination.

---

## 7. Caddy and the WhatsApp Mobile Client: HTTP/3 Impact

The platform's primary users are buyers on WhatsApp in West Africa (Nigeria, Ghana, Kenya). Mobile network conditions in these markets are characterised by high latency (100–400ms RTT), packet loss (2–8%), and frequent connection switching between 4G and 3G. HTTP/3 (QUIC) addresses these conditions directly:

| Property | HTTP/2 (TCP) | HTTP/3 (QUIC) |
|---|---|---|
| Connection setup | 3-way TCP + TLS 1.3 = 2–3 RTTs | 0-RTT or 1-RTT (QUIC + TLS 1.3 combined) |
| Head-of-line blocking | Per-connection HOL blocking | Eliminated (independent streams) |
| Connection migration | Lost on IP change (4G→3G) | Preserved via Connection ID |
| Packet loss recovery | TCP retransmission (slow) | QUIC FEC + faster recovery |

Caddy has shipped production-grade HTTP/3 since 2.6 (2022) and enables it by default. [^3] No NGINX-based proxy (including APISIX's underlying OpenResty) enables HTTP/3 by default as of 2026. Placing Caddy at the edge gives the platform HTTP/3 without any APISIX reconfiguration.

---

## 8. Caddy and Kubernetes: Ingress Controller

The platform ships Kubernetes manifests. The official `caddy-ingress-controller` (Helm chart available on Artifact Hub, v1.3.0 released January 2025) provides a drop-in replacement for the NGINX Ingress Controller with the following advantages: [^8]

- Automatic TLS for all Ingress resources (no cert-manager required)
- Dynamic reconfiguration via Caddy's Admin API (no pod restarts on config changes)
- Native HTTP/3 for all Ingress-exposed services
- Caddyfile or JSON config via annotations

In a Kubernetes deployment, the recommended topology is:

```
Ingress (Caddy Ingress Controller)
    → APISIX Service (ClusterIP)
        → Microservice Pods (with Dapr sidecars, mTLS via Caddy internal CA)
```

---

## 9. Recommended Integration Architecture

The following table summarises the recommended role of Caddy alongside each existing platform component:

| Component | Caddy's Relationship | Integration Pattern |
|---|---|---|
| **APISIX** | Upstream of Caddy; Caddy terminates public TLS and proxies to APISIX over mTLS | Caddy edge → APISIX:9443 (mTLS) |
| **OpenAppSec** | Parallel WAF layer; Coraza at Caddy edge, OpenAppSec at APISIX layer | Sequential: Caddy (Coraza) → APISIX (OpenAppSec) |
| **Keycloak** | Caddy proxies OIDC traffic to Keycloak; Keycloak cert issued by Caddy CA | Caddy → Keycloak:8443 (internal mTLS) |
| **Permify** | Caddy issues mTLS cert to Permify; services call Permify over mTLS | Caddy CA → Permify cert; services use cert |
| **Dapr** | Caddy CA can act as external CA for Dapr Sentry | Caddy PKI → Dapr Sentry trust anchor |
| **Redis** | Caddy L4 module wraps Redis in TLS | Caddy L4 TCP → Redis:6379 |
| **Kafka** | Caddy L4 SNI routing to Kafka brokers | Caddy L4 TCP SNI → Kafka:9093 |
| **TigerBeetle** | Caddy L4 mTLS termination for ledger access | Caddy L4 TCP → TigerBeetle:3000 |
| **PostgreSQL** | Caddy L4 TLS wrapping for external DB access | Caddy L4 TCP → Postgres:5432 |
| **Kubernetes** | Caddy Ingress Controller replaces NGINX Ingress | caddy-ingress-controller Helm chart |

---

## 10. Implementation Roadmap

The following phased approach is recommended for integrating Caddy into the platform:

**Phase 1 — Edge TLS (immediate value, low risk)**
Deploy Caddy as the TLS-terminating edge proxy in front of APISIX. Enable automatic HTTPS for `api.whatsapp-commerce.com` and `*.tenants.whatsapp-commerce.com`. Enable HTTP/3. Add Coraza WAF with OWASP CRS. This phase requires no changes to APISIX or any microservice.

**Phase 2 — Internal PKI (medium effort, high strategic value)**
Enable Caddy's `pki` app and `acme_server`. Distribute the Caddy root CA certificate to all services. Update each Go, Rust, and Python service to request a certificate from Caddy's ACME endpoint on startup. Configure Dapr Sentry to trust Caddy's CA. This phase establishes zero-trust east-west encryption across the entire platform.

**Phase 3 — Layer 4 TCP/UDP proxying (targeted, as needed)**
Add the `caddy-l4` module for non-HTTP services that require TLS wrapping (TigerBeetle, Redis, Kafka). This phase is optional and can be implemented incrementally per service.

**Phase 4 — Kubernetes Ingress (if/when deploying to K8s)**
Replace the NGINX Ingress Controller with `caddy-ingress-controller`. All existing Ingress resources continue to work; Caddy adds automatic TLS and HTTP/3 transparently.

---

## 11. Service Scaffold: `services/caddy-edge/`

A ready-to-deploy Caddy edge service is included in the platform monorepo at `services/caddy-edge/`. It includes:

- `Dockerfile` — builds a custom Caddy binary with Coraza WAF and caddy-l4 modules via `xcaddy`
- `Caddyfile` — production configuration for edge TLS, Coraza WAF, APISIX upstream, and internal PKI
- `docker-compose.yml` — local development stack with Caddy + APISIX + Keycloak
- `k8s/` — Kubernetes manifests for the Caddy Ingress Controller

---

## References

[^1]: Caddy Documentation — Automatic HTTPS. https://caddyserver.com/docs/automatic-https
[^2]: Caddy Documentation — ACME Server directive. https://caddyserver.com/docs/caddyfile/directives/acme_server
[^3]: Hacker News — Caddyhttp: Enable HTTP/3 by Default (2022). https://news.ycombinator.com/item?id=32768454
[^4]: OWASP Coraza Caddy Module. https://github.com/corazawaf/coraza-caddy
[^5]: OpenAppSec WAF Integration with NGINX Proxy Manager. https://www.openappsec.io/post/announcing-open-appsec-waf-integration-with-nginx-proxy-manager
[^6]: Caddy Zero-Trust TLS Everywhere (experiment). https://github.com/mohammed90/caddy-zero-trust-tls-everywhere
[^7]: caddy-l4: Layer 4 (TCP/UDP) app for Caddy. https://github.com/mholt/caddy-l4
[^8]: caddy-ingress-controller v1.3.0 on Artifact Hub. https://artifacthub.io/packages/helm/caddy-ingress/caddy-ingress-controller
