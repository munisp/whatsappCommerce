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
}

type RedisConfig struct {
	Addr     string
	Password string
	DB       int
}

func Load() *Config {
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
	}
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

