package config

import "os"

type Config struct {
	Port         string
	DatabaseURL  string
	KafkaBrokers []string
	RedisAddr    string
}

func Load() *Config {
	return &Config{
		Port:         getEnv("PORT", "8081"),
		DatabaseURL:  getEnv("DATABASE_URL", "postgres://postgres:postgres@localhost:5432/whatsapp_commerce?sslmode=disable"),
		KafkaBrokers: []string{getEnv("KAFKA_BROKERS", "localhost:9092")},
		RedisAddr:    getEnv("REDIS_ADDR", "localhost:6379"),
	}
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

