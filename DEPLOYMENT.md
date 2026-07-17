# WhatsApp Commerce Platform — Production Deployment Runbook

This document describes the step-by-step process for deploying the WhatsApp Commerce Platform
to a production Kubernetes cluster. It covers all four deployment phases.

---

## Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| Kubernetes | 1.29+ | GKE, EKS, AKS, or bare-metal |
| Helm | 3.14+ | For APISIX and Keycloak charts |
| kubectl | 1.29+ | Configured for target cluster |
| Docker | 24+ | For building custom images |
| Java | 21+ | For building Keycloak SPI JAR |
| Maven | 3.9+ | For building Keycloak SPI JAR |
| PostgreSQL | 15+ | Managed (Cloud SQL / RDS / Supabase) |
| Redis | 7+ | Managed (Upstash / ElastiCache) |

---

## Phase 1 — Caddy Edge TLS in Front of APISIX

**Goal:** Replace direct APISIX exposure with Caddy as the TLS-terminating edge proxy.
Caddy provides automatic Let's Encrypt certificates, HTTP/3, and Coraza WAF.

### Step 1.1 — Build the Caddy edge image

```bash
cd services/caddy-edge
docker build -t ghcr.io/munisp/whatsapp-commerce/caddy-edge:latest .
docker push ghcr.io/munisp/whatsapp-commerce/caddy-edge:latest
```

### Step 1.2 — Generate internal mTLS certificates

```bash
chmod +x services/caddy-edge/scripts/generate-certs.sh
./services/caddy-edge/scripts/generate-certs.sh
# Outputs: certs/ca.crt, certs/apisix.crt, certs/apisix.key
```

### Step 1.3 — Create Kubernetes secrets

```bash
kubectl create namespace whatsapp-commerce

kubectl create secret tls caddy-internal-ca \
  --cert=certs/ca.crt \
  --key=certs/ca.key \
  -n whatsapp-commerce

kubectl create secret tls apisix-mtls-cert \
  --cert=certs/apisix.crt \
  --key=certs/apisix.key \
  -n whatsapp-commerce

kubectl create secret generic caddy-env \
  --from-literal=DOMAIN=whatsapp-commerce.com \
  --from-literal=ACME_EMAIL=ops@whatsapp-commerce.com \
  -n whatsapp-commerce
```

### Step 1.4 — Deploy Caddy to Kubernetes

```bash
kubectl apply -f services/caddy-edge/k8s/caddy-deployment.yaml
kubectl rollout status deployment/caddy-edge -n whatsapp-commerce
```

### Step 1.5 — Verify Caddy is serving TLS

```bash
curl -I https://api.whatsapp-commerce.com/api/health
# Expected: HTTP/2 200, x-caddy-version header present
```

### Step 1.6 — Verify Coraza WAF is blocking attacks

```bash
curl -I "https://api.whatsapp-commerce.com/api/health?id=<script>alert(1)</script>"
# Expected: HTTP/2 403 (Coraza blocks XSS)
```

---

## Phase 2 — Keycloak Organizations (Multi-Tenant SSO)

**Goal:** Deploy Keycloak with the WhatsApp OTP SPI and Organizations feature enabled.
Each merchant tenant gets an Organization in the `whatsapp-commerce` realm.

### Step 2.1 — Build the Keycloak SPI JAR

```bash
cd services/keycloak/keycloak-whatsapp-otp
mvn clean package -DskipTests
# Output: target/keycloak-whatsapp-otp-1.0.0.jar
cp target/keycloak-whatsapp-otp-1.0.0.jar ../providers/
```

### Step 2.2 — Build the custom Keycloak image

```bash
cd services/keycloak
docker build -t ghcr.io/munisp/whatsapp-commerce/keycloak:latest .
docker push ghcr.io/munisp/whatsapp-commerce/keycloak:latest
```

### Step 2.3 — Create Keycloak secrets

```bash
kubectl create secret generic keycloak-secrets \
  --from-literal=KC_DB_PASSWORD=<strong-password> \
  --from-literal=KC_ADMIN_PASSWORD=<admin-password> \
  --from-literal=WAC_WHATSAPP_TOKEN=<whatsapp-cloud-api-token> \
  --from-literal=WAC_WHATSAPP_PHONE_ID=<phone-number-id> \
  --from-literal=APISIX_CLIENT_SECRET=<apisix-client-secret> \
  --from-literal=AI_AGENT_CLIENT_SECRET=<ai-agent-secret> \
  --from-literal=WEBHOOK_CLIENT_SECRET=<webhook-secret> \
  -n whatsapp-commerce
```

### Step 2.4 — Deploy Keycloak

```bash
kubectl apply -f services/keycloak/k8s/keycloak-deployment.yaml
kubectl rollout status statefulset/keycloak -n whatsapp-commerce
```

### Step 2.5 — Import the realm

```bash
# Wait for Keycloak to be ready
kubectl wait --for=condition=ready pod -l app=keycloak -n whatsapp-commerce --timeout=300s

# Import realm via Keycloak admin CLI
kubectl exec -it keycloak-0 -n whatsapp-commerce -- \
  /opt/keycloak/bin/kcadm.sh config credentials \
    --server http://localhost:8080 \
    --realm master \
    --user admin \
    --password $KC_ADMIN_PASSWORD

kubectl cp services/keycloak/config/realm-export.json \
  whatsapp-commerce/keycloak-0:/tmp/realm-export.json

kubectl exec -it keycloak-0 -n whatsapp-commerce -- \
  /opt/keycloak/bin/kcadm.sh create realms \
    -f /tmp/realm-export.json
```

### Step 2.6 — Verify WhatsApp OTP auth flow

```bash
# Test the OTP flow via Keycloak's token endpoint
curl -X POST "https://auth.whatsapp-commerce.com/realms/whatsapp-commerce/protocol/openid-connect/auth" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "client_id=webapp&response_type=code&scope=openid&redirect_uri=https://app.whatsapp-commerce.com/callback"
# Expected: Redirect to Keycloak phone entry page
```

### Step 2.7 — Configure APISIX to use Keycloak OIDC

```bash
# Apply the Keycloak OIDC plugin config to APISIX
kubectl exec -it apisix-0 -n whatsapp-commerce -- \
  curl -X PUT http://localhost:9180/apisix/admin/plugin_configs/keycloak-oidc \
    -H "X-API-KEY: $APISIX_ADMIN_KEY" \
    -d @services/middleware/apisix-config/keycloak-oidc-plugin.yaml
```

---

## Phase 3 — Caddy Internal PKI + Dapr mTLS Unification

**Goal:** Use Caddy's embedded ACME CA as the single certificate authority for all internal
service-to-service communication. Dapr sidecars request certs from Caddy's CA endpoint.

### Step 3.1 — Enable Caddy's internal PKI

The Caddyfile already includes the `pki` block. Verify it's running:

```bash
curl http://caddy-admin:2019/pki/ca/local
# Expected: JSON with CA certificate and ID
```

### Step 3.2 — Configure Dapr to use Caddy CA

```bash
# Update Dapr control plane to use Caddy as the cert issuer
kubectl patch daprcontrolplane dapr-control-plane -n dapr-system \
  --type=merge \
  -p '{"spec":{"mtls":{"workloadCertTTL":"24h","allowedClockSkew":"15m"}}}'

# Mount Caddy CA cert into Dapr sentry
kubectl create secret generic caddy-ca-cert \
  --from-file=ca.crt=certs/ca.crt \
  -n dapr-system
```

### Step 3.3 — Verify mTLS between services

```bash
# Check Dapr sidecar logs for successful cert issuance
kubectl logs -l app=webapp -c daprd -n whatsapp-commerce | grep "cert"
# Expected: "certificate renewed" log entries
```

---

## Phase 4 — Keycloak Kafka SPI + Phone OTP Auth Flow

**Goal:** Enable the Keycloak Kafka event listener SPI so all auth events (login, logout,
token refresh, failed login) are published to Kafka for the audit log and fraud detection pipeline.

### Step 4.1 — Verify Kafka SPI is loaded

```bash
kubectl exec -it keycloak-0 -n whatsapp-commerce -- \
  /opt/keycloak/bin/kcadm.sh get events/config \
    --server http://localhost:8080 \
    --realm whatsapp-commerce
# Expected: "eventsListeners": ["jboss-logging", "keycloak-to-kafka"]
```

### Step 4.2 — Verify WhatsApp OTP events in Kafka

```bash
kubectl exec -it kafka-0 -n whatsapp-commerce -- \
  kafka-console-consumer.sh \
    --bootstrap-server localhost:9092 \
    --topic keycloak-events \
    --from-beginning \
    --max-messages 5
# Expected: JSON auth events including LOGIN, LOGIN_ERROR
```

### Step 4.3 — Register heartbeat jobs

```bash
manus-heartbeat create \
  --name hermes-health-snapshot \
  --cron "0 */5 * * * *" \
  --path /api/scheduled/hermes-health-snapshot

manus-heartbeat create \
  --name inventory-sync \
  --cron "0 */5 * * * *" \
  --path /api/scheduled/inventory-sync
```

### Step 4.4 — Final smoke test

```bash
# Run the full integration test suite against production
PLATFORM_URL=https://api.whatsapp-commerce.com \
  pnpm test:integration

# Expected: All integration tests pass
```

---

## Environment Variables Reference

| Variable | Required | Description |
|---|---|---|
| `DOMAIN` | Yes | Primary domain (e.g. `whatsapp-commerce.com`) |
| `ACME_EMAIL` | Yes | Email for Let's Encrypt notifications |
| `WAC_WHATSAPP_TOKEN` | Yes | WhatsApp Cloud API access token |
| `WAC_WHATSAPP_PHONE_ID` | Yes | WhatsApp Business phone number ID |
| `APISIX_CLIENT_SECRET` | Yes | APISIX OAuth client secret in Keycloak |
| `AI_AGENT_CLIENT_SECRET` | Yes | Hermes AI agent client secret |
| `WEBHOOK_CLIENT_SECRET` | Yes | Webhook ingestor client secret |
| `KC_DB_PASSWORD` | Yes | Keycloak PostgreSQL password |
| `KC_ADMIN_PASSWORD` | Yes | Keycloak admin console password |
| `REDIS_URL` | Yes | Redis connection URL for OTP store |
| `POSTGRES_URL` | Yes | Platform PostgreSQL connection URL |
| `JWT_SECRET` | Yes | Platform JWT signing secret |

---

## Rollback Procedures

### Rollback Caddy edge

```bash
kubectl rollout undo deployment/caddy-edge -n whatsapp-commerce
# APISIX will continue serving on port 9080 directly
```

### Rollback Keycloak

```bash
kubectl rollout undo statefulset/keycloak -n whatsapp-commerce
# Platform falls back to Manus OAuth
```

### Emergency: Bypass Caddy

```bash
# Temporarily expose APISIX directly
kubectl patch service apisix -n whatsapp-commerce \
  --type=merge \
  -p '{"spec":{"type":"LoadBalancer"}}'
```
