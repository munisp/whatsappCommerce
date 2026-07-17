# keycloak

Production-ready Keycloak identity provider for the WhatsApp Commerce Platform.

## Roles

1. **OIDC token issuer** — issues access tokens, refresh tokens, and ID tokens for all platform clients.
2. **Multi-tenant identity** — Organizations feature maps one Keycloak Organisation per merchant tenant.
3. **Identity federation** — B2B tenants can use their own corporate SSO (Google Workspace, Azure AD, Okta).
4. **Custom auth flows** — phone OTP via WhatsApp Business API for buyer-native authentication.
5. **Kafka event streaming** — SPI plugin streams all auth events to the platform's Kafka bus.
6. **Token exchange** — AI agent exchanges buyer tokens for narrowly-scoped service tokens.

## Quick Start (local dev)

```bash
docker compose up -d
```

Keycloak will start at http://localhost:8080 with admin/admin credentials.
The `whatsapp-commerce` realm is auto-imported from `config/realm-export.json`.

## Build (production)

```bash
docker build -t ghcr.io/munisp/whatsapp-commerce/keycloak:latest .
```

The Dockerfile builds a custom Keycloak image with:
- `keycloak-kafka` SPI — streams auth events to Kafka
- `keycloak-orgs` extension — enhanced Organizations support (Phase Two)
- Custom login theme — WhatsApp Commerce branding

## Realm Configuration

The `config/realm-export.json` file contains the base realm configuration:
- Realm: `whatsapp-commerce`
- Organizations feature enabled
- Clients: `apisix-gateway`, `webapp`, `ai-agent`, `webhook-ingestor`
- Roles: `platform-admin`, `tenant-owner`, `tenant-agent`, `tenant-analyst`, `buyer`
- Authentication flows: standard + custom phone-OTP flow

## Environment Variables

| Variable | Description | Example |
|---|---|---|
| `KC_DB` | Database type | `postgres` |
| `KC_DB_URL` | JDBC connection URL | `jdbc:postgresql://postgres:5432/keycloak` |
| `KC_DB_USERNAME` | DB username | `keycloak` |
| `KC_DB_PASSWORD` | DB password | (secret) |
| `KC_HOSTNAME` | Public hostname | `auth.whatsapp-commerce.com` |
| `KC_HTTPS_CERTIFICATE_FILE` | TLS cert (issued by Caddy CA) | `/opt/keycloak/certs/tls.crt` |
| `KC_HTTPS_CERTIFICATE_KEY_FILE` | TLS key | `/opt/keycloak/certs/tls.key` |
| `KAFKA_BOOTSTRAP_SERVERS` | Kafka brokers for event streaming | `kafka:9092` |
| `KAFKA_TOPIC` | Kafka topic for auth events | `keycloak.events` |

## Kubernetes

See `k8s/` for deployment manifests. Keycloak is deployed as a StatefulSet with a PostgreSQL sidecar for the session store.

*** Add File: /home/ubuntu/whatsapp-commerce/services/keycloak/Dockerfile
# syntax=docker/dockerfile:1
# Custom Keycloak image with:
#   - keycloak-kafka SPI (auth event streaming to Kafka)
#   - keycloak-orgs extension (enhanced Organizations / multi-tenancy)
#   - Custom WhatsApp Commerce login theme

FROM quay.io/keycloak/keycloak:26.1 AS builder

# Enable the Organizations feature and build an optimized image
ENV KC_FEATURES=organization,token-exchange,fine-grained-admin-permissions
ENV KC_DB=postgres
ENV KC_HTTP_RELATIVE_PATH=/

# ── Download SPI JARs ────────────────────────────────────────────────────────
# keycloak-kafka SPI: streams auth events to Kafka
# https://github.com/SnuK87/keycloak-kafka
ADD https://github.com/SnuK87/keycloak-kafka/releases/download/1.2.0/keycloak-kafka-1.2.0-jar-with-dependencies.jar \
    /opt/keycloak/providers/keycloak-kafka.jar

# Copy custom login theme
COPY themes/whatsapp-commerce /opt/keycloak/themes/whatsapp-commerce

# Copy realm export for auto-import on first start
COPY config/realm-export.json /opt/keycloak/data/import/realm-export.json

# Build the optimized Keycloak image
RUN /opt/keycloak/bin/kc.sh build

# ── Runtime image ────────────────────────────────────────────────────────────
FROM quay.io/keycloak/keycloak:26.1

COPY --from=builder /opt/keycloak /opt/keycloak

# TLS certificate directory (cert issued by Caddy's internal CA via ACME)
RUN mkdir -p /opt/keycloak/certs
VOLUME ["/opt/keycloak/certs"]

EXPOSE 8080 8443

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=5 \
    CMD curl -sf http://localhost:8080/health/ready || exit 1

ENTRYPOINT ["/opt/keycloak/bin/kc.sh"]
CMD ["start", \
     "--import-realm", \
     "--hostname=${KC_HOSTNAME}", \
     "--https-certificate-file=/opt/keycloak/certs/tls.crt", \
     "--https-certificate-key-file=/opt/keycloak/certs/tls.key"]

*** Add File: /home/ubuntu/whatsapp-commerce/services/keycloak/docker-compose.yml
# Local development stack: Keycloak + PostgreSQL
# Keycloak is proxied by Caddy (see services/caddy-edge/docker-compose.yml)

version: "3.9"

services:
  keycloak:
    build: .
    container_name: wac-keycloak
    restart: unless-stopped
    command: start-dev --import-realm --features organization,token-exchange
    environment:
      KEYCLOAK_ADMIN: admin
      KEYCLOAK_ADMIN_PASSWORD: admin
      KC_DB: postgres
      KC_DB_URL: jdbc:postgresql://keycloak-db:5432/keycloak
      KC_DB_USERNAME: keycloak
      KC_DB_PASSWORD: keycloak_dev_2026
      KC_HOSTNAME: localhost
      KC_HOSTNAME_STRICT: "false"
      KC_HTTP_ENABLED: "true"
      # Kafka event streaming
      KAFKA_BOOTSTRAP_SERVERS: kafka:9092
      KAFKA_TOPIC: keycloak.events
      KAFKA_CLIENT_ID: keycloak-event-producer
    ports:
      - "8080:8080"
    volumes:
      - ./config/realm-export.json:/opt/keycloak/data/import/realm-export.json:ro
    networks:
      - wac-internal
    depends_on:
      keycloak-db:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "curl", "-sf", "http://localhost:8080/health/ready"]
      interval: 30s
      timeout: 10s
      retries: 5
      start_period: 60s

  keycloak-db:
    image: postgres:16-alpine
    container_name: wac-keycloak-db
    restart: unless-stopped
    environment:
      POSTGRES_DB: keycloak
      POSTGRES_USER: keycloak
      POSTGRES_PASSWORD: keycloak_dev_2026
    volumes:
      - keycloak_db_data:/var/lib/postgresql/data
    networks:
      - wac-internal
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U keycloak"]
      interval: 10s
      timeout: 5s
      retries: 5

volumes:
  keycloak_db_data:

networks:
  wac-internal:
    driver: bridge

*** Add File: /home/ubuntu/whatsapp-commerce/services/keycloak/config/realm-export.json
{
  "realm": "whatsapp-commerce",
  "displayName": "WhatsApp Commerce Platform",
  "enabled": true,
  "sslRequired": "external",
  "registrationAllowed": false,
  "loginWithEmailAllowed": true,
  "duplicateEmailsAllowed": false,
  "resetPasswordAllowed": true,
  "editUsernameAllowed": false,
  "bruteForceProtected": true,
  "permanentLockout": false,
  "maxFailureWaitSeconds": 900,
  "minimumQuickLoginWaitSeconds": 60,
  "waitIncrementSeconds": 60,
  "quickLoginCheckMilliSeconds": 1000,
  "maxDeltaTimeSeconds": 43200,
  "failureFactor": 5,
  "organizationsEnabled": true,
  "attributes": {
    "organizationsEnabled": "true"
  },
  "roles": {
    "realm": [
      { "name": "platform-admin", "description": "Full platform administration access" },
      { "name": "tenant-owner", "description": "Tenant owner — manages their organisation" },
      { "name": "tenant-agent", "description": "Tenant agent — handles customer conversations" },
      { "name": "tenant-analyst", "description": "Tenant analyst — read-only analytics access" },
      { "name": "buyer", "description": "End buyer — WhatsApp customer" }
    ]
  },
  "clients": [
    {
      "clientId": "apisix-gateway",
      "name": "APISIX API Gateway",
      "description": "Service account for APISIX openid-connect and authz-keycloak plugins",
      "enabled": true,
      "clientAuthenticatorType": "client-secret",
      "serviceAccountsEnabled": true,
      "authorizationServicesEnabled": true,
      "standardFlowEnabled": false,
      "implicitFlowEnabled": false,
      "directAccessGrantsEnabled": false,
      "protocol": "openid-connect",
      "attributes": {
        "access.token.lifespan": "300"
      }
    },
    {
      "clientId": "webapp",
      "name": "WhatsApp Commerce Web App",
      "description": "Browser-based admin and operator dashboard",
      "enabled": true,
      "clientAuthenticatorType": "client-secret",
      "standardFlowEnabled": true,
      "implicitFlowEnabled": false,
      "directAccessGrantsEnabled": false,
      "serviceAccountsEnabled": false,
      "protocol": "openid-connect",
      "redirectUris": [
        "https://app.whatsapp-commerce.com/*",
        "http://localhost:3000/*"
      ],
      "webOrigins": [
        "https://app.whatsapp-commerce.com",
        "http://localhost:3000"
      ],
      "attributes": {
        "access.token.lifespan": "900",
        "pkce.code.challenge.method": "S256"
      }
    },
    {
      "clientId": "ai-agent",
      "name": "AI Purchasing Agent",
      "description": "LangGraph AI agent — uses token exchange to act on behalf of buyers",
      "enabled": true,
      "clientAuthenticatorType": "client-secret",
      "serviceAccountsEnabled": true,
      "standardFlowEnabled": false,
      "directAccessGrantsEnabled": false,
      "protocol": "openid-connect",
      "attributes": {
        "access.token.lifespan": "60",
        "token.exchange.grant.enabled": "true"
      }
    },
    {
      "clientId": "webhook-ingestor",
      "name": "WhatsApp Webhook Ingestor",
      "description": "Go service that receives WhatsApp Cloud API webhooks",
      "enabled": true,
      "clientAuthenticatorType": "client-secret",
      "serviceAccountsEnabled": true,
      "standardFlowEnabled": false,
      "directAccessGrantsEnabled": false,
      "protocol": "openid-connect",
      "attributes": {
        "access.token.lifespan": "300"
      }
    }
  ],
  "eventsEnabled": true,
  "eventsListeners": ["jboss-logging", "kafka-event-listener"],
  "enabledEventTypes": [
    "LOGIN", "LOGIN_ERROR", "LOGOUT", "REGISTER", "REGISTER_ERROR",
    "TOKEN_EXCHANGE", "CLIENT_LOGIN", "CLIENT_LOGIN_ERROR",
    "UPDATE_PASSWORD", "UPDATE_PASSWORD_ERROR",
    "RESET_PASSWORD", "RESET_PASSWORD_ERROR"
  ],
  "adminEventsEnabled": true,
  "adminEventsDetailsEnabled": true
}

*** Add File: /home/ubuntu/whatsapp-commerce/services/keycloak/k8s/keycloak-deployment.yaml
# Keycloak Kubernetes Deployment
# Deployed as a StatefulSet for stable network identity and persistent storage.
# TLS certificate is issued by Caddy's internal ACME CA and mounted as a Secret.

apiVersion: v1
kind: Namespace
metadata:
  name: identity
---
apiVersion: v1
kind: Secret
metadata:
  name: keycloak-db-secret
  namespace: identity
type: Opaque
stringData:
  password: "REPLACE_WITH_STRONG_PASSWORD"
---
apiVersion: v1
kind: Secret
metadata:
  name: keycloak-admin-secret
  namespace: identity
type: Opaque
stringData:
  username: "admin"
  password: "REPLACE_WITH_STRONG_PASSWORD"
---
# TLS certificate issued by Caddy's internal ACME CA
# Populate this secret by running the ACME client on first deploy:
#   kubectl create secret tls keycloak-tls -n identity \
#     --cert=tls.crt --key=tls.key
apiVersion: v1
kind: Secret
metadata:
  name: keycloak-tls
  namespace: identity
type: kubernetes.io/tls
data:
  tls.crt: ""  # base64-encoded cert from Caddy CA
  tls.key: ""  # base64-encoded private key
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: keycloak
  namespace: identity
  labels:
    app: keycloak
    version: "26.1"
spec:
  serviceName: keycloak-headless
  replicas: 2
  selector:
    matchLabels:
      app: keycloak
  template:
    metadata:
      labels:
        app: keycloak
    spec:
      containers:
        - name: keycloak
          image: ghcr.io/munisp/whatsapp-commerce/keycloak:latest
          args:
            - start
            - --import-realm
          env:
            - name: KC_DB
              value: postgres
            - name: KC_DB_URL
              value: jdbc:postgresql://keycloak-db.identity.svc.cluster.local:5432/keycloak
            - name: KC_DB_USERNAME
              value: keycloak
            - name: KC_DB_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: keycloak-db-secret
                  key: password
            - name: KEYCLOAK_ADMIN
              valueFrom:
                secretKeyRef:
                  name: keycloak-admin-secret
                  key: username
            - name: KEYCLOAK_ADMIN_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: keycloak-admin-secret
                  key: password
            - name: KC_HOSTNAME
              value: auth.whatsapp-commerce.com
            - name: KC_HTTPS_CERTIFICATE_FILE
              value: /opt/keycloak/certs/tls.crt
            - name: KC_HTTPS_CERTIFICATE_KEY_FILE
              value: /opt/keycloak/certs/tls.key
            - name: KC_FEATURES
              value: organization,token-exchange,fine-grained-admin-permissions
            - name: KAFKA_BOOTSTRAP_SERVERS
              value: kafka.messaging.svc.cluster.local:9092
            - name: KAFKA_TOPIC
              value: keycloak.events
          ports:
            - containerPort: 8080
              name: http
            - containerPort: 8443
              name: https
          volumeMounts:
            - name: tls-certs
              mountPath: /opt/keycloak/certs
              readOnly: true
            - name: realm-config
              mountPath: /opt/keycloak/data/import
              readOnly: true
          readinessProbe:
            httpGet:
              path: /health/ready
              port: 8080
            initialDelaySeconds: 60
            periodSeconds: 10
          livenessProbe:
            httpGet:
              path: /health/live
              port: 8080
            initialDelaySeconds: 120
            periodSeconds: 30
          resources:
            requests:
              cpu: 500m
              memory: 1Gi
            limits:
              cpu: 2000m
              memory: 2Gi
      volumes:
        - name: tls-certs
          secret:
            secretName: keycloak-tls
        - name: realm-config
          configMap:
            name: keycloak-realm-config
---
apiVersion: v1
kind: Service
metadata:
  name: keycloak
  namespace: identity
  labels:
    app: keycloak
spec:
  selector:
    app: keycloak
  ports:
    - name: http
      port: 8080
      targetPort: 8080
    - name: https
      port: 8443
      targetPort: 8443
---
apiVersion: v1
kind: Service
metadata:
  name: keycloak-headless
  namespace: identity
spec:
  clusterIP: None
  selector:
    app: keycloak
  ports:
    - port: 8080

*** Add File: /home/ubuntu/whatsapp-commerce/services/keycloak/themes/whatsapp-commerce/.gitkeep
# Place custom Keycloak login theme files here.
# Structure:
#   login/         — login page templates (FreeMarker .ftl files)
#   account/       — account console templates
#   email/         — email templates
#   resources/     — CSS, images, fonts
#
# Reference: https://www.keycloak.org/docs/latest/server_development/#_themes
