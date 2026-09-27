// WhatsApp Commerce — Go Event Gateway
// Responsibilities: WhatsApp webhook ingestion, signature verification,
// Kafka fan-out, retry with exponential backoff, dead-letter queue.
package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	kafka "github.com/segmentio/kafka-go"
	"github.com/whatsapp-commerce/otelx"
)

// ─── Config ───────────────────────────────────────────────────────────────────
type Config struct {
	Port             string
	KafkaBrokers     string
	WAVerifyToken    string
	WAAppSecret      string
	InboundTopic     string
	OutboundTopic    string
	KYCTopic         string
	MaxRetries       int
	RetryBackoffBase time.Duration
}

func configFromEnv() Config {
	return Config{
		Port:             getEnv("PORT", "8002"),
		KafkaBrokers:     getEnv("KAFKA_BROKERS", "localhost:9092"),
		WAVerifyToken:    getEnv("WA_VERIFY_TOKEN", "dev-verify-token"),
		WAAppSecret:      getEnv("WA_APP_SECRET", "dev-app-secret"),
		InboundTopic:     getEnv("KAFKA_INBOUND_TOPIC", "wa.messages.inbound"),
		OutboundTopic:    getEnv("KAFKA_OUTBOUND_TOPIC", "wa.messages.outbound"),
		KYCTopic:         getEnv("KAFKA_KYC_TOPIC", "kyc.events"),
		MaxRetries:       5,
		RetryBackoffBase: 100 * time.Millisecond,
	}
}

// ─── WhatsApp Message Types ───────────────────────────────────────────────────
type WAWebhookPayload struct {
	Object string    `json:"object"`
	Entry  []WAEntry `json:"entry"`
}

type WAEntry struct {
	ID      string    `json:"id"`
	Changes []WAChange `json:"changes"`
}

type WAChange struct {
	Value WAValue `json:"value"`
	Field string  `json:"field"`
}

type WAValue struct {
	MessagingProduct string      `json:"messaging_product"`
	Metadata         WAMetadata  `json:"metadata"`
	Messages         []WAMessage `json:"messages"`
	Statuses         []WAStatus  `json:"statuses"`
}

type WAMetadata struct {
	DisplayPhoneNumber string `json:"display_phone_number"`
	PhoneNumberID      string `json:"phone_number_id"`
}

type WAMessage struct {
	From      string    `json:"from"`
	ID        string    `json:"id"`
	Timestamp string    `json:"timestamp"`
	Type      string    `json:"type"`
	Text      *WAText   `json:"text,omitempty"`
	Image     *WAMedia  `json:"image,omitempty"`
	Document  *WAMedia  `json:"document,omitempty"`
	Audio     *WAMedia  `json:"audio,omitempty"`
	Location  *WALocation `json:"location,omitempty"`
	Interactive *WAInteractive `json:"interactive,omitempty"`
}

type WAText struct {
	Body string `json:"body"`
}

type WAMedia struct {
	ID       string `json:"id"`
	MimeType string `json:"mime_type"`
	SHA256   string `json:"sha256"`
	Caption  string `json:"caption,omitempty"`
}

type WALocation struct {
	Latitude  float64 `json:"latitude"`
	Longitude float64 `json:"longitude"`
	Name      string  `json:"name,omitempty"`
	Address   string  `json:"address,omitempty"`
}

type WAInteractive struct {
	Type        string              `json:"type"`
	ButtonReply *WAButtonReply      `json:"button_reply,omitempty"`
	ListReply   *WAListReply        `json:"list_reply,omitempty"`
}

type WAButtonReply struct {
	ID    string `json:"id"`
	Title string `json:"title"`
}

type WAListReply struct {
	ID          string `json:"id"`
	Title       string `json:"title"`
	Description string `json:"description,omitempty"`
}

type WAStatus struct {
	ID           string `json:"id"`
	Status       string `json:"status"`
	Timestamp    string `json:"timestamp"`
	RecipientID  string `json:"recipient_id"`
}

// ─── Kafka Event ──────────────────────────────────────────────────────────────
type KafkaEvent struct {
	EventType   string          `json:"event_type"`
	Source      string          `json:"source"`
	Timestamp   time.Time       `json:"timestamp"`
	TraceID     string          `json:"trace_id"`
	Payload     json.RawMessage `json:"payload"`
}

// ─── Gateway ──────────────────────────────────────────────────────────────────
type Gateway struct {
	cfg    Config
	logger *slog.Logger
	writer *kafka.Writer
}

func NewGateway(cfg Config) *Gateway {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	}))
	var writer *kafka.Writer
	if cfg.KafkaBrokers != "" {
		writer = &kafka.Writer{
			Addr:         kafka.TCP(strings.Split(cfg.KafkaBrokers, ",")...),
			Balancer:     &kafka.LeastBytes{},
			RequiredAcks: kafka.RequireOne,
			Async:        false,
			MaxAttempts:  3,
			// PERF-SC-19: coalesce writes into broker batches.
			BatchSize:    100,
			BatchTimeout: 50 * time.Millisecond,
		}
	}
	return &Gateway{cfg: cfg, logger: logger, writer: writer}
}

// verifySignature validates X-Hub-Signature-256 from Meta
func (g *Gateway) verifySignature(body []byte, signature string) bool {
	if len(signature) < 7 {
		return false
	}
	mac := hmac.New(sha256.New, []byte(g.cfg.WAAppSecret))
	mac.Write(body)
	expected := "sha256=" + hex.EncodeToString(mac.Sum(nil))
	return hmac.Equal([]byte(expected), []byte(signature))
}

// publishToKafka publishes an event to Kafka using segmentio/kafka-go
func (g *Gateway) publishToKafka(ctx context.Context, topic string, event KafkaEvent) error {
	data, err := json.Marshal(event)
	if err != nil {
		return fmt.Errorf("marshal event: %w", err)
	}
	if g.writer == nil {
		g.logger.Info("kafka.publish.noop", "topic", topic, "event_type", event.EventType)
		return nil
	}
	err = g.writer.WriteMessages(ctx, kafka.Message{
		Topic: topic,
		Key:   []byte(event.TraceID),
		Value: data,
	})
	if err != nil {
		return fmt.Errorf("kafka write: %w", err)
	}
	g.logger.Info("kafka.published", "topic", topic, "event_type", event.EventType)
	return nil
}

// handleWebhookVerification handles GET /webhook (Meta verification challenge)
func (g *Gateway) handleWebhookVerification(w http.ResponseWriter, r *http.Request) {
	mode := r.URL.Query().Get("hub.mode")
	token := r.URL.Query().Get("hub.verify_token")
	challenge := r.URL.Query().Get("hub.challenge")

	if mode == "subscribe" && token == g.cfg.WAVerifyToken {
		g.logger.Info("webhook.verified")
		w.WriteHeader(http.StatusOK)
		fmt.Fprint(w, challenge)
		return
	}
	g.logger.Warn("webhook.verification_failed", "mode", mode)
	http.Error(w, "Forbidden", http.StatusForbidden)
}

// handleWebhookEvent handles POST /webhook (incoming WhatsApp messages)
func (g *Gateway) handleWebhookEvent(w http.ResponseWriter, r *http.Request) {
	// === W48 sidecars (PERF-SC-19) === bounded body read (was an unbounded
	// manual 4 KiB append-copy loop — OOM vector + O(n²) copying).
	const maxWebhookBody = 4 << 20 // 4 MiB
	body, err := io.ReadAll(io.LimitReader(r.Body, maxWebhookBody))
	if err != nil {
		g.logger.Error("webhook.read_error", "error", err)
		http.Error(w, "Bad request", http.StatusBadRequest)
		return
	}

	// Verify signature
	sig := r.Header.Get("X-Hub-Signature-256")
	if sig != "" && !g.verifySignature(body, sig) {
		g.logger.Warn("webhook.invalid_signature")
		http.Error(w, "Invalid signature", http.StatusUnauthorized)
		return
	}

	var payload WAWebhookPayload
	if err := json.Unmarshal(body, &payload); err != nil {
		g.logger.Error("webhook.parse_error", "error", err)
		http.Error(w, "Bad request", http.StatusBadRequest)
		return
	}

	// Fan out: PERF-SC-19 — collect all events and publish in ONE batched
	// WriteMessages call (was one synchronous WriteMessages per message with
	// writer BatchSize=1 and no linger).
	ctx := r.Context()
	var messages []kafka.Message
	now := time.Now().UTC()
	for _, entry := range payload.Entry {
		for _, change := range entry.Changes {
			for _, msg := range change.Value.Messages {
				rawMsg, _ := json.Marshal(msg)
				event := KafkaEvent{
					EventType: "wa.message.received",
					Source:    "whatsapp-gateway",
					Timestamp: now,
					TraceID:   entry.ID + ":" + msg.ID,
					Payload:   rawMsg,
				}
				if data, err := json.Marshal(event); err == nil {
					messages = append(messages, kafka.Message{
						Topic: g.cfg.InboundTopic, Key: []byte(event.TraceID), Value: data,
					})
				}
			}
			for _, status := range change.Value.Statuses {
				rawStatus, _ := json.Marshal(status)
				event := KafkaEvent{
					EventType: "wa.message.status",
					Source:    "whatsapp-gateway",
					Timestamp: now,
					TraceID:   status.ID,
					Payload:   rawStatus,
				}
				if data, err := json.Marshal(event); err == nil {
					messages = append(messages, kafka.Message{
						Topic: g.cfg.InboundTopic, Key: []byte(event.TraceID), Value: data,
					})
				}
			}
		}
	}

	if len(messages) > 0 {
		if g.writer == nil {
			g.logger.Debug("kafka.publish.noop", "count", len(messages))
		} else if err := g.writer.WriteMessages(ctx, messages...); err != nil {
			// Status-publish failures are LOGGED (were silently swallowed `_ =`).
			g.logger.Error("kafka.batch_publish_failed", "error", err, "count", len(messages))
			http.Error(w, "publish failed — retry", http.StatusServiceUnavailable)
			return
		} else {
			// PERF-SC-19: one log line per webhook batch, not per message.
			g.logger.Info("kafka.batch_published", "topic", g.cfg.InboundTopic, "count", len(messages))
		}
	}

	w.WriteHeader(http.StatusOK)
	fmt.Fprint(w, "OK")
}

// handleHealth returns service health
func (g *Gateway) handleHealth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	fmt.Fprintf(w, `{"status":"ok","service":"event-gateway","version":"1.0.0","time":"%s","otel_enabled":%t}`, time.Now().UTC().Format(time.RFC3339), otelx.Status()) // === W35 otel ===
}

// ─── Main ─────────────────────────────────────────────────────────────────────
func main() {
	cfg := configFromEnv()
	gw := NewGateway(cfg)

	// === W35 otel ===
	otelShutdown, _ := otelx.Init(context.Background(), "event-gateway")
	defer func() { _ = otelShutdown(context.Background()) }()
	// === END W35 otel ===

	mux := http.NewServeMux()
	mux.HandleFunc("GET /webhook", gw.handleWebhookVerification)
	mux.HandleFunc("POST /webhook", gw.handleWebhookEvent)
	mux.HandleFunc("GET /health", gw.handleHealth)

	srv := &http.Server{
		Addr:         ":" + cfg.Port,
		Handler:      otelx.Middleware("event-gateway")(mux), // === W35 otel ===
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 10 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	gw.logger.Info("gateway.starting", "port", cfg.Port, "kafka", cfg.KafkaBrokers)

	go func() {
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			gw.logger.Error("gateway.fatal", "error", err)
			os.Exit(1)
		}
	}()

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	gw.logger.Info("gateway.shutting_down")
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	_ = srv.Shutdown(ctx)
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
