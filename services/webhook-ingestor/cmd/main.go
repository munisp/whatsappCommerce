package main

import (
	"context"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/whatsapp-commerce/webhook-ingestor/internal/config"
	"github.com/whatsapp-commerce/webhook-ingestor/internal/handler"
	"github.com/whatsapp-commerce/webhook-ingestor/internal/kafka"
	"github.com/whatsapp-commerce/webhook-ingestor/internal/store"
	"go.uber.org/zap"
)

func main() {
	cfg := config.Load()
	logger, _ := zap.NewProduction()
	defer logger.Sync()

	db, err := store.NewPostgres(cfg.DatabaseURL)
	if err != nil {
		logger.Fatal("failed to connect to database", zap.Error(err))
	}

	producer, err := kafka.NewProducer(cfg.KafkaBrokers)
	if err != nil {
		logger.Fatal("failed to create kafka producer", zap.Error(err))
	}
	defer producer.Close()

	h := handler.New(cfg, db, producer, logger)

	r := gin.New()
	r.Use(gin.Recovery())

	r.GET("/health", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "ok", "service": "webhook-ingestor"})
	})

	r.POST("/webhooks/chatwoot/:tenant_slug", h.HandleChatwoot)
	r.POST("/webhooks/mojaloop/callback/:tenant_slug", h.HandleMojaloopCallback)
	r.POST("/webhooks/twenty/:tenant_slug", h.HandleTwentyWebhook)
	r.POST("/webhooks/odoo/:tenant_slug", h.HandleOdooWebhook)

	srv := &http.Server{Addr: ":" + cfg.Port, Handler: r}
	go func() {
		logger.Info("Webhook Ingestor starting", zap.String("port", cfg.Port))
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

