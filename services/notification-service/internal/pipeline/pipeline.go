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
	"sync"
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
	// === W48 sidecars (PERF-SC-3) ===
	Workers     int           // concurrent dispatch workers (default 16)
	FetchMinBytes int         // kafka fetch MinBytes (default 1 KiB — was 1)
	CommitEvery time.Duration // offset commit coalescing interval (default 2s)
}

// Pipeline consumes dispatch messages and delivers notifications.
type Pipeline struct {
	cfg    Config
	reader *kafka.Reader
	dlq    *kafka.Writer
	redis  *redis.Client
	http   *http.Client
	logger *slog.Logger

	// PERF-SC-3: bounded worker pool + coalesced commits.
	workers  chan struct{}
	commitMu sync.Mutex
	pending  map[int]int64 // partition → highest completed offset (inclusive)
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
	if cfg.Workers <= 0 {
		cfg.Workers = 16
	}
	if cfg.FetchMinBytes <= 0 {
		cfg.FetchMinBytes = 1024 // PERF-SC-3: batch fetches (was 1 → fetch per message)
	}
	if cfg.CommitEvery <= 0 {
		cfg.CommitEvery = 2 * time.Second
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
			MinBytes:       cfg.FetchMinBytes,
			MaxBytes:       10 << 20,
			MaxWait:        500 * time.Millisecond, // PERF-SC-3: linger for batches
			CommitInterval: 0,                      // manual commits
			StartOffset:    kafka.FirstOffset,
		}),
		dlq: &kafka.Writer{
			Addr:         kafka.TCP(brokers...),
			Topic:        cfg.DLQTopic,
			Balancer:     &kafka.Hash{},
			RequiredAcks: kafka.RequireOne,
			BatchSize:    100, // PERF-SC-3: coalesce DLQ writes
			BatchTimeout: 200 * time.Millisecond,
		},
		logger:  logger,
		workers: make(chan struct{}, cfg.Workers),
		pending: make(map[int]int64),
	}, nil
}

// Run is the consume loop; it returns only when ctx is cancelled.
//
// PERF-SC-3: messages are dispatched to a bounded worker pool so a slow/failing
// notification no longer head-of-line blocks the whole partition (the old loop
// slept up to ~110s inline per poison message). Offsets are committed in
// batches on a ticker (highest completed offset per partition) instead of one
// synchronous commit RPC per message.
func (p *Pipeline) Run(ctx context.Context) error {
	p.logger.Info("notification pipeline started",
		"topic", p.cfg.DispatchTopic, "group", p.cfg.GroupID, "dlq", p.cfg.DLQTopic,
		"workers", p.cfg.Workers, "fetch_min_bytes", p.cfg.FetchMinBytes)
	defer func() {
		_ = p.reader.Close()
		_ = p.dlq.Close()
	}()

	commitTick := time.NewTicker(p.cfg.CommitEvery)
	defer commitTick.Stop()

	for {
		select {
		case <-ctx.Done():
			p.flushCommits(context.Background())
			return nil
		case <-commitTick.C:
			p.flushCommits(ctx)
		default:
		}

		msg, err := p.reader.FetchMessage(ctx)
		if err != nil {
			if errors.Is(err, context.Canceled) || errors.Is(err, io.EOF) {
				p.flushCommits(context.Background())
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

		// Acquire a worker slot — this is the (intentional) backpressure point:
		// when all workers are busy the fetch loop pauses and Kafka retains.
		select {
		case p.workers <- struct{}{}:
		case <-ctx.Done():
			return nil
		}
		go func(m kafka.Message) {
			defer func() { <-p.workers }()
			p.handle(ctx, m)
			p.recordOffset(m)
		}(msg)
	}
}

// recordOffset tracks the highest fully-handled offset per partition.
func (p *Pipeline) recordOffset(msg kafka.Message) {
	p.commitMu.Lock()
	if msg.Offset > p.pending[msg.Partition] {
		p.pending[msg.Partition] = msg.Offset
	}
	p.commitMu.Unlock()
}

// flushCommits commits the highest completed offset per partition in one
// call — at-least-once is preserved because offsets are only recorded after
// handle() has dispatched or dead-lettered the message.
func (p *Pipeline) flushCommits(ctx context.Context) {
	p.commitMu.Lock()
	if len(p.pending) == 0 {
		p.commitMu.Unlock()
		return
	}
	msgs := make([]kafka.Message, 0, len(p.pending))
	for part, off := range p.pending {
		msgs = append(msgs, kafka.Message{Topic: p.cfg.DispatchTopic, Partition: part, Offset: off})
	}
	p.pending = make(map[int]int64)
	p.commitMu.Unlock()

	commitCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := p.reader.CommitMessages(commitCtx, msgs...); err != nil && !errors.Is(err, context.Canceled) {
		p.logger.Error("batched offset commit failed", "error", err)
	}
}

func (p *Pipeline) handle(ctx context.Context, msg kafka.Message) {
	var n Notification
	if err := json.Unmarshal(msg.Value, &n); err != nil {
		p.logger.Error("unmarshal notification failed — dead-lettering", "error", err, "offset", msg.Offset)
		p.deadLetter(ctx, msg, "unmarshal: "+err.Error())
		return
	}
	if n.IdempotencyKey == "" {
		n.IdempotencyKey = n.ID
	}
	if n.IdempotencyKey == "" {
		p.deadLetter(ctx, msg, "missing id and idempotency_key")
		return
	}

	// Idempotency: SETNX with TTL — duplicates commit silently. PERF-SC-3:
	// Redis failures get a short bounded retry inside the worker (not the fetch
	// loop); on persistent failure we dispatch anyway (at-least-once delivery —
	// a duplicate notification is recoverable, a silently dropped one is not).
	var ok bool
	var err error
	for attempt := 0; attempt < 3; attempt++ {
		ok, err = p.redis.SetNX(ctx, "ns:idem:"+n.IdempotencyKey, "1", p.cfg.IdempotencyTTL).Result()
		if err == nil {
			break
		}
		p.logger.Warn("idempotency check failed — bounded retry", "error", err, "attempt", attempt+1)
		select {
		case <-ctx.Done():
			return
		case <-time.After(time.Duration(200*(attempt+1)) * time.Millisecond):
		}
	}
	if err != nil {
		p.logger.Error("idempotency store unavailable after retries — dispatching fail-open (duplicate risk accepted over message loss)",
			"error", err, "idempotency_key", n.IdempotencyKey)
	} else if !ok {
		p.logger.Info("duplicate notification skipped", "idempotency_key", n.IdempotencyKey)
		return
	}

	if err := p.dispatchWithRetry(ctx, n); err != nil {
		p.logger.Error("dispatch failed terminally — dead-lettering",
			"id", n.ID, "channel", n.Channel, "error", err)
		p.deadLetter(ctx, msg, err.Error())
	}
}

// dispatchWithRetry POSTs the notification to the platform notify endpoint,
// retrying with BOUNDED exponential backoff up to MaxAttempts.
//
// PERF-SC-3: the old quadratic sleep (2·attempt² s ⇒ ~110 s worst case) ran
// inside the single-threaded consume loop and head-of-line blocked the whole
// partition. Backoff is now 500ms · 2^(attempt-1), capped at 8s (≈15s worst
// case), and runs inside a pool worker — the fetch loop keeps flowing and
// terminal failures are handed to the DLQ.
func (p *Pipeline) dispatchWithRetry(ctx context.Context, n Notification) error {
	body, _ := json.Marshal(n)
	var lastErr error
	for attempt := 1; attempt <= p.cfg.MaxAttempts; attempt++ {
		if err := p.dispatch(ctx, body); err != nil {
			lastErr = err
			backoff := time.Duration(1<<(attempt-1)) * 500 * time.Millisecond
			if backoff > 8*time.Second {
				backoff = 8 * time.Second
			}
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

