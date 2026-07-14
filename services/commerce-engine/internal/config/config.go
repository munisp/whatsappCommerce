package config

import "os"

type Config struct {
	Port                     string
	DatabaseURL              string
	RedisAddr                string
	OdooURL                  string
	PaymentOrchestratorURL   string
	KafkaBrokers             []string
}

func Load() *Config {
	return &Config{
		Port:                   getEnv("PORT", "8083"),
		DatabaseURL:            getEnv("DATABASE_URL", "postgres://postgres:postgres@localhost:5432/whatsapp_commerce?sslmode=disable"),
		RedisAddr:              getEnv("REDIS_ADDR", "localhost:6379"),
		OdooURL:                getEnv("ODOO_URL", "http://localhost:8069"),
		PaymentOrchestratorURL: getEnv("PAYMENT_ORCHESTRATOR_URL", "http://localhost:8084"),
		KafkaBrokers:           []string{getEnv("KAFKA_BROKERS", "localhost:9092")},
	}
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

