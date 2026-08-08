package handler

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/whatsapp-commerce/webhook-ingestor/internal/config"
	"github.com/whatsapp-commerce/webhook-ingestor/internal/kafka"
	"github.com/whatsapp-commerce/webhook-ingestor/internal/store"
	"go.uber.org/zap"
)

// ChatwootWebhookPayload represents the inbound Chatwoot webhook body.
type ChatwootWebhookPayload struct {
	Event        string                 `json:"event"`
	ID           int64                  `json:"id"`
	AccountID    int64                  `json:"account_id"`
	MessageType  string                 `json:"message_type"`
	Content      string                 `json:"content"`
	ContentType  string                 `json:"content_type"`
	Conversation ChatwootConversation   `json:"conversation"`
	Sender       ChatwootSender         `json:"sender"`
	Meta         map[string]interface{} `json:"meta"`
}

type ChatwootConversation struct {
	ID          int64  `json:"id"`
	InboxID     int64  `json:"inbox_id"`
	Status      string `json:"status"`
	PhoneNumber string `json:"phone_number,omitempty"`
}

type ChatwootSender struct {
	ID          int64  `json:"id"`
	Name        string `json:"name"`
	PhoneNumber string `json:"phone_number"`
	Type        string `json:"type"`
}

// Handler holds dependencies for webhook processing.
type Handler struct {
	cfg      *config.Config
	db       *store.DB
	producer *kafka.Producer
	logger   *zap.Logger
}

func New(cfg *config.Config, db *store.DB, producer *kafka.Producer, logger *zap.Logger) *Handler {
	return &Handler{cfg: cfg, db: db, producer: producer, logger: logger}
}

// HandleChatwoot processes inbound Chatwoot webhooks.
func (h *Handler) HandleChatwoot(c *gin.Context) {
	tenantSlug := c.Param("tenant_slug")

	rawBody, err := io.ReadAll(c.Request.Body)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "cannot read body"})
		return
	}

	// Resolve tenant by slug
	tenant, err := h.db.GetTenantBySlug(c.Request.Context(), tenantSlug)
	if err != nil {
		h.logger.Warn("tenant not found", zap.String("slug", tenantSlug))
		c.JSON(http.StatusNotFound, gin.H{"error": "tenant not found"})
		return
	}

	// Verify HMAC-SHA256 signature — a missing signature header is rejected;
	// unsigned webhooks are never accepted.
	sig := c.GetHeader("X-Chatwoot-Signature")
	if sig == "" {
		h.logger.Warn("missing chatwoot signature", zap.String("tenant", tenantSlug))
		c.JSON(http.StatusUnauthorized, gin.H{"error": "missing signature"})
		return
	}
	if tenant.WebhookSecret == "" || !verifyHMAC(tenant.WebhookSecret, rawBody, sig) {
		h.logger.Warn("invalid chatwoot signature", zap.String("tenant", tenantSlug))
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid signature"})
		return
	}

	var payload ChatwootWebhookPayload
	if err := json.Unmarshal(rawBody, &payload); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid JSON"})
		return
	}

	// Build idempotency key: tenant + conversation + message
	idempotencyKey := fmt.Sprintf("%s:%d:%d", tenant.ID, payload.Conversation.ID, payload.ID)

	// Check for duplicate delivery
	if h.db.IsProcessed(c.Request.Context(), idempotencyKey) {
		c.JSON(http.StatusOK, gin.H{"status": "duplicate", "idempotency_key": idempotencyKey})
		return
	}

	// Build canonical event envelope
	envelope := map[string]interface{}{
		"id":              uuid.New().String(),
		"tenant_id":       tenant.ID.String(),
		"trace_id":        c.GetHeader("X-Request-ID"),
		"event_type":      "chat.message.received",
		"event_version":   "v1",
		"occurred_at":     time.Now().UTC().Format(time.RFC3339Nano),
		"producer":        "webhook-ingestor",
		"subject":         fmt.Sprintf("conversation:%d", payload.Conversation.ID),
		"idempotency_key": idempotencyKey,
		"payload": map[string]interface{}{
			"chatwoot_message_id":   payload.ID,
			"chatwoot_conv_id":      payload.Conversation.ID,
			"event":                 payload.Event,
			"content":               payload.Content,
			"content_type":          payload.ContentType,
			"sender_phone":          payload.Sender.PhoneNumber,
			"sender_name":           payload.Sender.Name,
			"message_type":          payload.MessageType,
		},
	}

	// Publish to Kafka topic: prd.eu1.chat.message.received.v1
	topic := fmt.Sprintf("chat.message.received.v1")
	if err := h.producer.Publish(c.Request.Context(), topic, tenant.ID.String(), envelope); err != nil {
		h.logger.Error("failed to publish event", zap.Error(err), zap.String("topic", topic))
		c.JSON(http.StatusInternalServerError, gin.H{"error": "event publish failed"})
		return
	}

	// Mark as processed
	h.db.MarkProcessed(c.Request.Context(), idempotencyKey, 24*time.Hour)

	h.logger.Info("chatwoot webhook processed",
		zap.String("tenant", tenantSlug),
		zap.String("event", payload.Event),
		zap.Int64("conv_id", payload.Conversation.ID),
	)

	c.JSON(http.StatusOK, gin.H{"status": "accepted", "idempotency_key": idempotencyKey})
}

// HandleMojaloopCallback handles async payment callbacks from Mojaloop.
// Authentication: the FSPIOP-Signature header must always be present; when
// MOJALOOP_CALLBACK_SECRET is configured it must also be a valid HMAC-SHA256
// of the raw body. In production an unset secret fails closed.
func (h *Handler) HandleMojaloopCallback(c *gin.Context) {
	tenantSlug := c.Param("tenant_slug")
	rawBody, _ := io.ReadAll(c.Request.Body)

	sig := c.GetHeader("FSPIOP-Signature")
	if sig == "" {
		h.logger.Warn("missing FSPIOP-Signature header", zap.String("tenant", tenantSlug))
		c.JSON(http.StatusUnauthorized, gin.H{"error": "missing FSPIOP-Signature header"})
		return
	}
	if h.cfg.MojaloopCallbackSecret != "" {
		if !verifyWebhookSignature(h.cfg.MojaloopCallbackSecret, rawBody, sig) {
			h.logger.Warn("invalid mojaloop callback signature", zap.String("tenant", tenantSlug))
			c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid signature"})
			return
		}
	} else if h.cfg.IsProduction() {
		h.logger.Error("MOJALOOP_CALLBACK_SECRET unset in production — rejecting callback (fail closed)")
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "webhook signature verification not configured"})
		return
	} else {
		h.logger.Warn("MOJALOOP_CALLBACK_SECRET unset — presence check only (dev mode)")
	}

	tenant, err := h.db.GetTenantBySlug(c.Request.Context(), tenantSlug)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "tenant not found"})
		return
	}

	var payload map[string]interface{}
	json.Unmarshal(rawBody, &payload)

	transferID, _ := payload["transferId"].(string)
	idempotencyKey := fmt.Sprintf("mojaloop:%s:%s", tenant.ID, transferID)

	envelope := map[string]interface{}{
		"id":              uuid.New().String(),
		"tenant_id":       tenant.ID.String(),
		"trace_id":        c.GetHeader("X-Request-ID"),
		"event_type":      "payment.mojaloop.callback.received",
		"event_version":   "v1",
		"occurred_at":     time.Now().UTC().Format(time.RFC3339Nano),
		"producer":        "webhook-ingestor",
		"subject":         fmt.Sprintf("transfer:%s", transferID),
		"idempotency_key": idempotencyKey,
		"payload":         payload,
	}

	h.producer.Publish(c.Request.Context(), "payment.mojaloop.callback.received.v1", tenant.ID.String(), envelope)
	c.JSON(http.StatusOK, gin.H{"status": "accepted"})
}

// HandleTwentyWebhook handles CRM change events from Twenty.
// Requires a valid X-Twenty-Signature HMAC when TWENTY_WEBHOOK_SECRET is set;
// fails closed in production when the secret is unset.
func (h *Handler) HandleTwentyWebhook(c *gin.Context) {
	tenantSlug := c.Param("tenant_slug")
	rawBody, _ := io.ReadAll(c.Request.Body)

	if !h.requireWebhookSignature(c, "twenty", h.cfg.TwentyWebhookSecret, c.GetHeader("X-Twenty-Signature"), rawBody) {
		return
	}

	tenant, err := h.db.GetTenantBySlug(c.Request.Context(), tenantSlug)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "tenant not found"})
		return
	}

	var payload map[string]interface{}
	json.Unmarshal(rawBody, &payload)

	envelope := map[string]interface{}{
		"id":            uuid.New().String(),
		"tenant_id":     tenant.ID.String(),
		"event_type":    "crm.twenty.event.received",
		"event_version": "v1",
		"occurred_at":   time.Now().UTC().Format(time.RFC3339Nano),
		"producer":      "webhook-ingestor",
		"payload":       payload,
	}

	h.producer.Publish(c.Request.Context(), "crm.twenty.event.received.v1", tenant.ID.String(), envelope)
	c.JSON(http.StatusOK, gin.H{"status": "accepted"})
}

// HandleOdooWebhook handles ERP/inventory events from Odoo.
// Requires a valid X-Odoo-Signature HMAC when ODOO_WEBHOOK_SECRET is set;
// fails closed in production when the secret is unset.
func (h *Handler) HandleOdooWebhook(c *gin.Context) {
	tenantSlug := c.Param("tenant_slug")
	rawBody, _ := io.ReadAll(c.Request.Body)

	if !h.requireWebhookSignature(c, "odoo", h.cfg.OdooWebhookSecret, c.GetHeader("X-Odoo-Signature"), rawBody) {
		return
	}

	tenant, err := h.db.GetTenantBySlug(c.Request.Context(), tenantSlug)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "tenant not found"})
		return
	}

	var payload map[string]interface{}
	json.Unmarshal(rawBody, &payload)

	envelope := map[string]interface{}{
		"id":            uuid.New().String(),
		"tenant_id":     tenant.ID.String(),
		"event_type":    "erp.odoo.event.received",
		"event_version": "v1",
		"occurred_at":   time.Now().UTC().Format(time.RFC3339Nano),
		"producer":      "webhook-ingestor",
		"payload":       payload,
	}

	h.producer.Publish(c.Request.Context(), "erp.odoo.event.received.v1", tenant.ID.String(), envelope)
	c.JSON(http.StatusOK, gin.H{"status": "accepted"})
}

func verifyHMAC(secret string, payload []byte, signature string) bool {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(payload)
	expected := "sha256=" + hex.EncodeToString(mac.Sum(nil))
	return hmac.Equal([]byte(expected), []byte(signature))
}

// verifyWebhookSignature accepts both "sha256=<hex>" and raw-hex HMAC-SHA256
// signatures and compares them in constant time.
func verifyWebhookSignature(secret string, payload []byte, signature string) bool {
	if signature == "" {
		return false
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(payload)
	sum := hex.EncodeToString(mac.Sum(nil))
	if hmac.Equal([]byte("sha256="+sum), []byte(signature)) {
		return true
	}
	return hmac.Equal([]byte(sum), []byte(signature))
}

// requireWebhookSignature enforces the shared-secret HMAC policy for a webhook
// source. Returns true when the request may proceed; otherwise it writes the
// error response and returns false.
//   - secret set: a valid signature is mandatory.
//   - secret unset: fail closed (503) in production; allow with a warning in dev.
func (h *Handler) requireWebhookSignature(c *gin.Context, source, secret, sig string, body []byte) bool {
	if secret == "" {
		if h.cfg.IsProduction() {
			h.logger.Error("webhook secret unset in production — rejecting (fail closed)", zap.String("source", source))
			c.JSON(http.StatusServiceUnavailable, gin.H{"error": "webhook signature verification not configured"})
			return false
		}
		h.logger.Warn("webhook secret unset — skipping signature verification (dev mode)", zap.String("source", source))
		return true
	}
	if !verifyWebhookSignature(secret, body, sig) {
		h.logger.Warn("invalid webhook signature", zap.String("source", source))
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid signature"})
		return false
	}
	return true
}
