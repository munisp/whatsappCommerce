package config

import (
"os"
"strconv"
)

type ServiceEndpoints struct {
WebhookIngestor          string
ConversationOrchestrator string
CommerceEngine           string
PaymentOrchestrator      string
CRMAdapter               string
ERPAdapter               string
NotificationService      string
AIAgent                  string
Gateway                  string
MLStack                  string
Platform                 string
}

type Config struct {
Env            string
Port           string
JWTSecret      string
AllowedOrigins []string
Services       ServiceEndpoints
Redis          RedisConfig
Keycloak       KeycloakConfig
APISIX         APISIXConfig
Permify        PermifyConfig
Fluvio         FluvioConfig
OpenAppSec     OpenAppSecCfg
Temporal       TemporalConfig
Dapr           DaprConfig
}

type KeycloakConfig struct {
URL           string
Realm         string
ClientID      string
ClientSecret  string
JWKSEndpoint  string
IntrospectURL string
}

type APISIXConfig struct {
AdminURL string
AdminKey string
}

type PermifyConfig struct {
URL      string
TenantID string
APIKey   string
}

type FluvioConfig struct {
Endpoint string
APIKey   string
}

type OpenAppSecCfg struct {
Enabled        bool
SharedSecret   string
PlatformAPIURL string
PlatformAPIKey string
}

type TemporalConfig struct {
Address   string
Namespace string
TaskQueue string
}

type DaprConfig struct {
HTTPPort int
AppID    string
}

type RedisConfig struct {
Addr     string
Password string
DB       int
}

func Load() *Config {
keycloakURL := getEnv("KEYCLOAK_URL", "http://keycloak:8080")
keycloakRealm := getEnv("KEYCLOAK_REALM", "wacommerce")
platformURL := getEnv("PLATFORM_API_URL", "http://localhost:3000")

return &Config{
Env:       getEnv("ENV", "development"),
Port:      getEnv("PORT", "8080"),
JWTSecret: getEnv("JWT_SECRET", "change-me-in-production"),
AllowedOrigins: []string{
getEnv("ALLOWED_ORIGIN", "http://localhost:3000"),
getEnv("ALLOWED_ORIGIN_2", ""),
},
Services: ServiceEndpoints{
WebhookIngestor:          getEnv("WEBHOOK_INGESTOR_URL", "http://localhost:8081"),
ConversationOrchestrator: getEnv("CONVERSATION_ORCHESTRATOR_URL", "http://localhost:8082"),
CommerceEngine:           getEnv("COMMERCE_ENGINE_URL", "http://localhost:8083"),
PaymentOrchestrator:      getEnv("PAYMENT_ORCHESTRATOR_URL", "http://localhost:8084"),
CRMAdapter:               getEnv("CRM_ADAPTER_URL", "http://localhost:8085"),
ERPAdapter:               getEnv("ERP_ADAPTER_URL", "http://localhost:8086"),
NotificationService:      getEnv("NOTIFICATION_SERVICE_URL", "http://localhost:8087"),
AIAgent:                  getEnv("AI_AGENT_URL", "http://localhost:8090"),
Gateway:                  getEnv("GATEWAY_SELF_URL", "http://localhost:8080"),
MLStack:                  getEnv("ML_STACK_URL", "http://localhost:8099"),
Platform:                 getEnv("PLATFORM_URL", platformURL),
},
Redis: RedisConfig{
Addr:     getEnv("REDIS_ADDR", "localhost:6379"),
Password: getEnv("REDIS_PASSWORD", ""),
DB:       0,
},
Keycloak: KeycloakConfig{
URL:           keycloakURL,
Realm:         keycloakRealm,
ClientID:      getEnv("KEYCLOAK_CLIENT_ID", "wacommerce-app"),
ClientSecret:  getEnv("KEYCLOAK_CLIENT_SECRET", ""),
JWKSEndpoint:  keycloakURL + "/realms/" + keycloakRealm + "/protocol/openid-connect/certs",
IntrospectURL: keycloakURL + "/realms/" + keycloakRealm + "/protocol/openid-connect/token/introspect",
},
APISIX: APISIXConfig{
AdminURL: getEnv("APISIX_ADMIN_URL", "http://apisix:9180"),
AdminKey: getEnv("APISIX_ADMIN_KEY", ""),
},
Permify: PermifyConfig{
URL:      getEnv("PERMIFY_URL", "http://permify:3476"),
TenantID: getEnv("PERMIFY_TENANT_ID", "t1"),
APIKey:   getEnv("PERMIFY_API_KEY", ""),
},
Fluvio: FluvioConfig{
Endpoint: getEnv("FLUVIO_ENDPOINT", ""),
APIKey:   getEnv("FLUVIO_API_KEY", ""),
},
OpenAppSec: OpenAppSecCfg{
Enabled:        getEnv("OPENAPPSEC_ENABLED", "true") != "false",
SharedSecret:   getEnv("OPENAPPSEC_SHARED_SECRET", ""),
PlatformAPIURL: platformURL,
PlatformAPIKey: getEnv("PLATFORM_API_KEY", ""),
},
Temporal: TemporalConfig{
Address:   getEnv("TEMPORAL_ADDRESS", ""),
Namespace: getEnv("TEMPORAL_NAMESPACE", "default"),
TaskQueue: getEnv("TEMPORAL_TASK_QUEUE", "whatsapp-commerce"),
},
Dapr: DaprConfig{
HTTPPort: getEnvInt("DAPR_HTTP_PORT", 3500),
AppID:    getEnv("DAPR_APP_ID", "wacommerce-gateway"),
},
}
}

func getEnv(key, fallback string) string {
if v := os.Getenv(key); v != "" {
return v
}
return fallback
}

func getEnvInt(key string, fallback int) int {
if v := os.Getenv(key); v != "" {
if i, err := strconv.Atoi(v); err == nil {
return i
}
}
return fallback
}
