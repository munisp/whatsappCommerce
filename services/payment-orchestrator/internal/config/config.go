package config

import "os"

type Config struct {
	Port              string
	DatabaseURL       string
	RedisAddr         string
	MojaloopURL       string
	MojaloopFSPID     string
	StripeSecretKey   string
	StripeSuccessURL  string
	StripeCancelURL   string
	PaystackSecretKey string
	FlutterwaveSecretKey string
	TigerBeetleURL    string
	LedgerBridgeURL   string
	CommerceEngineURL string
	// PlatformURL is the base URL of the TS platform server (used to emit
	// internal events such as refund requests to /api/internal/events).
	PlatformURL    string
	InternalAPIKey string
	// InternalToken authenticates every request to this service via the
	// X-Internal-Token header. Fail-closed outside development when unset.
	InternalToken string
	// Environment: "development" | "staging" | "production"
	Environment string
	KafkaBrokers []string
}

func Load() *Config {
	env := getEnv("APP_ENV", getEnv("ENVIRONMENT", "development"))
	return &Config{
		Port:              getEnv("PORT", "8084"),
		DatabaseURL:       getEnv("DATABASE_URL", "postgres://postgres:postgres@localhost:5432/whatsapp_commerce?sslmode=disable"),
		RedisAddr:         getEnv("REDIS_ADDR", "localhost:6379"),
		MojaloopURL:       getEnv("MOJALOOP_URL", "http://localhost:3001"),
		MojaloopFSPID:     getEnv("MOJALOOP_FSP_ID", "whatsapp-commerce-fsp"),
		StripeSecretKey:   getEnv("STRIPE_SECRET_KEY", ""),
		StripeSuccessURL:  getEnv("STRIPE_SUCCESS_URL", "https://localhost/pay/success"),
		StripeCancelURL:   getEnv("STRIPE_CANCEL_URL", "https://localhost/pay/cancel"),
		PaystackSecretKey: getEnv("PAYSTACK_SECRET_KEY", ""),
		FlutterwaveSecretKey: getEnv("FLW_SECRET_KEY", ""),
		TigerBeetleURL:    getEnv("TIGERBEETLE_URL", "http://localhost:3002"),
		LedgerBridgeURL:   getEnv("LEDGER_BRIDGE_URL", "http://localhost:8095"),
		CommerceEngineURL: getEnv("COMMERCE_ENGINE_URL", "http://localhost:8083"),
		PlatformURL:       getEnv("PLATFORM_URL", "http://localhost:3000"),
		InternalAPIKey:    getEnv("INTERNAL_API_KEY", ""),
		InternalToken:     getEnv("PAYMENT_ORCHESTRATOR_INTERNAL_TOKEN", ""),
		Environment:       env,
		KafkaBrokers:      []string{getEnv("KAFKA_BROKERS", "localhost:9092")},
	}
}

// IsDev reports whether the service runs in a non-production environment
// (development conveniences such as unauthenticated access are allowed,
// with loud warnings).
func (c *Config) IsDev() bool {
	return c.Environment != "production" && c.Environment != "staging"
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
