package config

import "os"

type Config struct {
	Port        string
	DatabaseURL string
	RedisAddr   string
	AIAgentURL  string
	ChatwootURL string
	KafkaBrokers []string
}

func Load() *Config {
	return &Config{
		Port:         getEnv("PORT", "8082"),
		DatabaseURL:  getEnv("DATABASE_URL", "postgres://postgres:postgres@localhost:5432/whatsapp_commerce?sslmode=disable"),
		RedisAddr:    getEnv("REDIS_ADDR", "localhost:6379"),
		AIAgentURL:   getEnv("AI_AGENT_URL", "http://localhost:8090"),
		ChatwootURL:  getEnv("CHATWOOT_URL", "http://localhost:3000"),
		KafkaBrokers: []string{getEnv("KAFKA_BROKERS", "localhost:9092")},
	}
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

