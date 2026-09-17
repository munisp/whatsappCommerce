package kafka

import (
	"testing"

	kafkago "github.com/segmentio/kafka-go"
)

// W42 PLT-6: producers must wait for all in-sync replicas — RequireOne meant
// a single-broker ack loss silently dropped payment/ERP webhooks.
func TestWriterRequiresAllAcks(t *testing.T) {
	p, err := NewProducer([]string{"localhost:9092"})
	if err != nil {
		t.Fatalf("NewProducer: %v", err)
	}
	w := p.getWriter("w42.acks.test")
	if w.RequiredAcks != kafkago.RequireAll {
		t.Fatalf("RequiredAcks = %v, want RequireAll", w.RequiredAcks)
	}
	if w.Async {
		t.Fatal("writer must be synchronous so Publish surfaces broker errors")
	}
}
