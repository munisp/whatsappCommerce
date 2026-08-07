package fluvio

// producer.go — Fluvio event producer for the API Gateway.
//
// The gateway publishes domain events to Fluvio topics in addition to Kafka,
// enabling real-time stream processing via the Fluvio consumer sidecar.
//
// Topics (mirrors fluvio-topic-mapping.md):
//   wacommerce.orders       — order lifecycle events
//   wacommerce.payments     — payment state changes
//   wacommerce.conversations — conversation events
//   wacommerce.inventory    — stock level changes
//   wacommerce.hermes.po    — Hermes PO drafts
//
// The producer uses the Fluvio HTTP API (REST gateway) when FLUVIO_ENDPOINT
// is set, falling back to a no-op when unavailable.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"

	"go.uber.org/zap"
)

// ─── Configuration ────────────────────────────────────────────────────────────

type Config struct {
	Endpoint string // e.g. http://fluvio-sc:9003
	APIKey   string
}

func ConfigFromEnv() Config {
	return Config{
		Endpoint: os.Getenv("FLUVIO_ENDPOINT"),
		APIKey:   os.Getenv("FLUVIO_API_KEY"),
	}
}

// ─── Producer ─────────────────────────────────────────────────────────────────

type Producer struct {
	cfg    Config
	http   *http.Client
	logger *zap.Logger
}

func NewProducer(cfg Config, logger *zap.Logger) *Producer {
	return &Producer{
		cfg:    cfg,
		http:   &http.Client{Timeout: 3 * time.Second},
		logger: logger,
	}
}

// Publish sends a record to a Fluvio topic via the HTTP REST gateway.
// Falls back gracefully when Fluvio is unavailable.
func (p *Producer) Publish(ctx context.Context, topic string, key string, value interface{}) error {
	if p.cfg.Endpoint == "" {
		return nil // Fluvio not configured
	}
	b, err := json.Marshal(value)
	if err != nil {
		return fmt.Errorf("fluvio marshal: %w", err)
	}
	// Fluvio REST API: POST /topics/{topic}/produce
	url := fmt.Sprintf("%s/topics/%s/produce", strings.TrimRight(p.cfg.Endpoint, "/"), topic)
	payload := map[string]interface{}{
		"key":   key,
		"value": string(b),
	}
	body, _ := json.Marshal(payload)
	req, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if p.cfg.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+p.cfg.APIKey)
	}
	resp, err := p.http.Do(req)
	if err != nil {
		p.logger.Warn("fluvio.produce.failed",
			zap.String("topic", topic),
			zap.String("key", key),
			zap.Error(err),
		)
		return nil // fail open
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		p.logger.Warn("fluvio.produce.error",
			zap.String("topic", topic),
			zap.Int("status", resp.StatusCode),
		)
		return nil // fail open
	}
	p.logger.Debug("fluvio.produce.ok",
		zap.String("topic", topic),
		zap.String("key", key),
	)
	return nil
}

// PublishOrderEvent publishes an order domain event to wacommerce.orders.
func (p *Producer) PublishOrderEvent(ctx context.Context, eventType string, payload map[string]interface{}) {
	payload["eventType"] = eventType
	payload["publishedAt"] = time.Now().UTC().Format(time.RFC3339)
	if err := p.Publish(ctx, "wacommerce.orders", eventType, payload); err != nil {
		p.logger.Warn("fluvio.order_event.failed", zap.String("type", eventType), zap.Error(err))
	}
}

// PublishPaymentEvent publishes a payment domain event to wacommerce.payments.
func (p *Producer) PublishPaymentEvent(ctx context.Context, eventType string, payload map[string]interface{}) {
	payload["eventType"] = eventType
	payload["publishedAt"] = time.Now().UTC().Format(time.RFC3339)
	if err := p.Publish(ctx, "wacommerce.payments", eventType, payload); err != nil {
		p.logger.Warn("fluvio.payment_event.failed", zap.String("type", eventType), zap.Error(err))
	}
}

// PublishInventoryEvent publishes an inventory event to wacommerce.inventory.
func (p *Producer) PublishInventoryEvent(ctx context.Context, eventType string, payload map[string]interface{}) {
	payload["eventType"] = eventType
	payload["publishedAt"] = time.Now().UTC().Format(time.RFC3339)
	if err := p.Publish(ctx, "wacommerce.inventory", eventType, payload); err != nil {
		p.logger.Warn("fluvio.inventory_event.failed", zap.String("type", eventType), zap.Error(err))
	}
}

// PublishConversationEvent publishes a conversation event.
func (p *Producer) PublishConversationEvent(ctx context.Context, eventType string, payload map[string]interface{}) {
	payload["eventType"] = eventType
	payload["publishedAt"] = time.Now().UTC().Format(time.RFC3339)
	if err := p.Publish(ctx, "wacommerce.conversations", eventType, payload); err != nil {
		p.logger.Warn("fluvio.conversation_event.failed", zap.String("type", eventType), zap.Error(err))
	}
}

// Health checks Fluvio connectivity.
func (p *Producer) Health() (bool, int64) {
	if p.cfg.Endpoint == "" {
		return false, 0
	}
	start := time.Now()
	resp, err := p.http.Get(p.cfg.Endpoint + "/health")
	latency := time.Since(start).Milliseconds()
	if err != nil || resp.StatusCode >= 400 {
		return false, latency
	}
	return true, latency
}
