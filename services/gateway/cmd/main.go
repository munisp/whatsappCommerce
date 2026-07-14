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
	r.Use(ratelimit.Middleware(cfg))

	// Health and readiness
	r.GET("/health", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "ok", "service": "gateway", "ts": time.Now().UTC()})
	})
	r.GET("/ready", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "ready"})
	})

	// Public webhook endpoints (Chatwoot, Mojaloop callbacks)
	webhooks := r.Group("/webhooks")
	{
		webhooks.POST("/chatwoot/:tenant_slug", proxy.ForwardTo(cfg.Services.WebhookIngestor))
		webhooks.POST("/mojaloop/callback/:tenant_slug", proxy.ForwardTo(cfg.Services.PaymentOrchestrator))
		webhooks.POST("/twenty/:tenant_slug", proxy.ForwardTo(cfg.Services.CRMAdapter))
		webhooks.POST("/odoo/:tenant_slug", proxy.ForwardTo(cfg.Services.ERPAdapter))
	}

	// Internal API — requires JWT
	api := r.Group("/api/v1")
	api.Use(middleware.JWTAuth(cfg))
	{
		// Conversation management
		api.GET("/conversations", proxy.ForwardTo(cfg.Services.ConversationOrchestrator))
		api.GET("/conversations/:id", proxy.ForwardTo(cfg.Services.ConversationOrchestrator))
		api.POST("/conversations/:id/handoff", proxy.ForwardTo(cfg.Services.ConversationOrchestrator))
		api.POST("/conversations/:id/resolve", proxy.ForwardTo(cfg.Services.ConversationOrchestrator))

		// Commerce
		api.GET("/products", proxy.ForwardTo(cfg.Services.CommerceEngine))
		api.GET("/products/:id", proxy.ForwardTo(cfg.Services.CommerceEngine))
		api.GET("/inventory/:sku", proxy.ForwardTo(cfg.Services.CommerceEngine))
		api.POST("/carts", proxy.ForwardTo(cfg.Services.CommerceEngine))
		api.GET("/carts/:id", proxy.ForwardTo(cfg.Services.CommerceEngine))
		api.POST("/carts/:id/items", proxy.ForwardTo(cfg.Services.CommerceEngine))
		api.DELETE("/carts/:id/items/:item_id", proxy.ForwardTo(cfg.Services.CommerceEngine))
		api.POST("/carts/:id/checkout", proxy.ForwardTo(cfg.Services.CommerceEngine))

		// Orders
		api.GET("/orders", proxy.ForwardTo(cfg.Services.CommerceEngine))
		api.GET("/orders/:id", proxy.ForwardTo(cfg.Services.CommerceEngine))
		api.POST("/orders/:id/cancel", proxy.ForwardTo(cfg.Services.CommerceEngine))

		// Payments
		api.POST("/payments/initiate", proxy.ForwardTo(cfg.Services.PaymentOrchestrator))
		api.GET("/payments/:id/status", proxy.ForwardTo(cfg.Services.PaymentOrchestrator))
		api.POST("/payments/:id/refund", proxy.ForwardTo(cfg.Services.PaymentOrchestrator))

		// AI Agent
		api.POST("/ai/intent", proxy.ForwardTo(cfg.Services.AIAgent))
		api.POST("/ai/recommend", proxy.ForwardTo(cfg.Services.AIAgent))
		api.POST("/ai/handoff-summary", proxy.ForwardTo(cfg.Services.AIAgent))

		// Tenant admin (requires admin role)
		admin := api.Group("/admin")
		admin.Use(middleware.RequireRole("admin", "platform_engineer"))
		{
			admin.GET("/tenants", proxy.ForwardTo(cfg.Services.Gateway))
			admin.POST("/tenants", proxy.ForwardTo(cfg.Services.Gateway))
			admin.GET("/tenants/:id", proxy.ForwardTo(cfg.Services.Gateway))
			admin.PUT("/tenants/:id", proxy.ForwardTo(cfg.Services.Gateway))
			admin.GET("/metrics/overview", proxy.ForwardTo(cfg.Services.Gateway))
		}
	}

	srv := &http.Server{
		Addr:         ":" + cfg.Port,
		Handler:      r,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 30 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	go func() {
		logger.Info("API Gateway starting", zap.String("port", cfg.Port), zap.String("env", cfg.Env))
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

