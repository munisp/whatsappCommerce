package main

import (
"context"
"net/http"
"os"
"os/signal"
"syscall"
"time"

"github.com/gin-gonic/gin"
"github.com/whatsapp-commerce/gateway/internal/config"
"github.com/whatsapp-commerce/gateway/internal/middleware"
"github.com/whatsapp-commerce/gateway/internal/proxy"
"github.com/whatsapp-commerce/gateway/internal/ratelimit"
"go.uber.org/zap"
)

func main() {
cfg := config.Load()
logger, _ := zap.NewProduction()
defer logger.Sync()

if cfg.Env == "development" {
gin.SetMode(gin.DebugMode)
} else {
gin.SetMode(gin.ReleaseMode)
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
api.POST("/carts/:id/checkout", proxy.ForwardTo(cfg.Services.CommerceEngine))

// Orders
api.GET("/orders", middleware.RequirePermify("tenant", "view", ""), proxy.ForwardTo(cfg.Services.CommerceEngine))
api.GET("/orders/:id", middleware.RequirePermify("order", "view", "id"), proxy.ForwardTo(cfg.Services.CommerceEngine))
api.POST("/orders/:id/cancel", middleware.RequirePermify("order", "cancel", "id"), proxy.ForwardTo(cfg.Services.CommerceEngine))
api.POST("/orders/:id/confirm", middleware.RequirePermify("order", "fulfill", "id"), proxy.ForwardTo(cfg.Services.CommerceEngine))

// Payments
api.POST("/payments/initiate", proxy.ForwardTo(cfg.Services.PaymentOrchestrator))
api.GET("/payments/:id/status", proxy.ForwardTo(cfg.Services.PaymentOrchestrator))
api.POST("/payments/:id/refund", middleware.RequirePermify("tenant", "edit", ""), proxy.ForwardTo(cfg.Services.PaymentOrchestrator))

// AI Agent
api.POST("/ai/intent", proxy.ForwardTo(cfg.Services.AIAgent))
api.POST("/ai/recommend", proxy.ForwardTo(cfg.Services.AIAgent))
api.POST("/ai/handoff-summary", proxy.ForwardTo(cfg.Services.AIAgent))

// ML Stack (fraud detection, credit scoring)
api.POST("/ml/predict", proxy.ForwardTo(cfg.Services.MLStack))
api.GET("/ml/health", proxy.ForwardTo(cfg.Services.MLStack))

// Admin (admin role + Permify system:manage)
admin := api.Group("/admin")
admin.Use(middleware.RequireRole("admin", "platform_engineer"))
admin.Use(middleware.RequirePermify("system", "manage", ""))
{
admin.GET("/tenants", proxy.ForwardTo(cfg.Services.Gateway))
admin.POST("/tenants", proxy.ForwardTo(cfg.Services.Gateway))
admin.GET("/tenants/:id", proxy.ForwardTo(cfg.Services.Gateway))
admin.PUT("/tenants/:id", proxy.ForwardTo(cfg.Services.Gateway))
admin.GET("/metrics/overview", proxy.ForwardTo(cfg.Services.Gateway))
admin.GET("/waf/events", proxy.ForwardTo(cfg.Services.Gateway))
admin.GET("/temporal/workflows", proxy.ForwardTo(cfg.Services.Gateway))
admin.GET("/fluvio/topics", proxy.ForwardTo(cfg.Services.Gateway))
admin.GET("/dapr/events", proxy.ForwardTo(cfg.Services.Gateway))
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
