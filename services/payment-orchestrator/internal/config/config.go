package config

import "os"

type Config struct {
	Port              string
	DatabaseURL       string
	RedisAddr         string
	MojaloopURL       string
	MojaloopFSPID     string
	StripeSecretKey   string
	TigerBeetleURL    string
	LedgerBridgeURL   string
	CommerceEngineURL string
	KafkaBrokers      []string
}

func Load() *Config {
	return &Config{
		Port:              getEnv("PORT", "8084"),
		DatabaseURL:       getEnv("DATABASE_URL", "postgres://postgres:postgres@localhost:5432/whatsapp_commerce?sslmode=disable"),
		RedisAddr:         getEnv("REDIS_ADDR", "localhost:6379"),
		MojaloopURL:       getEnv("MOJALOOP_URL", "http://localhost:3001"),
		MojaloopFSPID:     getEnv("MOJALOOP_FSP_ID", "whatsapp-commerce-fsp"),
		StripeSecretKey:   getEnv("STRIPE_SECRET_KEY", ""),
		TigerBeetleURL:    getEnv("TIGERBEETLE_URL", "http://localhost:3002"),
		LedgerBridgeURL:   getEnv("LEDGER_BRIDGE_URL", "http://localhost:8095"),
		CommerceEngineURL: getEnv("COMMERCE_ENGINE_URL", "http://localhost:8083"),
		KafkaBrokers:      []string{getEnv("KAFKA_BROKERS", "localhost:9092")},
	}
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

