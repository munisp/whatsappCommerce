// === W45 go-rust-services (MSG-19) ===
// notification-service — queue-backed notification dispatch pipeline.
//
// Consumes notifications.dispatch (Kafka), dedupes via Redis, delivers to the
// platform notify endpoint with retries, dead-letters terminal failures to
// notifications.dlq. Exposes /health on PORT.
package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/whatsapp-commerce/notification-service/internal/pipeline"
)

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	started := time.Now()

	maxAttempts, _ := strconv.Atoi(envOr("NOTIFY_MAX_ATTEMPTS", "5"))
	cfg := pipeline.Config{
		KafkaBrokers:   envOr("KAFKA_BROKERS", "localhost:9092"),
		GroupID:        envOr("KAFKA_GROUP_ID", "notification-service-v1"),
		DispatchTopic:  envOr("KAFKA_TOPIC_DISPATCH", "notifications.dispatch"),
		DLQTopic:       envOr("KAFKA_TOPIC_DLQ", "notifications.dlq"),
		RedisURL:       envOr("REDIS_URL", "redis://localhost:6379/0"),
		NotifyURL:      os.Getenv("NOTIFY_URL"), // required — no default target
		InternalAPIKey: os.Getenv("INTERNAL_API_KEY"),
		MaxAttempts:    maxAttempts,
	}

	p, err := pipeline.New(cfg, logger)
	if err != nil {
		logger.Error("pipeline init failed", "error", err)
		os.Exit(1)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = p.Run(ctx) }()

	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	r.GET("/health", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{
			"status":         "ok",
			"service":        "notification-service",
			"uptime_seconds": time.Since(started).Seconds(),
			"dispatch_topic": cfg.DispatchTopic,
			"dlq_topic":      cfg.DLQTopic,
		})
	})

	srv := &http.Server{Addr: ":" + envOr("PORT", "8098"), Handler: r}
	go func() {
		logger.Info("notification-service listening", "addr", srv.Addr)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			logger.Error("http server failed", "error", err)
			os.Exit(1)
		}
	}()

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit
	logger.Info("shutting down notification-service")
	cancel()
	shutdownCtx, done := context.WithTimeout(context.Background(), 10*time.Second)
	defer done()
	_ = srv.Shutdown(shutdownCtx)
}
