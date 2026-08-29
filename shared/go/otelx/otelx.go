// Package otelx is a tiny, fail-open OpenTelemetry helper shared by the
// whatsapp-commerce Go services (W35). Telemetry is strictly opt-in: unless
// OTEL_ENABLED=true, Init is a no-op and every helper degrades to standard
// library behaviour. Init errors never crash a service — they log and
// continue uninstrumented, with Status() honestly reporting enabled=false.
//
// Environment (safe defaults, telemetry disabled by default):
//   OTEL_ENABLED                 "true" to enable (default: disabled)
//   OTEL_EXPORTER_OTLP_ENDPOINT  default "http://otel-collector:4318"
//   OTEL_SERVICE_NAME            overrides the serviceName arg when set
//   DEPLOYMENT_ENVIRONMENT       resource attribute (default "development")
package otelx

import (
	"context"
	"log"
	"net/http"
	"os"
	"sync/atomic"

	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetrichttp"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/resource"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
)

var enabled atomic.Bool

type ctxKey string

const tenantCtxKey ctxKey = "otelx.tenant_id"

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// Init initialises the OTel SDK when OTEL_ENABLED=true and returns a shutdown
// function plus an honest enabled flag. When disabled, or when any exporter
// fails to build, it returns a no-op shutdown and false (fail-open).
func Init(ctx context.Context, serviceName string) (shutdown func(context.Context) error, enabled bool) {
	noop := func(context.Context) error { return nil }
	if envOr("OTEL_ENABLED", "false") != "true" {
		otelxEnabledStore(false)
		return noop, false
	}

	name := envOr("OTEL_SERVICE_NAME", serviceName)
	endpoint := envOr("OTEL_EXPORTER_OTLP_ENDPOINT", "http://otel-collector:4318")

	res, err := resource.New(ctx,
		resource.WithAttributes(
			attribute.String("service.name", name),
			attribute.String("service.namespace", "whatsappcommerce"),
			attribute.String("deployment.environment", envOr("DEPLOYMENT_ENVIRONMENT", "development")),
		),
	)
	if err != nil {
		log.Printf("otelx: resource build failed (%v); continuing uninstrumented", err)
		otelxEnabledStore(false)
		return noop, false
	}

	traceExp, err := otlptracehttp.New(ctx, otlptracehttp.WithEndpointURL(endpoint))
	if err != nil {
		log.Printf("otelx: trace exporter build failed (%v); continuing uninstrumented", err)
		otelxEnabledStore(false)
		return noop, false
	}
	tp := sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(traceExp),
		sdktrace.WithResource(res),
	)

	metricExp, err := otlpmetrichttp.New(ctx, otlpmetrichttp.WithEndpointURL(endpoint))
	if err != nil {
		log.Printf("otelx: metric exporter build failed (%v); traces only", err)
	}

	// W3C tracecontext + baggage propagation, globally.
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
		propagation.TraceContext{},
		propagation.Baggage{},
	))
	otel.SetTracerProvider(tp)

	var mp *sdkmetric.MeterProvider
	if metricExp != nil {
		mp = sdkmetric.NewMeterProvider(
			sdkmetric.WithReader(sdkmetric.NewPeriodicReader(metricExp)),
			sdkmetric.WithResource(res),
		)
		otel.SetMeterProvider(mp)
	}

	otelxEnabledStore(true)
	return func(ctx context.Context) error {
		var firstErr error
		if mp != nil {
			firstErr = mp.Shutdown(ctx)
		}
		if err := tp.Shutdown(ctx); firstErr == nil {
			firstErr = err
		}
		return firstErr
	}, true
}

func otelxEnabledStore(v bool) { enabled.Store(v) }

// Status reports whether OTel was successfully initialised. Exposed so health
// endpoints can report honest telemetry status.
func Status() bool { return enabled.Load() }

// Middleware wraps an http.Handler with otelhttp server instrumentation
// (which extracts inbound W3C traceparent via the global propagator) and
// stashes the x-tenant-id header (when present) into the request context so
// TenantAttr can attach it to child spans. When OTel is disabled this is a
// cheap pass-through.
func Middleware(serviceName string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		h := otelhttp.NewHandler(next, serviceName,
			otelhttp.WithSpanNameFormatter(func(_ string, r *http.Request) string {
				return serviceName + " " + r.Method + " " + r.URL.Path
			}),
		)
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if tid := r.Header.Get("x-tenant-id"); tid != "" {
				r = r.WithContext(context.WithValue(r.Context(), tenantCtxKey, tid))
			}
			h.ServeHTTP(w, r)
		})
	}
}

// TenantAttr returns attribute tenant.id ONLY when a tenant id is present in
// the request context (stashed by Middleware from the x-tenant-id header).
// It never invents a tenant id; the zero KeyValue is returned when absent.
func TenantAttr(ctx context.Context) attribute.KeyValue {
	if tid, ok := ctx.Value(tenantCtxKey).(string); ok && tid != "" {
		return attribute.String("tenant.id", tid)
	}
	return attribute.KeyValue{}
}

// Err records err on the current span (if any) and marks it as an error.
// No-op when there is no active span or err is nil (fail-open).
func Err(ctx context.Context, err error) {
	if err == nil {
		return
	}
	span := trace.SpanFromContext(ctx)
	span.RecordError(err)
	span.SetStatus(codes.Error, err.Error())
}
