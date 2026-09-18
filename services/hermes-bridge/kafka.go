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
	"strconv"
	"strings"
	"time"

	"github.com/segmentio/kafka-go"
)

// KafkaConsumer consumes platform events from the inbound topic.
type KafkaConsumer struct {
	reader    *kafka.Reader
	dlqWriter *kafka.Writer
	processor *EventProcessor
	logger    *slog.Logger
}

func NewKafkaConsumer(cfg Config, processor *EventProcessor, logger *slog.Logger) *KafkaConsumer {
	brokers := strings.Split(cfg.KafkaBrokers, ",")
	for i := range brokers {
		brokers[i] = strings.TrimSpace(brokers[i])
	}
	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers:        brokers,
		GroupID:        cfg.KafkaGroupID,
		Topic:          cfg.KafkaInboundTopic,
		MinBytes:       1,
		MaxBytes:       10 << 20, // 10 MiB
		CommitInterval: 0,        // manual commits only (at-least-once)
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
		},
		processor: processor,
		logger:    logger,
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

	for {
		msg, err := kc.reader.FetchMessage(ctx)
		if err != nil {
			if errors.Is(err, context.Canceled) || errors.Is(err, io.EOF) {
				kc.logger.Info("kafka consumer stopped")
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

		var event PlatformEvent
		if err := json.Unmarshal(msg.Value, &event); err != nil {
			kc.logger.Error("unmarshal kafka event failed — dead-lettering",
				"error", err, "offset", msg.Offset)
			kc.deadLetter(ctx, msg, "unmarshal: "+err.Error())
			kc.commit(ctx, msg)
			continue
		}
		if event.ID == "" && len(msg.Key) > 0 {
			event.ID = string(msg.Key)
		}
		if event.OccurredAt == "" {
			event.OccurredAt = msg.Time.UTC().Format(time.RFC3339)
		}

		// Synchronous processing: offset is committed only after the forward
		// attempt resolves (at-least-once; Hermes dedupes on idempotency_key).
		if err := kc.processor.processEvent(ctx, event); err != nil {
			kc.logger.Error("event processing failed — dead-lettering",
				"event_id", event.ID, "error", err)
			kc.deadLetter(ctx, msg, err.Error())
		}
		kc.commit(ctx, msg)
	}
}

func (kc *KafkaConsumer) commit(ctx context.Context, msg kafka.Message) {
	if err := kc.reader.CommitMessages(ctx, msg); err != nil && !errors.Is(err, context.Canceled) {
		kc.logger.Error("kafka offset commit failed", "error", err, "offset", msg.Offset)
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
