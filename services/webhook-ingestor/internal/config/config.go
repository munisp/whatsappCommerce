package config

import "os"

type Config struct {
	Port         string
	Env          string
	DatabaseURL  string
	KafkaBrokers []string
	RedisAddr    string
	// Webhook signature secrets. When a secret is set, the corresponding
	// webhook handler requires a valid HMAC-SHA256 signature. In production
	// (ENV=production) an unset secret fails closed (all requests rejected).
	TwentyWebhookSecret    string
	OdooWebhookSecret      string
	MojaloopCallbackSecret string
}

func (c *Config) IsProduction() bool {
	return c.Env == "production"
}

func Load() *Config {
	return &Config{
		Port:         getEnv("PORT", "8081"),
		Env:          getEnv("ENV", getEnv("NODE_ENV", "development")),
		DatabaseURL:  getEnv("DATABASE_URL", "postgres://postgres:postgres@localhost:5432/whatsapp_commerce?sslmode=disable"),
		KafkaBrokers: []string{getEnv("KAFKA_BROKERS", "localhost:9092")},
		RedisAddr:    getEnv("REDIS_ADDR", "localhost:6379"),

		TwentyWebhookSecret:    os.Getenv("TWENTY_WEBHOOK_SECRET"),
		OdooWebhookSecret:      os.Getenv("ODOO_WEBHOOK_SECRET"),
		MojaloopCallbackSecret: os.Getenv("MOJALOOP_CALLBACK_SECRET"),
	}
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
