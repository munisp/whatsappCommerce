package config

import "os"

type Config struct {
	Port                     string
	DatabaseURL              string
	RedisAddr                string
	OdooURL                  string
	PaymentOrchestratorURL   string
	KafkaBrokers             []string
	// QA-038: shared service-to-service secret (X-Internal-Api-Key / X-Internal-Token / X-Api-Key), same
	// convention as gateway's InternalTokenAuth and server's internalProcedure. Every route here except
	// /health is internal-only (the only configured live caller is event-processor; gateway's own
	// COMMERCE_ENGINE_URL proxy routes are unconfigured in this deployment today).
	InternalAPIKey string
	Env            string
}

func Load() *Config {
	return &Config{
		Port:                   getEnv("PORT", "8083"),
		DatabaseURL:            getEnv("DATABASE_URL", "postgres://postgres:postgres@localhost:5432/whatsapp_commerce?sslmode=disable"),
		RedisAddr:              getEnv("REDIS_ADDR", "localhost:6379"),
		OdooURL:                getEnv("ODOO_URL", "http://localhost:8069"),
		PaymentOrchestratorURL: getEnv("PAYMENT_ORCHESTRATOR_URL", "http://localhost:8084"),
		KafkaBrokers:           []string{getEnv("KAFKA_BROKERS", "localhost:9092")},
		InternalAPIKey:         getEnv("INTERNAL_API_KEY", ""),
		Env:                    getEnv("ENV", ""),
	}
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

