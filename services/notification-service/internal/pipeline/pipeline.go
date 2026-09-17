// === W45 go-rust-services (MSG-19) ===
// Package pipeline implements the notification-service queue-backed pipeline.
//
// The module previously contained only go.mod/go.sum — nothing consumed the
// notifications topics. This implementation is real:
//
//   Kafka topic notifications.dispatch (KAFKA_TOPIC_DISPATCH)
//     → consume (consumer group, manual commits)
//     → dedupe via Redis SETNX ns:idem:{key} (24h TTL)
//     → dispatch via HTTP POST to the platform notify endpoint
//     → on failure: retry with backoff (NOTIFY_MAX_ATTEMPTS)
//     → on terminal failure: produce to Kafka DLQ (KAFKA_TOPIC_DLQ,
//       default notifications.dlq) with the error attached, then commit.
//
// Offsets are committed only after dispatch/DLQ resolves (at-least-once).
package pipeline

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/segmentio/kafka-go"
)

// Notification is the dispatch message contract on notifications.dispatch.
type Notification struct {
	ID             string          `json:"id"`
	TenantID       string          `json:"tenant_id"`
	Channel        string          `json:"channel"` // whatsapp | telegram | email
	To             string          `json:"to"`
	Template       string          `json:"template,omitempty"`
	Body           string          `json:"body"`
	IdempotencyKey string          `json:"idempotency_key"`
	Metadata       json.RawMessage `json:"metadata,omitempty"`
}

// Config carries the pipeline's runtime configuration.
type Config struct {
	KafkaBrokers   string
	GroupID        string
	DispatchTopic  string
	DLQTopic       string
	RedisURL       string
	NotifyURL      string // platform internal notify endpoint
	InternalAPIKey string
	MaxAttempts    int
	IdempotencyTTL time.Duration
}

// Pipeline consumes dispatch messages and delivers notifications.
type Pipeline struct {
	cfg    Config
	reader *kafka.Reader
	dlq    *kafka.Writer
	redis  *redis.Client
	http   *http.Client
	logger *slog.Logger
}

func New(cfg Config, logger *slog.Logger) (*Pipeline, error) {
	if cfg.NotifyURL == "" {
		return nil, errors.New("NOTIFY_URL is required — notifications must have a real dispatch target")
	}
	if cfg.MaxAttempts <= 0 {
		cfg.MaxAttempts = 5
	}
	if cfg.IdempotencyTTL <= 0 {
		cfg.IdempotencyTTL = 24 * time.Hour
	}

	opt, err := redis.ParseURL(cfg.RedisURL)
	if err != nil {
		return nil, fmt.Errorf("parse REDIS_URL: %w", err)
	}
	rdb := redis.NewClient(opt)
	pingCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := rdb.Ping(pingCtx).Err(); err != nil {
		return nil, fmt.Errorf("redis ping: %w", err)
	}

	brokers := strings.Split(cfg.KafkaBrokers, ",")
	for i := range brokers {
		brokers[i] = strings.TrimSpace(brokers[i])
	}

	return &Pipeline{
		cfg:   cfg,
		redis: rdb,
		http:  &http.Client{Timeout: 15 * time.Second},
		reader: kafka.NewReader(kafka.ReaderConfig{
			Brokers:        brokers,
			GroupID:        cfg.GroupID,
			Topic:          cfg.DispatchTopic,
			MinBytes:       1,
			MaxBytes:       10 << 20,
			CommitInterval: 0, // manual commits
			StartOffset:    kafka.FirstOffset,
		}),
		dlq: &kafka.Writer{
			Addr:         kafka.TCP(brokers...),
			Topic:        cfg.DLQTopic,
			Balancer:     &kafka.Hash{},
			RequiredAcks: kafka.RequireOne,
		},
		logger: logger,
	}, nil
}

// Run is the consume loop; it returns only when ctx is cancelled.
func (p *Pipeline) Run(ctx context.Context) error {
	p.logger.Info("notification pipeline started",
		"topic", p.cfg.DispatchTopic, "group", p.cfg.GroupID, "dlq", p.cfg.DLQTopic)
	defer func() {
		_ = p.reader.Close()
		_ = p.dlq.Close()
	}()

	for {
		msg, err := p.reader.FetchMessage(ctx)
		if err != nil {
			if errors.Is(err, context.Canceled) || errors.Is(err, io.EOF) {
				return nil
			}
			p.logger.Error("fetch failed — backing off", "error", err)
			select {
			case <-ctx.Done():
				return nil
			case <-time.After(5 * time.Second):
			}
			continue
		}
		p.handle(ctx, msg)
	}
}

func (p *Pipeline) handle(ctx context.Context, msg kafka.Message) {
	var n Notification
	if err := json.Unmarshal(msg.Value, &n); err != nil {
		p.logger.Error("unmarshal notification failed — dead-lettering", "error", err, "offset", msg.Offset)
		p.deadLetter(ctx, msg, "unmarshal: "+err.Error())
		p.commit(ctx, msg)
		return
	}
	if n.IdempotencyKey == "" {
		n.IdempotencyKey = n.ID
	}
	if n.IdempotencyKey == "" {
		p.deadLetter(ctx, msg, "missing id and idempotency_key")
		p.commit(ctx, msg)
		return
	}

	// Idempotency: SETNX with TTL — duplicates commit silently.
	ok, err := p.redis.SetNX(ctx, "ns:idem:"+n.IdempotencyKey, "1", p.cfg.IdempotencyTTL).Result()
	if err != nil {
		p.logger.Error("idempotency check failed — will retry via redelivery", "error", err)
		return // no commit → redelivered
	}
	if !ok {
		p.logger.Info("duplicate notification skipped", "idempotency_key", n.IdempotencyKey)
		p.commit(ctx, msg)
		return
	}

	if err := p.dispatchWithRetry(ctx, n); err != nil {
		p.logger.Error("dispatch failed terminally — dead-lettering",
			"id", n.ID, "channel", n.Channel, "error", err)
		p.deadLetter(ctx, msg, err.Error())
	}
	p.commit(ctx, msg)
}

// dispatchWithRetry POSTs the notification to the platform notify endpoint,
// retrying with exponential backoff up to MaxAttempts.
func (p *Pipeline) dispatchWithRetry(ctx context.Context, n Notification) error {
	body, _ := json.Marshal(n)
	var lastErr error
	for attempt := 1; attempt <= p.cfg.MaxAttempts; attempt++ {
		if err := p.dispatch(ctx, body); err != nil {
			lastErr = err
			backoff := time.Duration(attempt*attempt) * 2 * time.Second
			p.logger.Warn("dispatch attempt failed", "attempt", attempt, "backoff", backoff.String(), "error", err)
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(backoff):
			}
			continue
		}
		p.logger.Info("notification dispatched",
			"id", n.ID, "channel", n.Channel, "to", n.To, "tenant_id", n.TenantID)
		return nil
	}
	return fmt.Errorf("exhausted %d attempts: %w", p.cfg.MaxAttempts, lastErr)
}

func (p *Pipeline) dispatch(ctx context.Context, body []byte) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.cfg.NotifyURL, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if p.cfg.InternalAPIKey != "" {
		req.Header.Set("X-Internal-Token", p.cfg.InternalAPIKey)
	}
	resp, err := p.http.Do(req)
	if err != nil {
		return fmt.Errorf("notify POST failed: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return fmt.Errorf("notify api %d: %s", resp.StatusCode, string(b))
	}
	return nil
}

func (p *Pipeline) deadLetter(ctx context.Context, msg kafka.Message, reason string) {
	writeCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	err := p.dlq.WriteMessages(writeCtx, kafka.Message{
		Key:   msg.Key,
		Value: msg.Value,
		Headers: append(msg.Headers,
			kafka.Header{Key: "dlq.reason", Value: []byte(reason)},
			kafka.Header{Key: "dlq.source_offset", Value: []byte(strconv.FormatInt(msg.Offset, 10))},
			kafka.Header{Key: "dlq.at", Value: []byte(time.Now().UTC().Format(time.RFC3339))},
		),
	})
	if err != nil {
		p.logger.Error("DLQ write failed — message dropped after commit", "error", err, "offset", msg.Offset)
	}
}

func (p *Pipeline) commit(ctx context.Context, msg kafka.Message) {
	if err := p.reader.CommitMessages(ctx, msg); err != nil && !errors.Is(err, context.Canceled) {
		p.logger.Error("offset commit failed", "error", err, "offset", msg.Offset)
	}
}
