package kafka

import (
	"context"
	"encoding/json"
	"time"

	kafkago "github.com/segmentio/kafka-go"
)

type Producer struct {
	writers map[string]*kafkago.Writer
	brokers []string
}

func NewProducer(brokers []string) (*Producer, error) {
	return &Producer{
		writers: make(map[string]*kafkago.Writer),
		brokers: brokers,
	}, nil
}

func (p *Producer) Publish(ctx context.Context, topic, key string, payload interface{}) error {
	w := p.getWriter(topic)
	data, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	return w.WriteMessages(ctx, kafkago.Message{
		Key:   []byte(key),
		Value: data,
		Time:  time.Now(),
	})
}

func (p *Producer) getWriter(topic string) *kafkago.Writer {
	if w, ok := p.writers[topic]; ok {
		return w
	}
	w := &kafkago.Writer{
		Addr:     kafkago.TCP(p.brokers...),
		Topic:    topic,
		Balancer: &kafkago.LeastBytes{},
		// W42 PLT-6: RequireOne meant a single-broker ack loss silently
		// dropped payment/ERP webhooks. RequireAll waits for all in-sync
		// replicas so a successful Publish is durably committed.
		RequiredAcks: kafkago.RequireAll,
		Async:        false,
		// === W46 platform-p2 (PLT-24) === auto-topic-creation DISABLED:
		// topics are pre-provisioned out-of-band (see docs/KAFKA_TOPICS.md)
		// so a typo'd topic name fails loudly instead of silently creating a
		// stray topic with default (replication=1) settings. Idempotence
		// note: segmentio/kafka-go's Writer has no enable.idempotence knob
		// (it is not an idempotent producer); exactly-once is instead
		// guaranteed by RequireAll + sync writes (Async:false) + bounded
		// retries, and downstream dedupe via the processed_webhook_events
		// ledger — documented honest choice, matching the KafkaJS producer's
		// idempotent:true in server/kafka.ts.
		AllowAutoTopicCreation: false,
		MaxAttempts:            3,
	}
	p.writers[topic] = w
	return w
}

func (p *Producer) Close() {
	for _, w := range p.writers {
		w.Close()
	}
}

