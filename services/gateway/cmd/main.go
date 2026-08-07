package main

import (
"context"
"fmt"
"net/http"
"os"
"os/signal"
"syscall"
"time"

"github.com/gin-gonic/gin"
"github.com/whatsapp-commerce/gateway/internal/config"
"github.com/whatsapp-commerce/gateway/internal/fluvio"
"github.com/whatsapp-commerce/gateway/internal/middleware"
"github.com/whatsapp-commerce/gateway/internal/proxy"
"github.com/whatsapp-commerce/gateway/internal/ratelimit"
"go.uber.org/zap"
)

// fluvioEventHandler accepts {eventType, payload} from internal services and
// publishes it to the matching Fluvio topic. Returns 503 when Fluvio is not
// configured so callers never mistake a dropped event for a published one.
func fluvioEventHandler(p *fluvio.Producer, kind string) gin.HandlerFunc {
return func(c *gin.Context) {
if p == nil {
c.JSON(http.StatusServiceUnavailable, gin.H{
"error":   "fluvio_not_configured",
"message": "FLUVIO_ENDPOINT is not set; event cannot be published",
})
return
}
var body struct {
EventType string                 `json:"eventType" binding:"required"`
Payload   map[string]interface{} `json:"payload" binding:"required"`
}
if err := c.ShouldBindJSON(&body); err != nil {
c.JSON(http.StatusBadRequest, gin.H{"error": "invalid event body", "detail": err.Error()})
return
}
if kind == "order" {
p.PublishOrderEvent(c.Request.Context(), body.EventType, body.Payload)
} else {
p.PublishPaymentEvent(c.Request.Context(), body.EventType, body.Payload)
}
c.JSON(http.StatusAccepted, gin.H{"status": "accepted", "eventType": body.EventType})
}
}

// adminNotImplemented returns a clear 501 for admin control-plane endpoints
// that are owned by the platform server (tRPC) and must not be proxied to the
// gateway itself.
func adminNotImplemented(cfg *config.Config, feature string) gin.HandlerFunc {
return func(c *gin.Context) {
c.JSON(http.StatusNotImplemented, gin.H{
"error": "not_implemented",
"message": fmt.Sprintf(
"%s is served by the platform API (%s) via tRPC at /api/trpc; the gateway does not expose a REST proxy for this admin endpoint",
feature, cfg.Services.Platform,
),
"platformUrl": cfg.Services.Platform,
})
}
}

func main() {
cfg := config.Load()
logger, _ := zap.NewProduction()
defer logger.Sync()

if cfg.Env == "development" {
gin.SetMode(gin.DebugMode)
} else {
gin.SetMode(gin.ReleaseMode)
}

// Fluvio event producer — optional; enabled only when FLUVIO_ENDPOINT is set.
// In non-dev environments a configured-but-unreachable Fluvio endpoint is fatal:
// silently dropping order/payment events is not acceptable in production.
var eventProducer *fluvio.Producer
if cfg.Fluvio.Endpoint != "" {
eventProducer = fluvio.NewProducer(fluvio.Config{
Endpoint: cfg.Fluvio.Endpoint,
APIKey:   cfg.Fluvio.APIKey,
}, logger)
if ok, latencyMs := eventProducer.Health(); !ok {
if cfg.Env == "development" {
logger.Warn("fluvio.endpoint.unhealthy (dev mode — events will fail-open)",
zap.String("endpoint", cfg.Fluvio.Endpoint))
} else {
logger.Fatal("fluvio.endpoint.unhealthy",
zap.String("endpoint", cfg.Fluvio.Endpoint))
}
} else {
logger.Info("fluvio.producer.ready",
zap.String("endpoint", cfg.Fluvio.Endpoint),
zap.Int64("latency_ms", latencyMs))
}
}

// publishAfterSuccess wraps a proxied handler and publishes a Fluvio domain
// event when the upstream responds with a success status (<400). It is a no-op
// when Fluvio is not configured.
publishAfterSuccess := func(kind, eventType string, h gin.HandlerFunc) gin.HandlerFunc {
return func(c *gin.Context) {
h(c)
if eventProducer == nil || c.Writer.Status() >= 400 {
return
}
payload := map[string]interface{}{
"path":       c.Request.URL.Path,
"method":     c.Request.Method,
"tenantId":   c.GetString("tenant_id"),
"userId":     c.GetString("user_id"),
"requestId":  c.GetString("request_id"),
"statusCode": c.Writer.Status(),
}
for _, p := range c.Params {
payload[p.Key] = p.Value
}
go func() {
ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
defer cancel()
if kind == "order" {
eventProducer.PublishOrderEvent(ctx, eventType, payload)
} else {
eventProducer.PublishPaymentEvent(ctx, eventType, payload)
}
}()
}
}

r := gin.New()
r.Use(gin.Recovery())
r.Use(middleware.RequestID())
r.Use(middleware.Logger(logger))
r.Use(middleware.CORS(cfg))
r.Use(middleware.SecurityHeaders())
r.Use(middleware.TenantResolver(cfg))
r.Use(middleware.OpenAppSecStatusHeader(cfg.OpenAppSec.Enabled))
r.Use(ratelimit.Middleware(cfg))
r.Use(middleware.PermifyAuthz(cfg, logger))

r.GET("/health", func(c *gin.Context) {
c.JSON(http.StatusOK, gin.H{
"status": "ok", "service": "gateway",
"ts": time.Now().UTC(),
"middleware": gin.H{
"keycloak":   cfg.Keycloak.URL != "",
"permify":    cfg.Permify.URL != "",
"apisix":     cfg.APISIX.AdminKey != "",
"fluvio":     cfg.Fluvio.Endpoint != "",
"temporal":   cfg.Temporal.Address != "",
"openappsec": cfg.OpenAppSec.Enabled,
"dapr":       cfg.Dapr.HTTPPort > 0,
},
})
})
r.GET("/ready", func(c *gin.Context) {
c.JSON(http.StatusOK, gin.H{"status": "ready"})
})

// OpenAppSec WAF event ingestion (called by OpenAppSec agent sidecar)
r.POST("/internal/waf/events", middleware.OpenAppSecEventHandler(
middleware.OpenAppSecConfig{
Enabled:        cfg.OpenAppSec.Enabled,
SharedSecret:   cfg.OpenAppSec.SharedSecret,
PlatformAPIURL: cfg.OpenAppSec.PlatformAPIURL,
PlatformAPIKey: cfg.OpenAppSec.PlatformAPIKey,
},
logger,
))

// Internal event ingestion — services without a Fluvio client publish
// order/payment domain events through the gateway's producer.
events := r.Group("/internal/events")
{
events.POST("/orders", fluvioEventHandler(eventProducer, "order"))
events.POST("/payments", fluvioEventHandler(eventProducer, "payment"))
}

// Public webhooks (no auth)
webhooks := r.Group("/webhooks")
{
webhooks.POST("/chatwoot/:tenant_slug", proxy.ForwardTo(cfg.Services.WebhookIngestor))
webhooks.POST("/mojaloop/callback/:tenant_slug", proxy.ForwardTo(cfg.Services.PaymentOrchestrator))
webhooks.POST("/twenty/:tenant_slug", proxy.ForwardTo(cfg.Services.CRMAdapter))
webhooks.POST("/odoo/:tenant_slug", proxy.ForwardTo(cfg.Services.ERPAdapter))
webhooks.POST("/paystack", proxy.ForwardTo(cfg.Services.PaymentOrchestrator))
webhooks.POST("/flutterwave", proxy.ForwardTo(cfg.Services.PaymentOrchestrator))
webhooks.POST("/shipbubble", proxy.ForwardTo(cfg.Services.PaymentOrchestrator))
}

// Authenticated API — Keycloak JWT + Permify ReBAC
api := r.Group("/api/v1")
api.Use(middleware.JWTAuth(cfg))
{
// Conversations
api.GET("/conversations", middleware.RequirePermify("tenant", "view", ""), proxy.ForwardTo(cfg.Services.ConversationOrchestrator))
api.GET("/conversations/:id", middleware.RequirePermify("tenant", "view", ""), proxy.ForwardTo(cfg.Services.ConversationOrchestrator))
api.POST("/conversations/:id/message", middleware.RequirePermify("tenant", "view", ""), proxy.ForwardTo(cfg.Services.ConversationOrchestrator))
api.POST("/conversations/:id/handoff", middleware.RequirePermify("tenant", "view", ""), proxy.ForwardTo(cfg.Services.ConversationOrchestrator))
api.POST("/conversations/:id/resolve", middleware.RequirePermify("tenant", "view", ""), proxy.ForwardTo(cfg.Services.ConversationOrchestrator))

// Products
api.GET("/products", proxy.ForwardTo(cfg.Services.CommerceEngine))
api.GET("/products/:id", proxy.ForwardTo(cfg.Services.CommerceEngine))
api.GET("/products/search", proxy.ForwardTo(cfg.Services.CommerceEngine))
api.GET("/inventory/:sku", proxy.ForwardTo(cfg.Services.CommerceEngine))
api.POST("/products", middleware.RequirePermify("tenant", "edit", ""), proxy.ForwardTo(cfg.Services.CommerceEngine))
api.PUT("/products/:id", middleware.RequirePermify("tenant", "edit", ""), proxy.ForwardTo(cfg.Services.CommerceEngine))
api.DELETE("/products/:id", middleware.RequirePermify("tenant", "delete", ""), proxy.ForwardTo(cfg.Services.CommerceEngine))

// Cart & Checkout
api.POST("/carts", proxy.ForwardTo(cfg.Services.CommerceEngine))
api.GET("/carts/:id", proxy.ForwardTo(cfg.Services.CommerceEngine))
api.POST("/carts/:id/items", proxy.ForwardTo(cfg.Services.CommerceEngine))
api.DELETE("/carts/:id/items/:item_id", proxy.ForwardTo(cfg.Services.CommerceEngine))
api.POST("/carts/:id/checkout", publishAfterSuccess("order", "order.checkout", proxy.ForwardTo(cfg.Services.CommerceEngine)))

// Orders
api.GET("/orders", middleware.RequirePermify("tenant", "view", ""), proxy.ForwardTo(cfg.Services.CommerceEngine))
api.GET("/orders/:id", middleware.RequirePermify("order", "view", "id"), proxy.ForwardTo(cfg.Services.CommerceEngine))
api.POST("/orders/:id/cancel", middleware.RequirePermify("order", "cancel", "id"), publishAfterSuccess("order", "order.cancelled", proxy.ForwardTo(cfg.Services.CommerceEngine)))
api.POST("/orders/:id/confirm", middleware.RequirePermify("order", "fulfill", "id"), publishAfterSuccess("order", "order.confirmed", proxy.ForwardTo(cfg.Services.CommerceEngine)))

// Payments
api.POST("/payments/initiate", publishAfterSuccess("payment", "payment.initiated", proxy.ForwardTo(cfg.Services.PaymentOrchestrator)))
api.GET("/payments/:id/status", proxy.ForwardTo(cfg.Services.PaymentOrchestrator))
api.POST("/payments/:id/refund", middleware.RequirePermify("tenant", "edit", ""), publishAfterSuccess("payment", "payment.refunded", proxy.ForwardTo(cfg.Services.PaymentOrchestrator)))

// AI Agent — the upstream serves /intent, /recommend, /handoff-summary without
// the gateway prefix, so strip /api/v1/ai before forwarding.
api.POST("/ai/intent", proxy.ForwardToStripPrefix(cfg.Services.AIAgent, "/api/v1/ai"))
api.POST("/ai/recommend", proxy.ForwardToStripPrefix(cfg.Services.AIAgent, "/api/v1/ai"))
api.POST("/ai/handoff-summary", proxy.ForwardToStripPrefix(cfg.Services.AIAgent, "/api/v1/ai"))

// ML Stack (fraud detection, credit scoring)
api.POST("/ml/predict", proxy.ForwardTo(cfg.Services.MLStack))
api.GET("/ml/health", proxy.ForwardTo(cfg.Services.MLStack))

// Admin (admin role + Permify system:manage)
admin := api.Group("/admin")
admin.Use(middleware.RequireRole("admin", "platform_engineer"))
admin.Use(middleware.RequirePermify("system", "manage", ""))
{
// Admin control-plane data (tenants, temporal workflows, fluvio topics, …)
// lives in the platform server's tRPC API, not behind REST endpoints the
// gateway can proxy to. Return 501 with a pointer instead of looping to self.
admin.GET("/tenants", adminNotImplemented(cfg, "tenant administration"))
admin.POST("/tenants", adminNotImplemented(cfg, "tenant administration"))
admin.GET("/tenants/:id", adminNotImplemented(cfg, "tenant administration"))
admin.PUT("/tenants/:id", adminNotImplemented(cfg, "tenant administration"))
admin.GET("/metrics/overview", adminNotImplemented(cfg, "metrics overview"))
admin.GET("/waf/events", adminNotImplemented(cfg, "WAF event log"))
admin.GET("/temporal/workflows", adminNotImplemented(cfg, "temporal workflow listing"))
admin.GET("/fluvio/topics", adminNotImplemented(cfg, "fluvio topic listing"))
admin.GET("/dapr/events", adminNotImplemented(cfg, "dapr event log"))
}
}

// Bootstrap APISIX routes on startup (non-blocking)
if cfg.APISIX.AdminKey != "" {
go func() {
time.Sleep(5 * time.Second)
apisixClient := proxy.NewAPISIXClient(cfg.APISIX.AdminURL, cfg.APISIX.AdminKey)
services := map[string]string{
"node":   "localhost:3000",
"hermes": "localhost:8097",
}
if err := proxy.BootstrapWACommerceRoutes(apisixClient, services); err != nil {
logger.Warn("apisix.bootstrap.failed", zap.Error(err))
} else {
logger.Info("apisix.bootstrap.ok")
}
}()
}

srv := &http.Server{
Addr:         ":" + cfg.Port,
Handler:      r,
ReadTimeout:  15 * time.Second,
WriteTimeout: 30 * time.Second,
IdleTimeout:  60 * time.Second,
}

go func() {
logger.Info("API Gateway starting",
zap.String("port", cfg.Port),
zap.String("env", cfg.Env),
zap.Bool("permify", cfg.Permify.URL != ""),
zap.Bool("fluvio", cfg.Fluvio.Endpoint != ""),
zap.Bool("temporal", cfg.Temporal.Address != ""),
zap.Bool("openappsec", cfg.OpenAppSec.Enabled),
zap.Bool("apisix", cfg.APISIX.AdminKey != ""),
)
if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
logger.Fatal("gateway failed", zap.Error(err))
}
}()

quit := make(chan os.Signal, 1)
signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
<-quit

ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
defer cancel()
logger.Info("Gateway shutting down gracefully")
_ = srv.Shutdown(ctx)
}
