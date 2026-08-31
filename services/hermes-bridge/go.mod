module github.com/whatsapp-commerce/hermes-bridge

go 1.23.4

require (
	github.com/go-chi/chi/v5 v5.2.1
	github.com/google/uuid v1.6.0
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
