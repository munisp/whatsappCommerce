package config

import (
	"os"
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
}

type Config struct {
	Env          string
	Port         string
	JWTSecret    string
	AllowedOrigins []string
	Services     ServiceEndpoints
	Redis        RedisConfig
	Keycloak     KeycloakConfig
	APISIX       APISIXConfig
}

type KeycloakConfig struct {
	URL          string // e.g. http://keycloak:8080
	Realm        string // e.g. wacommerce
	ClientID     string
	ClientSecret string
	// Derived — set by Load()
	JWKSEndpoint    string
	IntrospectURL   string
}

type APISIXConfig struct {
	AdminURL string // e.g. http://apisix:9180
	AdminKey string
}


type RedisConfig struct {
	Addr     string
	Password string
	DB       int
}

func Load() *Config {
	keycloakURL  := getEnv("KEYCLOAK_URL", "http://keycloak:8080")
	keycloakRealm := getEnv("KEYCLOAK_REALM", "wacommerce")
	return &Config{
		Env:       getEnv("ENV", "development"),
		Port:      getEnv("PORT", "8080"),
		JWTSecret: getEnv("JWT_SECRET", "change-me-in-production"),
		AllowedOrigins: []string{
			getEnv("ALLOWED_ORIGIN", "http://localhost:3000"),
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
	}
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
