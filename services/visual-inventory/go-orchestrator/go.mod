module github.com/whatsapp-commerce/visual-inventory-orchestrator

go 1.23

// Production dependencies (add with: go get)
// github.com/gin-gonic/gin v1.10.0
// github.com/aws/aws-sdk-go-v2 v1.32.0
// github.com/aws/aws-sdk-go-v2/service/s3 v1.67.0
// github.com/google/uuid v1.6.0
// go.uber.org/zap v1.27.0
// github.com/disintegration/imaging v1.6.2

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

replace github.com/whatsapp-commerce/otelx => ../../../shared/go/otelx
// === END W35 otel ===
