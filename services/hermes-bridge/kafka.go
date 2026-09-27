// === W45 go-rust-services ===
// kafka.go — real Kafka consumer for hermes-bridge (MSG-20).
//
// Replaces the KafkaConsumerStub: a segmentio/kafka-go consumer group reads
// hermes.events.inbound, hands each message to EventProcessor.processEvent
// synchronously, and commits the offset only after the event was forwarded
// to Hermes. Events that fail after the forward attempt are produced to the
// DLQ topic (KAFKA_HERMES_DLQ_TOPIC, default hermes.events.dlq) with the
// error attached, then committed so one poison message cannot stall the
// partition.
//
// kafka-go is pure Go (no CGO/librdkafka), so the existing Dockerfile build
// works unchanged.
//
// The /hermes/ingest HTTP endpoint remains as an explicit operator fallback
// for environments without a broker (documented in env.example.txt).

package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/segmentio/kafka-go"
)

// KafkaConsumer consumes platform events from the inbound topic.
type KafkaConsumer struct {
	reader    *kafka.Reader
	dlqWriter *kafka.Writer
	processor *EventProcessor
	logger    *slog.Logger

	// === W48 sidecars (PERF-SC-3) === bounded worker pool + coalesced commits
	// (was: fetch-one → process → sync-commit per message; a slow forward
	// stalled the whole partition).
	workers  chan struct{}
	commitMu sync.Mutex
	pending  map[int]int64 // partition → highest completed offset
}

func envOrInt(key string, fallback int) int {
	if v, err := strconv.Atoi(strings.TrimSpace(os.Getenv(key))); err == nil && v > 0 {
		return v
	}
	return fallback
}

func NewKafkaConsumer(cfg Config, processor *EventProcessor, logger *slog.Logger) *KafkaConsumer {
	brokers := strings.Split(cfg.KafkaBrokers, ",")
	for i := range brokers {
		brokers[i] = strings.TrimSpace(brokers[i])
	}
	workers := envOrInt("HERMES_CONSUMER_WORKERS", 16)
	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers:        brokers,
		GroupID:        cfg.KafkaGroupID,
		Topic:          cfg.KafkaInboundTopic,
		MinBytes:       envOrInt("HERMES_FETCH_MIN_BYTES", 1024), // PERF-SC-3: batch fetches (was 1)
		MaxBytes:       10 << 20,                                 // 10 MiB
		MaxWait:        500 * time.Millisecond,                   // linger for batches
		CommitInterval: 0,                                        // manual commits only (at-least-once)
		StartOffset:    kafka.FirstOffset,
	})
	return &KafkaConsumer{
		reader: reader,
		dlqWriter: &kafka.Writer{
			Addr:         kafka.TCP(brokers...),
			Topic:        cfg.KafkaDLQTopic,
			Balancer:     &kafka.Hash{},
			RequiredAcks: kafka.RequireOne,
			Async:        false,
			BatchSize:    100, // PERF-SC-3: coalesce DLQ writes
			BatchTimeout: 200 * time.Millisecond,
		},
		processor: processor,
		logger:    logger,
		workers:   make(chan struct{}, workers),
		pending:   make(map[int]int64),
	}
}

// Start runs the consume loop until ctx is cancelled. Broker dial/startup
// failures are retried with backoff (kafka-go returns them from FetchMessage)
// so the service survives broker restarts; only ctx cancellation stops it.
func (kc *KafkaConsumer) Start(ctx context.Context) {
	kc.logger.Info("kafka consumer started",
		"topic", kc.reader.Config().Topic,
		"group", kc.reader.Config().GroupID,
		"brokers", kc.reader.Config().Brokers)
	defer func() {
		_ = kc.reader.Close()
		_ = kc.dlqWriter.Close()
	}()

	commitTick := time.NewTicker(2 * time.Second)
	defer commitTick.Stop()

	for {
		select {
		case <-ctx.Done():
			kc.flushCommits(context.Background())
			return
		case <-commitTick.C:
			kc.flushCommits(ctx)
		default:
		}

		msg, err := kc.reader.FetchMessage(ctx)
		if err != nil {
			if errors.Is(err, context.Canceled) || errors.Is(err, io.EOF) {
				kc.logger.Info("kafka consumer stopped")
				kc.flushCommits(context.Background())
				return
			}
			kc.logger.Error("kafka fetch failed — retrying after backoff", "error", err)
			select {
			case <-ctx.Done():
				return
			case <-time.After(5 * time.Second):
			}
			continue
		}

		// Bounded worker pool: the slot acquire is the backpressure point —
		// when all workers are busy the fetch loop pauses and Kafka retains.
		select {
		case kc.workers <- struct{}{}:
		case <-ctx.Done():
			return
		}
		go func(m kafka.Message) {
			defer func() { <-kc.workers }()
			kc.handle(ctx, m)
			kc.recordOffset(m)
		}(msg)
	}
}

func (kc *KafkaConsumer) handle(ctx context.Context, msg kafka.Message) {
	var event PlatformEvent
	if err := json.Unmarshal(msg.Value, &event); err != nil {
		kc.logger.Error("unmarshal kafka event failed — dead-lettering",
			"error", err, "offset", msg.Offset)
		kc.deadLetter(ctx, msg, "unmarshal: "+err.Error())
		return
	}
	if event.ID == "" && len(msg.Key) > 0 {
		event.ID = string(msg.Key)
	}
	if event.OccurredAt == "" {
		event.OccurredAt = msg.Time.UTC().Format(time.RFC3339)
	}

	// Offset is recorded (and batch-committed) only after the forward attempt
	// resolves (at-least-once; Hermes dedupes on idempotency_key).
	if err := kc.processor.processEvent(ctx, event); err != nil {
		kc.logger.Error("event processing failed — dead-lettering",
			"event_id", event.ID, "error", err)
		kc.deadLetter(ctx, msg, err.Error())
	}
}

// recordOffset tracks the highest fully-handled offset per partition.
func (kc *KafkaConsumer) recordOffset(msg kafka.Message) {
	kc.commitMu.Lock()
	if msg.Offset > kc.pending[msg.Partition] {
		kc.pending[msg.Partition] = msg.Offset
	}
	kc.commitMu.Unlock()
}

// flushCommits commits the highest completed offset per partition in one
// call (PERF-SC-3: replaces the per-message synchronous commit).
func (kc *KafkaConsumer) flushCommits(ctx context.Context) {
	kc.commitMu.Lock()
	if len(kc.pending) == 0 {
		kc.commitMu.Unlock()
		return
	}
	msgs := make([]kafka.Message, 0, len(kc.pending))
	for part, off := range kc.pending {
		msgs = append(msgs, kafka.Message{Topic: kc.reader.Config().Topic, Partition: part, Offset: off})
	}
	kc.pending = make(map[int]int64)
	kc.commitMu.Unlock()

	commitCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := kc.reader.CommitMessages(commitCtx, msgs...); err != nil && !errors.Is(err, context.Canceled) {
		kc.logger.Error("batched kafka offset commit failed", "error", err)
	}
}

// deadLetter produces the failed message to the DLQ topic with the error in
// a header. Best-effort: a DLQ write failure is logged loudly but the offset
// is still committed to avoid a poison-pill stall.
func (kc *KafkaConsumer) deadLetter(ctx context.Context, msg kafka.Message, reason string) {
	dlqMsg := kafka.Message{
		Key:   msg.Key,
		Value: msg.Value,
		Headers: append(msg.Headers,
			kafka.Header{Key: "dlq.reason", Value: []byte(reason)},
			kafka.Header{Key: "dlq.source_topic", Value: []byte(msg.Topic)},
			kafka.Header{Key: "dlq.source_offset", Value: []byte(strconv.FormatInt(msg.Offset, 10))},
			kafka.Header{Key: "dlq.at", Value: []byte(time.Now().UTC().Format(time.RFC3339))},
		),
	}
	writeCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := kc.dlqWriter.WriteMessages(writeCtx, dlqMsg); err != nil {
		kc.logger.Error("DLQ write failed — message dropped after commit",
			"error", err, "offset", msg.Offset)
	}
}
