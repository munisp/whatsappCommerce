module github.com/whatsapp-commerce/event-gateway

go 1.23

// Production dependencies (add with: go get)
// github.com/segmentio/kafka-go v0.4.47
// github.com/redis/go-redis/v9 v9.7.0
// go.temporal.io/sdk v1.30.0

require github.com/segmentio/kafka-go v0.4.51

require (
	github.com/klauspost/compress v1.15.9 // indirect
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
