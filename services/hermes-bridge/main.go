// hermes-bridge — Go service that bridges the WhatsApp Commerce platform with Hermes Agent.
//
// Responsibilities:
//   1. Consume platform events from Kafka (inventory.low_stock, order.placed, fraud.alert)
//   2. Forward events to the Hermes Agent HTTP API for autonomous reasoning
//   3. Receive Hermes callbacks (PO drafts, approval requests) and route them back to the platform
//   4. Handle merchant WhatsApp approval/rejection replies via a dedicated webhook endpoint
//   5. Expose a health/metrics endpoint for observability
//
// Integration points:
//   - Kafka topics: hermes.events.inbound (platform → Hermes), hermes.events.outbound (Hermes → platform)
//   - Hermes Agent HTTP API: POST /api/v1/process (send event), POST /api/v1/webhook (receive callback)
//   - Platform tRPC API: POST /api/trpc/hermes.* (config, approval, status)
//   - WhatsApp Business Cloud API: POST /api/webhooks/whatsapp/send (send approval requests to merchants)

package main

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/google/uuid"
	"github.com/whatsapp-commerce/otelx"
)

// ─── Configuration ────────────────────────────────────────────────────────────

type Config struct {
	Port                   string
	Env                    string  // "production" enables fail-closed behavior
	KafkaBrokers           string
	KafkaGroupID           string
	KafkaInboundTopic      string  // platform → hermes
	KafkaOutboundTopic     string  // hermes → platform
	HermesAgentURL         string  // Hermes Agent HTTP API base URL
	HermesAPIKey           string  // Hermes API key for authentication
	HermesWebhookSecret    string  // HMAC secret for Hermes callbacks (no default — required)
	InternalAPIKey         string  // shared secret for /hermes/approval and /hermes/ingest
	PlatformAPIURL         string  // Platform tRPC/REST API base URL
	PlatformAPIKey         string  // Platform internal API key
	WAPhoneNumberID        string  // WhatsApp Business phone number ID
	WAAccessToken          string  // Meta Graph API access token
	// === W45 go-rust-services ===
	PublicCallbackBaseURL  string  // HERMES_CALLBACK_BASE_URL — public base URL Hermes calls back on (required in production; never localhost)
	RedisURL               string  // REDIS_URL — pending-approval store (required in production)
	ApprovalTemplateName   string  // WA_PO_APPROVAL_TEMPLATE — approved WA template w/ quick-reply buttons
	ApprovalTemplateLang   string  // WA_PO_APPROVAL_TEMPLATE_LANG
	ApprovalTTLMinutes     int     // APPROVAL_TTL_MINUTES — approval expiry
	ApprovalReminderIntervalSeconds int // APPROVAL_REMINDER_INTERVAL_SECONDS
	KafkaDLQTopic          string  // KAFKA_HERMES_DLQ_TOPIC
	// === END W45 go-rust-services ===
	MaxConcurrentEvents    int
	EventTimeoutSeconds    int
	CircuitBreakerThreshold int   // consecutive failures before opening circuit
}

func (c Config) IsProduction() bool { return c.Env == "production" }

func configFromEnv() Config {
	return Config{
		Port:                    getEnv("PORT", "8095"),
		Env:                     getEnv("ENV", getEnv("NODE_ENV", "development")),
		KafkaBrokers:            getEnv("KAFKA_BROKERS", "localhost:9092"),
		KafkaGroupID:            getEnv("KAFKA_GROUP_ID", "hermes-bridge-v1"),
		KafkaInboundTopic:       getEnv("KAFKA_HERMES_INBOUND_TOPIC", "hermes.events.inbound"),
		KafkaOutboundTopic:      getEnv("KAFKA_HERMES_OUTBOUND_TOPIC", "hermes.events.outbound"),
		HermesAgentURL:          getEnv("HERMES_AGENT_URL", "http://localhost:8090"),
		HermesAPIKey:            getEnv("HERMES_API_KEY", ""),
		HermesWebhookSecret:     os.Getenv("HERMES_WEBHOOK_SECRET"), // no default — fail closed
		InternalAPIKey:          os.Getenv("INTERNAL_API_KEY"),
		PlatformAPIURL:          getEnv("PLATFORM_API_URL", "http://localhost:3000"),
		PlatformAPIKey:          getEnv("PLATFORM_API_KEY", ""),
		WAPhoneNumberID:         getEnv("WA_PHONE_NUMBER_ID", ""),
		WAAccessToken:           getEnv("WA_ACCESS_TOKEN", ""),
		// === W45 go-rust-services ===
		PublicCallbackBaseURL:   os.Getenv("HERMES_CALLBACK_BASE_URL"), // no default — validated in validateConfig
		RedisURL:                os.Getenv("REDIS_URL"),
		ApprovalTemplateName:    getEnv("WA_PO_APPROVAL_TEMPLATE", "po_approval_request"),
		ApprovalTemplateLang:    getEnv("WA_PO_APPROVAL_TEMPLATE_LANG", "en"),
		ApprovalTTLMinutes:      getEnvInt("APPROVAL_TTL_MINUTES", 24*60),
		ApprovalReminderIntervalSeconds: getEnvInt("APPROVAL_REMINDER_INTERVAL_SECONDS", 6*3600),
		KafkaDLQTopic:           getEnv("KAFKA_HERMES_DLQ_TOPIC", "hermes.events.dlq"),
		// === END W45 go-rust-services ===
		MaxConcurrentEvents:     getEnvInt("MAX_CONCURRENT_EVENTS", 20),
		EventTimeoutSeconds:     getEnvInt("EVENT_TIMEOUT_SECONDS", 30),
		CircuitBreakerThreshold: getEnvInt("CIRCUIT_BREAKER_THRESHOLD", 5),
	}
}

// ─── Domain Types ─────────────────────────────────────────────────────────────

// PlatformEvent is the canonical event envelope consumed from Kafka.
type PlatformEvent struct {
	ID             string          `json:"id"`
	TenantID       string          `json:"tenant_id"`
	TraceID        string          `json:"trace_id,omitempty"`
	EventType      string          `json:"event_type"`
	EventVersion   string          `json:"event_version"`
	OccurredAt     string          `json:"occurred_at"`
	Producer       string          `json:"producer"`
	IdempotencyKey string          `json:"idempotency_key"`
	Payload        json.RawMessage `json:"payload"`
}

// HermesRequest is sent to the Hermes Agent API.
type HermesRequest struct {
	EventID    string          `json:"event_id"`
	TenantID   string          `json:"tenant_id"`
	EventType  string          `json:"event_type"`
	OccurredAt string          `json:"occurred_at"`
	Payload    json.RawMessage `json:"payload"`
	Context    HermesContext   `json:"context"`
}

type HermesContext struct {
	PlatformAPIURL string `json:"platform_api_url"`
	CallbackURL    string `json:"callback_url"`
	Language       string `json:"language"`
}

// HermesCallback is received from Hermes Agent after processing.
type HermesCallback struct {
	EventID    string          `json:"event_id"`
	TenantID   string          `json:"tenant_id"`
	ActionType string          `json:"action_type"` // po_draft | approval_request | sync_complete | alert
	Payload    json.RawMessage `json:"payload"`
	Signature  string          `json:"signature"`
}

// PODraftPayload is the payload for a purchase order draft action.
type PODraftPayload struct {
	POID          string  `json:"po_id"`
	SupplierName  string  `json:"supplier_name"`
	SupplierEmail string  `json:"supplier_email"`
	SKU           string  `json:"sku"`
	ProductName   string  `json:"product_name"`
	Quantity      int     `json:"quantity"`
	UnitCost      float64 `json:"unit_cost"`
	TotalCost     float64 `json:"total_cost"`
	Currency      string  `json:"currency"`
	MerchantPhone string  `json:"merchant_phone"`
	ApprovalToken string  `json:"approval_token"`
}

// ApprovalReply is sent by the merchant via WhatsApp.
type ApprovalReply struct {
	ApprovalToken string `json:"approval_token"`
	Decision      string `json:"decision"` // approve | reject
	MerchantPhone string `json:"merchant_phone"`
	Note          string `json:"note,omitempty"`
}

// ─── Circuit Breaker ──────────────────────────────────────────────────────────

type CircuitState int32

const (
	CircuitClosed   CircuitState = 0
	CircuitOpen     CircuitState = 1
	CircuitHalfOpen CircuitState = 2
)

type CircuitBreaker struct {
	threshold    int
	failures     atomic.Int32
	state        atomic.Int32
	lastFailTime atomic.Int64
	resetTimeout time.Duration
	mu           sync.Mutex
}

func NewCircuitBreaker(threshold int) *CircuitBreaker {
	cb := &CircuitBreaker{
		threshold:    threshold,
		resetTimeout: 30 * time.Second,
	}
	cb.state.Store(int32(CircuitClosed))
	return cb
}

func (cb *CircuitBreaker) Allow() bool {
	state := CircuitState(cb.state.Load())
	switch state {
	case CircuitClosed:
		return true
	case CircuitOpen:
		// Check if reset timeout has elapsed → transition to half-open
		lastFail := time.Unix(0, cb.lastFailTime.Load())
		if time.Since(lastFail) > cb.resetTimeout {
			cb.state.CompareAndSwap(int32(CircuitOpen), int32(CircuitHalfOpen))
			return true
		}
		return false
	case CircuitHalfOpen:
		return true
	}
	return false
}

func (cb *CircuitBreaker) RecordSuccess() {
	cb.failures.Store(0)
	cb.state.Store(int32(CircuitClosed))
}

func (cb *CircuitBreaker) RecordFailure() {
	cb.lastFailTime.Store(time.Now().UnixNano())
	failures := cb.failures.Add(1)
	if int(failures) >= cb.threshold {
		cb.state.Store(int32(CircuitOpen))
	}
}

func (cb *CircuitBreaker) StateString() string {
	switch CircuitState(cb.state.Load()) {
	case CircuitClosed:
		return "closed"
	case CircuitOpen:
		return "open"
	case CircuitHalfOpen:
		return "half-open"
	}
	return "unknown"
}

// ─── Hermes Client ────────────────────────────────────────────────────────────

type HermesClient struct {
	baseURL        string
	apiKey         string
	httpClient     *http.Client
	circuitBreaker *CircuitBreaker
	logger         *slog.Logger
	processed      atomic.Uint64
	errors         atomic.Uint64
}

func NewHermesClient(cfg Config, logger *slog.Logger) *HermesClient {
	return &HermesClient{
		baseURL: cfg.HermesAgentURL,
		apiKey:  cfg.HermesAPIKey,
		httpClient: &http.Client{
			Timeout: time.Duration(cfg.EventTimeoutSeconds) * time.Second,
		},
		circuitBreaker: NewCircuitBreaker(cfg.CircuitBreakerThreshold),
		logger:         logger,
	}
}

// ForwardEvent sends a platform event to the Hermes Agent API.
func (hc *HermesClient) ForwardEvent(ctx context.Context, req HermesRequest) error {
	if !hc.circuitBreaker.Allow() {
		hc.errors.Add(1)
		return fmt.Errorf("hermes circuit breaker is open — skipping event %s", req.EventID)
	}

	body, err := json.Marshal(req)
	if err != nil {
		return fmt.Errorf("marshal hermes request: %w", err)
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost,
		hc.baseURL+"/api/v1/process", bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("create hermes request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	if hc.apiKey != "" {
		httpReq.Header.Set("Authorization", "Bearer "+hc.apiKey)
	}

	resp, err := hc.httpClient.Do(httpReq)
	if err != nil {
		hc.circuitBreaker.RecordFailure()
		hc.errors.Add(1)
		return fmt.Errorf("hermes http call failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		body, _ := io.ReadAll(resp.Body)
		hc.circuitBreaker.RecordFailure()
		hc.errors.Add(1)
		return fmt.Errorf("hermes returned %d: %s", resp.StatusCode, string(body))
	}

	hc.circuitBreaker.RecordSuccess()
	hc.processed.Add(1)
	return nil
}

// ─── WhatsApp Sender ──────────────────────────────────────────────────────────

type WASender struct {
	phoneNumberID string
	accessToken   string
	templateName  string // === W45 go-rust-services ===
	templateLang  string // === W45 go-rust-services ===
	httpClient    *http.Client
	logger        *slog.Logger
}

func NewWASender(cfg Config, logger *slog.Logger) *WASender {
	return &WASender{
		phoneNumberID: cfg.WAPhoneNumberID,
		accessToken:   cfg.WAAccessToken,
		templateName:  cfg.ApprovalTemplateName,
		templateLang:  cfg.ApprovalTemplateLang,
		httpClient:    &http.Client{Timeout: 15 * time.Second},
		logger:        logger,
	}
}

// === W45 go-rust-services (MSG-15) ===
// SendApprovalRequest sends a PO approval request to the merchant via an
// APPROVED WhatsApp template with quick-reply buttons. Templates are the only
// 24h-window-safe message type — the previous free-form text version failed
// delivery whenever the merchant's customer-service window had lapsed.
//
// Template contract (must exist in Meta Business Manager, default name
// "po_approval_request", language "en"):
//   Body params: {{1}} supplier, {{2}} product, {{3}} sku, {{4}} quantity,
//                {{5}} currency, {{6}} total cost
//   Buttons:     quick_reply "Approve" (payload "APPROVE <token>"),
//                quick_reply "Reject"  (payload "REJECT <token>")
// The button payload round-trips through parseApprovalReply unchanged, so
// both button taps and typed replies resolve the same pending approval.
func (wa *WASender) SendApprovalRequest(ctx context.Context, po PODraftPayload) error {
	if wa.phoneNumberID == "" || wa.accessToken == "" {
		wa.logger.Warn("whatsapp credentials not configured — skipping approval send",
			"po_id", po.POID)
		return nil
	}

	textParam := func(v string) map[string]string {
		return map[string]string{"type": "text", "text": v}
	}
	payloadParam := func(v string) map[string]string {
		return map[string]string{"type": "payload", "payload": v}
	}
	payload := map[string]interface{}{
		"messaging_product": "whatsapp",
		"to":                po.MerchantPhone,
		"type":              "template",
		"template": map[string]interface{}{
			"name":     wa.templateName,
			"language": map[string]string{"code": wa.templateLang},
			"components": []map[string]interface{}{
				{
					"type": "body",
					"parameters": []map[string]string{
						textParam(po.SupplierName),
						textParam(po.ProductName),
						textParam(po.SKU),
						textParam(strconv.Itoa(po.Quantity)),
						textParam(po.Currency),
						textParam(fmt.Sprintf("%.2f", po.TotalCost)),
					},
				},
				{
					"type":      "button",
					"sub_type":  "quick_reply",
					"index":     "0",
					"parameters": []map[string]string{payloadParam("APPROVE " + po.ApprovalToken)},
				},
				{
					"type":      "button",
					"sub_type":  "quick_reply",
					"index":     "1",
					"parameters": []map[string]string{payloadParam("REJECT " + po.ApprovalToken)},
				},
			},
		},
	}

	body, _ := json.Marshal(payload)
	url := fmt.Sprintf("https://graph.facebook.com/v20.0/%s/messages", wa.phoneNumberID)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+wa.accessToken)

	resp, err := wa.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("whatsapp send failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		b, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("whatsapp api %d: %s", resp.StatusCode, string(b))
	}

	wa.logger.Info("po approval request sent via whatsapp",
		"po_id", po.POID, "merchant_phone", po.MerchantPhone)
	return nil
}

// ─── Platform Notifier ────────────────────────────────────────────────────────

type PlatformNotifier struct {
	baseURL    string
	apiKey     string
	httpClient *http.Client
	logger     *slog.Logger
}

func NewPlatformNotifier(cfg Config, logger *slog.Logger) *PlatformNotifier {
	return &PlatformNotifier{
		baseURL:    cfg.PlatformAPIURL,
		apiKey:     cfg.PlatformAPIKey,
		httpClient: &http.Client{Timeout: 15 * time.Second},
		logger:     logger,
	}
}

// NotifyPODecision sends the merchant's PO decision back to the platform.
func (pn *PlatformNotifier) NotifyPODecision(ctx context.Context, reply ApprovalReply) error {
	body, _ := json.Marshal(reply)
	url := pn.baseURL + "/api/hermes/po-decision"

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if pn.apiKey != "" {
		req.Header.Set("X-Internal-Key", pn.apiKey)
	}

	resp, err := pn.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("platform notify failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		b, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("platform api %d: %s", resp.StatusCode, string(b))
	}
	return nil
}

// ─── Event Processor ─────────────────────────────────────────────────────────

// Supported event types that are forwarded to Hermes.
var hermesEventTypes = map[string]bool{
	"inventory.low_stock":      true,
	"inventory.out_of_stock":   true,
	"order.placed":             true,
	"order.high_value":         true,
	"fraud.alert":              true,
	"payment.failed":           true,
	"customer.complaint":       true,
	"supplier.delivery_delay":  true,
}

type EventProcessor struct {
	cfg       Config
	hermes    *HermesClient
	waSender  *WASender
	platform  *PlatformNotifier
	logger    *slog.Logger
	semaphore chan struct{}
	// === W45 go-rust-services (MSG-15) ===
	// Durable pending-approval store (Redis in production) — replaces the old
	// restart-lossy in-process pendingApprovals map.
	approvals ApprovalStore
}

func NewEventProcessor(cfg Config, logger *slog.Logger) (*EventProcessor, error) {
	approvals, err := NewApprovalStore(cfg, logger)
	if err != nil {
		return nil, fmt.Errorf("approval store: %w", err)
	}
	return &EventProcessor{
		cfg:       cfg,
		hermes:    NewHermesClient(cfg, logger),
		waSender:  NewWASender(cfg, logger),
		platform:  NewPlatformNotifier(cfg, logger),
		logger:    logger,
		semaphore: make(chan struct{}, cfg.MaxConcurrentEvents),
		approvals: approvals,
	}, nil
}

// callbackURL builds the public URL Hermes Agent calls back on.
// The base comes from HERMES_CALLBACK_BASE_URL (validated at startup —
// fail-closed in production so Hermes never receives an unreachable
// localhost callback); development may use the per-port fallback with a
// loud warning.
func (ep *EventProcessor) callbackURL() string {
	base := ep.cfg.PublicCallbackBaseURL
	if base == "" {
		ep.logger.Warn("HERMES_CALLBACK_BASE_URL not set — using localhost callback (dev only, unreachable from Hermes outside this host)")
		base = fmt.Sprintf("http://localhost:%s", ep.cfg.Port)
	}
	return strings.TrimRight(base, "/") + "/hermes/callback"
}

// ProcessEvent handles a single platform event from Kafka.
func (ep *EventProcessor) ProcessEvent(ctx context.Context, event PlatformEvent) {
	if !hermesEventTypes[event.EventType] {
		return // not a Hermes-relevant event
	}

	ep.semaphore <- struct{}{}
	go func() {
		defer func() { <-ep.semaphore }()
		if err := ep.processEvent(ctx, event); err != nil {
			ep.logger.Error("failed to forward event to hermes",
				"event_id", event.ID,
				"event_type", event.EventType,
				"error", err)
		}
	}()
}

// === W45 go-rust-services (MSG-20) ===
// processEvent is the synchronous forward path used by the real Kafka
// consumer (kafka.go): the consumer commits the offset only after this
// returns nil. The async HTTP-ingest path (ProcessEvent above) shares it.
func (ep *EventProcessor) processEvent(ctx context.Context, event PlatformEvent) error {
	req := HermesRequest{
		EventID:    event.ID,
		TenantID:   event.TenantID,
		EventType:  event.EventType,
		OccurredAt: event.OccurredAt,
		Payload:    event.Payload,
		Context: HermesContext{
			PlatformAPIURL: ep.cfg.PlatformAPIURL,
			CallbackURL:    ep.callbackURL(),
			Language:       "en", // TODO: derive from tenant config
		},
	}

	if err := ep.hermes.ForwardEvent(ctx, req); err != nil {
		return err
	}

	ep.logger.Info("event forwarded to hermes",
		"event_id", event.ID,
		"event_type", event.EventType,
		"tenant_id", event.TenantID)
	return nil
}

// HandleCallback processes a callback from Hermes Agent.
func (ep *EventProcessor) HandleCallback(ctx context.Context, cb HermesCallback) error {
	ep.logger.Info("received hermes callback",
		"event_id", cb.EventID,
		"action_type", cb.ActionType,
		"tenant_id", cb.TenantID)

	switch cb.ActionType {
	case "po_draft":
		var po PODraftPayload
		if err := json.Unmarshal(cb.Payload, &po); err != nil {
			return fmt.Errorf("unmarshal po_draft payload: %w", err)
		}
		// === W45 go-rust-services (MSG-15) ===
		// Persist the pending approval (durable, with TTL) BEFORE notifying
		// the merchant — if the send fails the sweep still tracks expiry.
		if err := ep.approvals.Save(ctx, po, time.Duration(ep.cfg.ApprovalTTLMinutes)*time.Minute); err != nil {
			return fmt.Errorf("persist pending approval: %w", err)
		}
		// Send WhatsApp approval request (approved template w/ buttons) to merchant
		return ep.waSender.SendApprovalRequest(ctx, po)

	case "approval_request":
		// Generic approval request (non-PO) — forward to platform
		return ep.platform.NotifyPODecision(ctx, ApprovalReply{
			ApprovalToken: cb.EventID,
			Decision:      "pending",
		})

	case "sync_complete":
		ep.logger.Info("hermes sync completed", "event_id", cb.EventID)
		return nil

	case "alert":
		ep.logger.Warn("hermes alert received", "event_id", cb.EventID, "payload", string(cb.Payload))
		return nil

	default:
		ep.logger.Warn("unknown hermes action type", "action_type", cb.ActionType)
		return nil
	}
}

// HandleMerchantApproval processes a merchant's WhatsApp approval/rejection reply.
// === W45 go-rust-services (MSG-15) ===
func (ep *EventProcessor) HandleMerchantApproval(ctx context.Context, reply ApprovalReply) error {
	po, err := ep.approvals.Get(ctx, reply.ApprovalToken)
	if err != nil {
		if err == ErrApprovalNotFound {
			return fmt.Errorf("approval token not found (unknown or expired): %s", reply.ApprovalToken)
		}
		return fmt.Errorf("load approval: %w", err)
	}

	ep.logger.Info("merchant approval received",
		"po_id", po.POID,
		"decision", reply.Decision,
		"merchant_phone", reply.MerchantPhone)

	// Remove from pending store (decision reached — sweep stops tracking it)
	if err := ep.approvals.Delete(ctx, reply.ApprovalToken); err != nil {
		ep.logger.Error("failed to delete decided approval", "token", reply.ApprovalToken, "error", err)
	}

	// Notify platform
	return ep.platform.NotifyPODecision(ctx, reply)
}

// ─── HTTP Handlers ────────────────────────────────────────────────────────────

type Server struct {
	cfg       Config
	processor *EventProcessor
	logger    *slog.Logger
	startTime time.Time
}

func NewServer(cfg Config, processor *EventProcessor, logger *slog.Logger) *Server {
	return &Server{cfg: cfg, processor: processor, logger: logger, startTime: time.Now()}
}

// validateHermesSignature verifies the HMAC-SHA256 signature on Hermes callbacks.
// The secret has no default: when HERMES_WEBHOOK_SECRET is unset the callback
// is always rejected (fail closed).
func (s *Server) validateHermesSignature(body []byte, signature string) bool {
	if s.cfg.HermesWebhookSecret == "" {
		s.logger.Error("HERMES_WEBHOOK_SECRET is not configured — rejecting callback (fail closed)")
		return false
	}
	if signature == "" {
		return false
	}
	mac := hmac.New(sha256.New, []byte(s.cfg.HermesWebhookSecret))
	mac.Write(body)
	expected := "sha256=" + hex.EncodeToString(mac.Sum(nil))
	return hmac.Equal([]byte(expected), []byte(signature))
}

// requireInternalToken is middleware for service-to-service endpoints
// (/hermes/approval, /hermes/ingest). It requires the X-Internal-Token header
// to match INTERNAL_API_KEY. When the key is unset it fails closed in
// production and warns (fail open) in development.
func (s *Server) requireInternalToken(next http.Handler) http.Handler {
	if s.cfg.InternalAPIKey == "" {
		if s.cfg.IsProduction() {
			s.logger.Error("INTERNAL_API_KEY is not set — internal endpoints will reject all requests (fail closed)")
		} else {
			s.logger.Warn("INTERNAL_API_KEY is not set — /hermes/approval and /hermes/ingest are unauthenticated (dev mode)")
		}
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if s.cfg.InternalAPIKey == "" {
			if s.cfg.IsProduction() {
				http.Error(w, "internal authentication not configured", http.StatusServiceUnavailable)
				return
			}
			next.ServeHTTP(w, r)
			return
		}
		token := r.Header.Get("X-Internal-Token")
		if subtle.ConstantTimeCompare([]byte(token), []byte(s.cfg.InternalAPIKey)) != 1 {
			s.logger.Warn("invalid internal token", "path", r.URL.Path, "remote_addr", r.RemoteAddr)
			http.Error(w, "invalid internal token", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	resp := map[string]interface{}{
		"status":          "ok",
		"service":         "hermes-bridge",
		"otel_enabled":    otelx.Status(), // === W35 otel ===
		"uptime_seconds":  time.Since(s.startTime).Seconds(),
		"circuit_breaker": s.processor.hermes.circuitBreaker.StateString(),
		"approval_store":   s.processor.approvals.Backend(), // === W45 go-rust-services ===
		"events_processed": s.processor.hermes.processed.Load(),
		"events_errored":   s.processor.hermes.errors.Load(),
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

// handleHermesCallback receives callbacks from Hermes Agent.
func (s *Server) handleHermesCallback(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		http.Error(w, "read body failed", http.StatusBadRequest)
		return
	}

	sig := r.Header.Get("X-Hermes-Signature")
	if !s.validateHermesSignature(body, sig) {
		s.logger.Warn("invalid hermes callback signature", "remote_addr", r.RemoteAddr)
		http.Error(w, "invalid signature", http.StatusUnauthorized)
		return
	}

	var cb HermesCallback
	if err := json.Unmarshal(body, &cb); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}

	if err := s.processor.HandleCallback(r.Context(), cb); err != nil {
		s.logger.Error("hermes callback processing failed", "error", err)
		http.Error(w, "processing failed", http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{"status": "accepted"})
}

// handleMerchantApproval receives PO approval/rejection from the platform
// (triggered when a merchant replies via WhatsApp).
func (s *Server) handleMerchantApproval(w http.ResponseWriter, r *http.Request) {
	var reply ApprovalReply
	if err := json.NewDecoder(r.Body).Decode(&reply); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}

	if reply.ApprovalToken == "" || (reply.Decision != "approve" && reply.Decision != "reject") {
		http.Error(w, "approval_token and decision (approve|reject) required", http.StatusBadRequest)
		return
	}

	if err := s.processor.HandleMerchantApproval(r.Context(), reply); err != nil {
		s.logger.Error("merchant approval processing failed", "error", err)
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{"status": "processed"})
}

// handleIngestEvent allows the platform to push events directly (HTTP fallback for Kafka).
func (s *Server) handleIngestEvent(w http.ResponseWriter, r *http.Request) {
	var event PlatformEvent
	if err := json.NewDecoder(r.Body).Decode(&event); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}

	if event.ID == "" {
		event.ID = uuid.New().String()
	}
	if event.OccurredAt == "" {
		event.OccurredAt = time.Now().UTC().Format(time.RFC3339)
	}

	s.processor.ProcessEvent(r.Context(), event)
	w.WriteHeader(http.StatusAccepted)
	json.NewEncoder(w).Encode(map[string]string{"status": "accepted", "event_id": event.ID})
}

func (s *Server) routes() http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	r.Use(middleware.RealIP)
	r.Use(middleware.Recoverer)
	r.Use(middleware.Timeout(60 * time.Second))

	r.Get("/health", s.handleHealth)
	r.Post("/hermes/callback", s.handleHermesCallback)
	// Service-to-service endpoints require the X-Internal-Token shared secret.
	r.With(s.requireInternalToken).Post("/hermes/approval", s.handleMerchantApproval)
	r.With(s.requireInternalToken).Post("/hermes/ingest", s.handleIngestEvent)

	return r
}

// ─── Main ─────────────────────────────────────────────────────────────────────

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	}))
	slog.SetDefault(logger)

	cfg := configFromEnv()
	// === W45 go-rust-services ===
	if err := validateConfig(cfg); err != nil {
		logger.Error("invalid configuration", "error", err)
		os.Exit(1)
	}

	// === W35 otel ===
	otelShutdown, _ := otelx.Init(context.Background(), "hermes-bridge")
	defer func() { _ = otelShutdown(context.Background()) }()
	// === END W35 otel ===

	logger.Info("hermes-bridge starting",
		"port", cfg.Port,
		"hermes_url", cfg.HermesAgentURL,
		"kafka_brokers", cfg.KafkaBrokers)

	processor, err := NewEventProcessor(cfg, logger)
	if err != nil {
		logger.Error("failed to initialise event processor", "error", err)
		os.Exit(1)
	}

	// Start Kafka consumer + approval sweep
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// === W45 go-rust-services ===
	consumer := NewKafkaConsumer(cfg, processor, logger)
	go consumer.Start(ctx)
	go processor.StartApprovalSweep(ctx)

	// Start HTTP server
	srv := NewServer(cfg, processor, logger)
	httpServer := &http.Server{
		Addr:         ":" + cfg.Port,
		Handler:      otelx.Middleware("hermes-bridge")(srv.routes()), // === W35 otel ===
		ReadTimeout:  30 * time.Second,
		WriteTimeout: 30 * time.Second,
		IdleTimeout:  120 * time.Second,
	}

	go func() {
		logger.Info("http server listening", "addr", httpServer.Addr)
		if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			logger.Error("http server failed", "error", err)
			os.Exit(1)
		}
	}()

	// Graceful shutdown
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	logger.Info("shutting down hermes-bridge...")
	cancel()

	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer shutdownCancel()
	if err := httpServer.Shutdown(shutdownCtx); err != nil {
		logger.Error("http server shutdown error", "error", err)
	}
	logger.Info("hermes-bridge stopped")
}

// === W45 go-rust-services ===
// validateConfig enforces production-critical configuration at startup.
// HERMES_CALLBACK_BASE_URL must be an absolute http(s) URL reachable by the
// Hermes Agent — never a loopback host. In development the localhost fallback
// is allowed (with a warning in callbackURL()) so local runs still boot.
func validateConfig(cfg Config) error {
	if cfg.PublicCallbackBaseURL == "" {
		if cfg.IsProduction() {
			return fmt.Errorf("HERMES_CALLBACK_BASE_URL is required in production (public base URL for Hermes callbacks)")
		}
		return nil
	}
	u, err := url.Parse(cfg.PublicCallbackBaseURL)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return fmt.Errorf("HERMES_CALLBACK_BASE_URL must be an absolute URL (got %q)", cfg.PublicCallbackBaseURL)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return fmt.Errorf("HERMES_CALLBACK_BASE_URL must use http(s) scheme (got %q)", u.Scheme)
	}
	host := u.Hostname()
	if host == "localhost" || host == "127.0.0.1" || host == "::1" {
		if cfg.IsProduction() {
			return fmt.Errorf("HERMES_CALLBACK_BASE_URL must not be a loopback host in production (got %q)", host)
		}
	}
	return nil
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func getEnvInt(key string, fallback int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return fallback
}

// parseApprovalReply parses a merchant's WhatsApp text reply like "APPROVE abc123" or "REJECT abc123".
func parseApprovalReply(text string) (decision, token string, ok bool) {
	parts := strings.Fields(strings.ToUpper(strings.TrimSpace(text)))
	if len(parts) < 2 {
		return "", "", false
	}
	switch parts[0] {
	case "APPROVE":
		return "approve", strings.ToLower(parts[1]), true
	case "REJECT":
		return "reject", strings.ToLower(parts[1]), true
	}
	return "", "", false
}

// init registers parseApprovalReply as used (avoids "declared and not used" error).
var _ = parseApprovalReply
