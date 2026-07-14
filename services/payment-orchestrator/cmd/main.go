package main

import (
	"context"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/whatsapp-commerce/payment-orchestrator/internal/config"
	"github.com/whatsapp-commerce/payment-orchestrator/internal/handler"
	"github.com/whatsapp-commerce/payment-orchestrator/internal/store"
	"go.uber.org/zap"
)

func main() {
	cfg := config.Load()
	logger, _ := zap.NewProduction()
	defer logger.Sync()

	db, err := store.NewPostgres(cfg.DatabaseURL)
	if err != nil {
		logger.Fatal("db connect failed", zap.Error(err))
	}

	h := handler.New(cfg, db, logger)

	r := gin.New()
	r.Use(gin.Recovery())

	r.GET("/health", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "ok", "service": "payment-orchestrator"})
	})

	r.POST("/payments/initiate", h.InitiatePayment)
	r.GET("/payments/:id/status", h.GetPaymentStatus)
	r.POST("/payments/:id/refund", h.RefundPayment)
	r.POST("/payments/:id/void", h.VoidPayment)

	// Mojaloop async callback (forwarded from webhook-ingestor)
	r.POST("/webhooks/mojaloop/callback/:tenant_slug", h.HandleMojaloopCallback)

	srv := &http.Server{Addr: ":" + cfg.Port, Handler: r}
	go func() {
		logger.Info("Payment Orchestrator starting", zap.String("port", cfg.Port))
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			logger.Fatal("server failed", zap.Error(err))
		}
	}()

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	_ = srv.Shutdown(ctx)
}

