module github.com/whatsapp-commerce/hermes-bridge

go 1.23.4

require (
	github.com/go-chi/chi/v5 v5.2.1
	github.com/google/uuid v1.6.0
	// === W45 go-rust-services === (MSG-15 Redis approvals, MSG-20 real Kafka consumer)
	github.com/redis/go-redis/v9 v9.7.3
	github.com/segmentio/kafka-go v0.4.47
)

// === W45 go-rust-services === transitive deps of kafka-go / go-redis
require (
	github.com/cespare/xxhash/v2 v2.2.0 // indirect
	github.com/dgryski/go-rendezvous v0.0.0-20200823014737-9f7001d12a5f // indirect
	github.com/klauspost/compress v1.17.2 // indirect
	github.com/pierrec/lz4/v4 v4.1.15 // indirect
)

// === W35 otel ===
require (
	github.com/whatsapp-commerce/otelx v0.0.0
	go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp v0.62.0
	go.opentelemetry.io/otel v1.38.0
	go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetrichttp v1.38.0
	go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp v1.38.0
	go.opentelemetry.io/otel/metric v1.38.0
	go.opentelemetry.io/otel/sdk v1.38.0
)

replace github.com/whatsapp-commerce/otelx => ../../shared/go/otelx
// === END W35 otel ===
