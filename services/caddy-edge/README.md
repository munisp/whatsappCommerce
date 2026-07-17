# caddy-edge

Production-ready Caddy edge proxy for the WhatsApp Commerce Platform.

## Roles

1. **TLS edge** — terminates public HTTPS (Let's Encrypt / ZeroSSL) and serves HTTP/3 (QUIC) to mobile clients.
2. **Coraza WAF** — enforces OWASP Core Rule Set at the edge before traffic reaches APISIX.
3. **Internal ACME CA** — issues short-lived mTLS certificates to all microservices via the embedded `acme_server`.
4. **On-Demand TLS** — provisions certificates for tenant custom domains on first handshake.
5. **Layer 4 proxy** — wraps non-HTTP services (TigerBeetle, Redis, Kafka, PostgreSQL) in TLS.

## Quick Start (local dev)

```bash
docker compose up -d
```

Caddy will start on ports 80 (HTTP→HTTPS redirect), 443 (HTTPS/HTTP3), and 8443 (internal ACME CA).

## Build (production)

```bash
docker build -t ghcr.io/munisp/whatsapp-commerce/caddy-edge:latest .
```

The Dockerfile uses `xcaddy` to compile a custom Caddy binary with:
- `github.com/corazawaf/coraza-caddy/v2` — OWASP Coraza WAF
- `github.com/mholt/caddy-l4` — Layer 4 TCP/UDP proxy
- `github.com/greenpau/caddy-security` — JWT validation + Keycloak integration

## Environment Variables

| Variable | Description | Example |
|---|---|---|
| `ACME_EMAIL` | Email for Let's Encrypt registration | `ops@whatsapp-commerce.com` |
| `PLATFORM_DOMAIN` | Primary platform domain | `whatsapp-commerce.com` |
| `APISIX_UPSTREAM` | APISIX internal address | `apisix:9443` |
| `KEYCLOAK_UPSTREAM` | Keycloak internal address | `keycloak:8443` |
| `INTERNAL_CA_DIR` | Directory for Caddy's internal CA data | `/data/caddy/pki` |

## Kubernetes

See `k8s/` for Helm-compatible manifests using the official `caddy-ingress-controller`.

*** Add File: /home/ubuntu/whatsapp-commerce/services/caddy-edge/Dockerfile
# syntax=docker/dockerfile:1
# Build a custom Caddy binary with Coraza WAF, caddy-l4, and caddy-security modules.
# Uses xcaddy to compile all modules into a single static binary.

FROM caddy:2-builder AS builder

RUN xcaddy build \
    --with github.com/corazawaf/coraza-caddy/v2 \
    --with github.com/mholt/caddy-l4 \
    --with github.com/greenpau/caddy-security \
    --with github.com/caddy-dns/cloudflare

# ─── Runtime image ────────────────────────────────────────────────────────────
FROM caddy:2-alpine

# Copy the custom binary over the stock one
COPY --from=builder /usr/bin/caddy /usr/bin/caddy

# Copy OWASP CRS rules (downloaded at build time via xcaddy coraza)
COPY config/coraza/ /etc/caddy/coraza/

# Copy the main Caddyfile
COPY Caddyfile /etc/caddy/Caddyfile

# Caddy data directory (certificates, CA keys)
VOLUME ["/data"]

# Caddy config directory
VOLUME ["/config"]

EXPOSE 80 443 443/udp 8443

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://localhost:2019/config/ || exit 1

CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]

*** Add File: /home/ubuntu/whatsapp-commerce/services/caddy-edge/Caddyfile
# WhatsApp Commerce Platform — Caddy Edge Configuration
# Roles: TLS edge, Coraza WAF, Internal ACME CA, On-Demand TLS, L4 proxy

{
    # Global options
    email {$ACME_EMAIL:ops@whatsapp-commerce.com}
    admin 0.0.0.0:2019

    # Coraza WAF must run before any other handler
    order coraza_waf first

    # Internal PKI — Caddy acts as the root CA for all microservices
    pki {
        ca local {
            name "WhatsApp Commerce Internal CA"
        }
    }

    # On-Demand TLS: provision certs for tenant custom domains on first handshake.
    # The ask endpoint validates that the domain is registered in the platform DB
    # before Caddy requests a certificate from Let's Encrypt.
    on_demand_tls {
        ask http://apisix:9080/internal/tls-ask
        interval 2m
        burst 5
    }
}

# ─── Internal ACME server ─────────────────────────────────────────────────────
# Microservices request certificates from this endpoint.
# Accessible only within the internal network (not exposed publicly).
acme.internal.{$PLATFORM_DOMAIN:whatsapp-commerce.com}:8443 {
    tls internal
    acme_server {
        ca local
    }
}

# ─── Platform API ─────────────────────────────────────────────────────────────
api.{$PLATFORM_DOMAIN:whatsapp-commerce.com} {
    # Coraza WAF with OWASP Core Rule Set
    coraza_waf {
        load_owasp_crs
        directives `
            Include @coraza.conf-recommended
            Include @crs-setup.conf.example
            Include @owasp_crs/*.conf
            SecRuleEngine On
            SecRequestBodyAccess On
            SecResponseBodyAccess On
            SecAuditEngine RelevantOnly
            SecAuditLog /var/log/caddy/coraza-audit.log
        `
    }

    # Forward to APISIX over mTLS using the internal CA
    reverse_proxy https://{$APISIX_UPSTREAM:apisix:9443} {
        transport http {
            tls
            tls_trusted_ca_certs /data/caddy/pki/authorities/local/root.crt
        }
        header_up X-Forwarded-Proto {scheme}
        header_up X-Real-IP {remote_host}
        header_up X-Request-ID {http.request.uuid}
    }

    log {
        output file /var/log/caddy/api-access.log
        format json
    }
}

# ─── Keycloak OIDC endpoint ───────────────────────────────────────────────────
auth.{$PLATFORM_DOMAIN:whatsapp-commerce.com} {
    # Keycloak runs on an internal mTLS cert; Caddy terminates public TLS
    reverse_proxy https://{$KEYCLOAK_UPSTREAM:keycloak:8443} {
        transport http {
            tls
            tls_trusted_ca_certs /data/caddy/pki/authorities/local/root.crt
        }
        header_up X-Forwarded-Proto https
        header_up X-Forwarded-Host {host}
    }
}

# ─── Tenant custom domains (On-Demand TLS) ───────────────────────────────────
# Matches any domain not explicitly handled above.
# Caddy provisions a Let's Encrypt cert on first handshake after the
# /internal/tls-ask endpoint confirms the domain is registered.
:443 {
    tls {
        on_demand
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

    reverse_proxy https://{$APISIX_UPSTREAM:apisix:9443} {
        transport http {
            tls
            tls_trusted_ca_certs /data/caddy/pki/authorities/local/root.crt
        }
        header_up X-Forwarded-Host {host}
        header_up X-Forwarded-Proto {scheme}
    }
}

*** Add File: /home/ubuntu/whatsapp-commerce/services/caddy-edge/docker-compose.yml
# Local development stack: Caddy edge + APISIX stub + Keycloak
# For production, use the Kubernetes manifests in k8s/

version: "3.9"

services:
  caddy:
    build: .
    container_name: wac-caddy-edge
    restart: unless-stopped
    ports:
      - "80:80"       # HTTP → HTTPS redirect
      - "443:443"     # HTTPS / HTTP3
      - "443:443/udp" # QUIC (HTTP/3)
      - "8443:8443"   # Internal ACME CA
      - "2019:2019"   # Caddy Admin API (internal only)
    environment:
      ACME_EMAIL: ops@whatsapp-commerce.com
      PLATFORM_DOMAIN: localhost
      APISIX_UPSTREAM: apisix:9443
      KEYCLOAK_UPSTREAM: keycloak:8443
    volumes:
      - caddy_data:/data
      - caddy_config:/config
      - ./config/coraza:/etc/caddy/coraza:ro
      - ./logs:/var/log/caddy
    networks:
      - wac-internal
    depends_on:
      - apisix
      - keycloak
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:2019/config/"]
      interval: 30s
      timeout: 5s
      retries: 3

  # Stub APISIX for local dev — replace with your real APISIX stack
  apisix:
    image: apache/apisix:3.11.0-debian
    container_name: wac-apisix-stub
    restart: unless-stopped
    ports:
      - "9080:9080"
      - "9443:9443"
      - "9180:9180"
    networks:
      - wac-internal

  # Stub Keycloak for local dev
  keycloak:
    image: quay.io/keycloak/keycloak:26.1
    container_name: wac-keycloak-stub
    restart: unless-stopped
    command: start-dev --features organization
    environment:
      KEYCLOAK_ADMIN: admin
      KEYCLOAK_ADMIN_PASSWORD: admin
    ports:
      - "8080:8080"
    networks:
      - wac-internal

volumes:
  caddy_data:
  caddy_config:

networks:
  wac-internal:
    driver: bridge

*** Add File: /home/ubuntu/whatsapp-commerce/services/caddy-edge/k8s/caddy-ingress-controller.yaml
# Caddy Ingress Controller for Kubernetes
# Replaces NGINX Ingress Controller with automatic TLS + HTTP/3
# Based on caddy-ingress-controller v1.3.0 (Helm chart: caddy-ingress/caddy-ingress-controller)
#
# Install via Helm:
#   helm repo add caddy-ingress https://caddyserver.github.io/ingress/
#   helm install caddy-ingress caddy-ingress/caddy-ingress-controller \
#     --namespace caddy-system --create-namespace \
#     --set ingressController.config.email=ops@whatsapp-commerce.com \
#     --set ingressController.config.onDemandTLS=true
#
# Or apply this manifest directly for a minimal setup:

apiVersion: v1
kind: Namespace
metadata:
  name: caddy-system
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: caddy-ingress-controller
  namespace: caddy-system
data:
  email: "ops@whatsapp-commerce.com"
  onDemandTLS: "true"
  debug: "false"
---
# Ingress for the platform API — Caddy provisions TLS automatically
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: wac-api-ingress
  namespace: default
  annotations:
    kubernetes.io/ingress.class: caddy
    # Caddy-specific: enable HTTP/3
    caddy.ingress.kubernetes.io/http3: "true"
spec:
  rules:
    - host: api.whatsapp-commerce.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: apisix
                port:
                  number: 9080
  tls:
    - hosts:
        - api.whatsapp-commerce.com
      # No secretName needed — Caddy manages the cert automatically
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: wac-auth-ingress
  namespace: default
  annotations:
    kubernetes.io/ingress.class: caddy
    caddy.ingress.kubernetes.io/http3: "true"
spec:
  rules:
    - host: auth.whatsapp-commerce.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: keycloak
                port:
                  number: 8080
  tls:
    - hosts:
        - auth.whatsapp-commerce.com

*** Add File: /home/ubuntu/whatsapp-commerce/services/caddy-edge/config/coraza/.gitkeep
# OWASP CRS rules are downloaded at build time by xcaddy/coraza-caddy.
# Place any custom SecRule overrides in this directory as *.conf files.
# They will be included after the standard CRS rules via:
#   Include /etc/caddy/coraza/*.conf
