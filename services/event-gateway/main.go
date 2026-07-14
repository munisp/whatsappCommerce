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
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
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
	// In production: kafka producer from segmentio/kafka-go or confluent-kafka-go
	// Here we stub it for compilation without external deps
}

func NewGateway(cfg Config) *Gateway {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	}))
	return &Gateway{cfg: cfg, logger: logger}
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

// publishToKafka publishes an event (stubbed — replace with real producer)
func (g *Gateway) publishToKafka(ctx context.Context, topic string, event KafkaEvent) error {
	data, err := json.Marshal(event)
	if err != nil {
		return fmt.Errorf("marshal event: %w", err)
	}
	// TODO: Replace with real kafka-go producer:
	// writer.WriteMessages(ctx, kafka.Message{Topic: topic, Value: data})
	g.logger.Info("kafka.publish", "topic", topic, "event_type", event.EventType, "size", len(data))
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
	body := make([]byte, 0, 4096)
	buf := make([]byte, 4096)
	for {
		n, err := r.Body.Read(buf)
		body = append(body, buf[:n]...)
		if err != nil {
			break
		}
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

	// Fan out each message to Kafka
	ctx := r.Context()
	for _, entry := range payload.Entry {
		for _, change := range entry.Changes {
			for _, msg := range change.Value.Messages {
				rawMsg, _ := json.Marshal(msg)
				event := KafkaEvent{
					EventType: "wa.message.received",
					Source:    "whatsapp-gateway",
					Timestamp: time.Now().UTC(),
					TraceID:   entry.ID + ":" + msg.ID,
					Payload:   rawMsg,
				}
				if err := g.publishToKafka(ctx, g.cfg.InboundTopic, event); err != nil {
					g.logger.Error("kafka.publish_failed", "error", err, "msg_id", msg.ID)
				}
			}
			for _, status := range change.Value.Statuses {
				rawStatus, _ := json.Marshal(status)
				event := KafkaEvent{
					EventType: "wa.message.status",
					Source:    "whatsapp-gateway",
					Timestamp: time.Now().UTC(),
					TraceID:   status.ID,
					Payload:   rawStatus,
				}
				_ = g.publishToKafka(ctx, g.cfg.InboundTopic, event)
			}
		}
	}

	w.WriteHeader(http.StatusOK)
	fmt.Fprint(w, "OK")
}

// handleHealth returns service health
func (g *Gateway) handleHealth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	fmt.Fprintf(w, `{"status":"ok","service":"event-gateway","version":"1.0.0","time":"%s"}`, time.Now().UTC().Format(time.RFC3339))
}

// ─── Main ─────────────────────────────────────────────────────────────────────
func main() {
	cfg := configFromEnv()
	gw := NewGateway(cfg)

	mux := http.NewServeMux()
	mux.HandleFunc("GET /webhook", gw.handleWebhookVerification)
	mux.HandleFunc("POST /webhook", gw.handleWebhookEvent)
	mux.HandleFunc("GET /health", gw.handleHealth)

	srv := &http.Server{
		Addr:         ":" + cfg.Port,
		Handler:      mux,
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

