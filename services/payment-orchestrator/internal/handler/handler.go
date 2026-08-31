package handler

import (
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	// === W35 otel ===
	"github.com/whatsapp-commerce/otelx"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"
	// === END W35 otel ===
	"github.com/whatsapp-commerce/payment-orchestrator/internal/config"
	"github.com/whatsapp-commerce/payment-orchestrator/internal/store"
	"go.uber.org/zap"
)

// StatusLedgerDrift marks intents whose provider-side flow finished but whose
// ledger commit/void could not be confirmed after retries. Reconciliation
// must repair these; they are never reported as completed.
const StatusLedgerDrift = "ledger_drift"

type Handler struct {
	cfg    *config.Config
	db     *store.DB
	logger *zap.Logger
	client *http.Client
}

func New(cfg *config.Config, db *store.DB, logger *zap.Logger) *Handler {
	return &Handler{
		cfg:    cfg,
		db:     db,
		logger: logger,
		client: &http.Client{Timeout: 30 * time.Second},
	}
}

var authWarned atomic.Bool

// AuthMiddleware requires the X-Internal-Token header to match
// PAYMENT_ORCHESTRATOR_INTERNAL_TOKEN on every route except /health.
// When the token is unset it FAILS CLOSED outside development.
func AuthMiddleware(cfg *config.Config, logger *zap.Logger) gin.HandlerFunc {
	return func(c *gin.Context) {
		if c.FullPath() == "/health" || c.Request.URL.Path == "/health" {
			c.Next()
			return
		}
		if cfg.InternalToken == "" {
			if !cfg.IsDev() {
				logger.Error("PAYMENT_ORCHESTRATOR_INTERNAL_TOKEN is not configured — refusing request (fail closed)")
				c.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{"error": "auth_not_configured"})
				return
			}
			if authWarned.CompareAndSwap(false, true) {
				logger.Warn("PAYMENT_ORCHESTRATOR_INTERNAL_TOKEN unset — allowing unauthenticated requests (development mode only)")
			}
			c.Next()
			return
		}
		presented := c.GetHeader("X-Internal-Token")
		if subtle.ConstantTimeCompare([]byte(presented), []byte(cfg.InternalToken)) != 1 {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "invalid_internal_token"})
			return
		}
		c.Next()
	}
}

// parseUUID parses s as a UUID, writing a 400 response and returning ok=false
// on failure. Bad identifiers must never silently become the zero UUID.
func parseUUID(c *gin.Context, s, field string) (uuid.UUID, bool) {
	id, err := uuid.Parse(s)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("invalid %s: must be a UUID", field)})
		return uuid.Nil, false
	}
	return id, true
}

// InitiatePayment creates a payment intent and dispatches to the appropriate provider.
// Implements the two-phase commit pattern:
//  1. Create a PENDING ledger entry in TigerBeetle (via ledger-bridge)
//  2. Initiate the transfer with the provider
//  3. Await async callback to COMMIT or VOID
//
// Any failure after a successful reserve voids the reservation (with retries)
// before the intent is marked failed — funds are never left locked.
func (h *Handler) InitiatePayment(c *gin.Context) {
	tenantID, ok := parseUUID(c, c.GetHeader("X-Tenant-ID"), "X-Tenant-ID")
	if !ok {
		return
	}
	idempotencyKey := c.GetHeader("X-Idempotency-Key")
	if idempotencyKey == "" {
		idempotencyKey = uuid.New().String()
	}

	var req struct {
		OrderID     string  `json:"order_id" binding:"required"`
		CustomerID  string  `json:"customer_id" binding:"required"`
		Amount      float64 `json:"amount" binding:"required,gt=0"`
		Currency    string  `json:"currency" binding:"required"`
		Provider    string  `json:"provider"` // "mojaloop" | "stripe"
		PhoneNumber string  `json:"phone_number"` // for Mojaloop MSISDN lookup
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	orderID, ok := parseUUID(c, req.OrderID, "order_id")
	if !ok {
		return
	}
	customerID, ok := parseUUID(c, req.CustomerID, "customer_id")
	if !ok {
		return
	}

	provider := req.Provider
	if provider == "" {
		provider = "mojaloop"
	}

	intent := store.PaymentIntentRow{
		ID:             uuid.New(),
		TenantID:       tenantID,
		OrderID:        orderID,
		CustomerID:     customerID,
		Status:         "pending",
		Amount:         req.Amount,
		Currency:       req.Currency,
		Provider:       provider,
		WorkflowID:     uuid.New().String(),
		IdempotencyKey: idempotencyKey,
		CreatedAt:      time.Now(),
		UpdatedAt:      time.Now(),
	}

	created, err := h.db.CreatePaymentIntent(c.Request.Context(), intent)
	if err != nil {
		h.logger.Error("create payment intent failed", zap.Error(err))
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create payment intent"})
		return
	}
	if !created {
		// Idempotency-Key replay: return the EXISTING intent instead of
		// initiating (and charging) a second time.
		existing, err := h.db.GetPaymentIntentByIdempotencyKey(c.Request.Context(), tenantID, idempotencyKey)
		if err != nil {
			h.logger.Error("idempotency replay lookup failed", zap.Error(err))
			c.JSON(http.StatusInternalServerError, gin.H{"error": "idempotency conflict but existing intent unavailable"})
			return
		}
		c.JSON(http.StatusOK, gin.H{
			"payment_intent_id": existing.ID,
			"status":            existing.Status,
			"provider":          existing.Provider,
			"workflow_id":       existing.WorkflowID,
			"idempotent_replay": true,
		})
		return
	}

	// Phase 1: Reserve funds in TigerBeetle ledger. A reserve failure ABORTS
	// the payment — proceeding without a ledger reservation would create
	// untracked money movement that commit/void can never settle.
	if h.cfg.LedgerBridgeURL != "" {
		pendingID, err := h.reserveLedger(c.Request.Context(), intent)
		if err != nil {
			h.logger.Error("ledger reservation failed; aborting payment", zap.Error(err))
			h.setStatus(c, intent.ID, "failed", "ledger reserve failed: "+err.Error())
			c.JSON(http.StatusBadGateway, gin.H{"error": "ledger reservation failed", "detail": err.Error()})
			return
		}
		intent.TigerBeetlePendingID = pendingID
		if err := h.db.SetLedgerPendingID(c.Request.Context(), intent.ID, pendingID); err != nil {
			h.logger.Error("failed to persist ledger pending id", zap.Error(err))
		}
	}

	// Phase 2: Initiate provider transfer. On ANY failure after a successful
	// reserve, void the reservation (with retry) before marking failed.
	var paymentURL string
	switch provider {
	case "mojaloop":
		transferID, url, err := h.initiateMojaloop(c.Request.Context(), intent, req.PhoneNumber)
		if err != nil {
			h.voidAfterFailure(c, intent, "mojaloop initiation failed: "+err.Error())
			c.JSON(http.StatusBadGateway, gin.H{"error": "payment initiation failed", "detail": err.Error()})
			return
		}
		intent.MojaloopTransferID = transferID
		if err := h.db.SetProviderReference(c.Request.Context(), intent.ID, transferID); err != nil {
			h.logger.Error("failed to persist mojaloop transfer id", zap.Error(err))
		}
		paymentURL = url
	case "stripe":
		providerRef, url, err := h.initiateStripe(c.Request.Context(), intent)
		if err != nil {
			h.voidAfterFailure(c, intent, "stripe initiation failed: "+err.Error())
			c.JSON(http.StatusBadGateway, gin.H{"error": "payment initiation failed", "detail": err.Error()})
			return
		}
		if providerRef != "" {
			if err := h.db.SetProviderReference(c.Request.Context(), intent.ID, providerRef); err != nil {
				h.logger.Error("failed to persist stripe reference", zap.Error(err))
			}
		}
		paymentURL = url
	default:
		h.voidAfterFailure(c, intent, "unsupported payment provider: "+provider)
		c.JSON(http.StatusBadRequest, gin.H{"error": "unsupported payment provider: " + provider})
		return
	}

	h.setStatus(c, intent.ID, "initiated", "")

	h.logger.Info("payment initiated",
		zap.String("intent_id", intent.ID.String()),
		zap.String("provider", provider),
		zap.Float64("amount", req.Amount),
		zap.String("currency", req.Currency),
	)

	c.JSON(http.StatusCreated, gin.H{
		"payment_intent_id": intent.ID,
		"status":            "initiated",
		"provider":          provider,
		"payment_url":       paymentURL,
		"workflow_id":       intent.WorkflowID,
	})
}

// voidAfterFailure voids the ledger reservation (with retries) after a
// post-reserve failure, then marks the intent failed — or ledger_drift when
// even the void could not be confirmed.
func (h *Handler) voidAfterFailure(c *gin.Context, intent store.PaymentIntentRow, reason string) {
	if intent.TigerBeetlePendingID != "" {
		if err := h.voidLedgerWithRetry(c.Request.Context(), intent.TigerBeetlePendingID); err != nil {
			h.logger.Error("void after failure failed; marking ledger_drift",
				zap.String("intent_id", intent.ID.String()), zap.Error(err))
			h.setStatus(c, intent.ID, StatusLedgerDrift, reason+"; void failed: "+err.Error())
			return
		}
	}
	h.setStatus(c, intent.ID, "failed", reason)
}

// setStatus applies a guarded status transition, logging (but not masking)
// invalid-transition errors.
func (h *Handler) setStatus(c *gin.Context, id uuid.UUID, status, reason string) {
	if err := h.db.UpdatePaymentStatus(c.Request.Context(), id, status, reason); err != nil {
		h.logger.Error("status transition rejected",
			zap.String("intent_id", id.String()), zap.String("target", status), zap.Error(err))
	}
}

func (h *Handler) GetPaymentStatus(c *gin.Context) {
	tenantID, ok := parseUUID(c, c.GetHeader("X-Tenant-ID"), "X-Tenant-ID")
	if !ok {
		return
	}
	id, ok := parseUUID(c, c.Param("id"), "payment id")
	if !ok {
		return
	}
	intent, err := h.db.GetPaymentIntent(c.Request.Context(), tenantID, id)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "payment intent not found"})
		return
	}
	c.JSON(http.StatusOK, intent)
}

// RefundPayment performs a REAL refund: a provider refund call (where the
// provider supports one) plus a compensating ledger reversal. The intent is
// only marked refunded after the compensation succeeds. Mojaloop has no
// refund API, so the intent is marked refund_pending and an event is emitted
// for the platform to process the payout.
func (h *Handler) RefundPayment(c *gin.Context) {
	tenantID, ok := parseUUID(c, c.GetHeader("X-Tenant-ID"), "X-Tenant-ID")
	if !ok {
		return
	}
	id, ok := parseUUID(c, c.Param("id"), "payment id")
	if !ok {
		return
	}
	intent, err := h.db.GetPaymentIntent(c.Request.Context(), tenantID, id)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "payment intent not found"})
		return
	}
	if intent.Status != "completed" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "can only refund completed payments", "status": intent.Status})
		return
	}

	// Step 1: provider-side refund.
	switch intent.Provider {
	case "paystack":
		if err := h.refundPaystack(c.Request.Context(), intent); err != nil {
			h.logger.Error("paystack refund failed", zap.Error(err))
			c.JSON(http.StatusBadGateway, gin.H{"error": "provider refund failed", "detail": err.Error()})
			return
		}
	case "flutterwave":
		if err := h.refundFlutterwave(c.Request.Context(), intent); err != nil {
			h.logger.Error("flutterwave refund failed", zap.Error(err))
			c.JSON(http.StatusBadGateway, gin.H{"error": "provider refund failed", "detail": err.Error()})
			return
		}
	case "stripe":
		if err := h.refundStripe(c.Request.Context(), intent); err != nil {
			h.logger.Error("stripe refund failed", zap.Error(err))
			c.JSON(http.StatusBadGateway, gin.H{"error": "provider refund failed", "detail": err.Error()})
			return
		}
	case "mojaloop":
		// No Mojaloop refund API — park in refund_pending and notify the platform.
		if err := h.emitRefundEvent(c.Request.Context(), intent); err != nil {
			h.logger.Error("refund event emission failed", zap.Error(err))
			c.JSON(http.StatusBadGateway, gin.H{"error": "failed to emit refund request event", "detail": err.Error()})
			return
		}
		h.setStatus(c, id, "refund_pending", "mojaloop refund requires manual/platform payout")
		c.JSON(http.StatusAccepted, gin.H{"status": "refund_pending", "payment_intent_id": id})
		return
	default:
		c.JSON(http.StatusBadRequest, gin.H{"error": "refunds not supported for provider: " + intent.Provider})
		return
	}

	// Step 2: compensating ledger reversal. Only after this succeeds may the
	// intent become refunded.
	if intent.TigerBeetlePendingID != "" {
		if err := h.reverseLedgerWithRetry(c.Request.Context(), intent.TigerBeetlePendingID); err != nil {
			h.logger.Error("ledger reversal failed after provider refund; marking refund_pending",
				zap.String("intent_id", id.String()), zap.Error(err))
			h.setStatus(c, id, "refund_pending", "provider refunded; ledger reversal failed: "+err.Error())
			c.JSON(http.StatusBadGateway, gin.H{
				"error":  "ledger compensation failed after provider refund",
				"detail": err.Error(),
				"status": "refund_pending",
			})
			return
		}
	}

	h.setStatus(c, id, "refunded", "customer_request")
	c.JSON(http.StatusOK, gin.H{"status": "refunded", "payment_intent_id": id})
}

func (h *Handler) VoidPayment(c *gin.Context) {
	tenantID, ok := parseUUID(c, c.GetHeader("X-Tenant-ID"), "X-Tenant-ID")
	if !ok {
		return
	}
	id, ok := parseUUID(c, c.Param("id"), "payment id")
	if !ok {
		return
	}
	intent, err := h.db.GetPaymentIntent(c.Request.Context(), tenantID, id)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "payment intent not found"})
		return
	}
	if intent.Status != "initiated" && intent.Status != "pending" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "can only void pending/initiated payments"})
		return
	}
	// Void the TigerBeetle pending entry — refuse to mark voided when the
	// ledger void could not be confirmed.
	if err := h.voidLedgerWithRetry(c.Request.Context(), intent.TigerBeetlePendingID); err != nil {
		h.logger.Error("ledger void failed", zap.Error(err))
		c.JSON(http.StatusBadGateway, gin.H{"error": "ledger void failed", "detail": err.Error()})
		return
	}
	h.setStatus(c, id, "voided", "manual_void")
	c.JSON(http.StatusOK, gin.H{"status": "voided", "payment_intent_id": id})
}

// HandleMojaloopCallback processes async Mojaloop transfer completion callbacks.
func (h *Handler) HandleMojaloopCallback(c *gin.Context) {
	rawBody, _ := io.ReadAll(c.Request.Body)
	var payload map[string]interface{}
	json.Unmarshal(rawBody, &payload)

	transferID, _ := payload["transferId"].(string)
	transferState, _ := payload["transferState"].(string)

	intent, err := h.db.GetPaymentIntentByMojaloop(c.Request.Context(), transferID)
	if err != nil {
		h.logger.Warn("mojaloop callback: intent not found", zap.String("transfer_id", transferID))
		c.JSON(http.StatusOK, gin.H{"status": "ignored"})
		return
	}

	switch transferState {
	case "COMMITTED":
		// Commit the TigerBeetle pending entry. If the commit cannot be
		// confirmed after retries, mark ledger_drift — NOT completed — so the
		// order is never confirmed against an unsettled ledger entry.
		if err := h.commitLedgerWithRetry(c.Request.Context(), intent.TigerBeetlePendingID); err != nil {
			h.logger.Error("ledger commit failed after retries; marking ledger_drift",
				zap.String("intent_id", intent.ID.String()), zap.Error(err))
			h.setStatus(c, intent.ID, StatusLedgerDrift, "commit failed: "+err.Error())
			c.JSON(http.StatusOK, gin.H{"status": "processed", "ledger": "drift"})
			return
		}
		h.setStatus(c, intent.ID, "completed", "")
		// Notify commerce engine to confirm order
		h.notifyOrderPaid(c.Request.Context(), intent)
		h.logger.Info("payment completed", zap.String("intent_id", intent.ID.String()), zap.String("transfer_id", transferID))
	case "ABORTED", "EXPIRED":
		if err := h.voidLedgerWithRetry(c.Request.Context(), intent.TigerBeetlePendingID); err != nil {
			h.logger.Error("ledger void failed after retries; marking ledger_drift",
				zap.String("intent_id", intent.ID.String()), zap.Error(err))
			h.setStatus(c, intent.ID, StatusLedgerDrift, transferState+"; void failed: "+err.Error())
			c.JSON(http.StatusOK, gin.H{"status": "processed", "ledger": "drift"})
			return
		}
		h.setStatus(c, intent.ID, "failed", transferState)
		h.logger.Info("payment failed", zap.String("intent_id", intent.ID.String()), zap.String("state", transferState))
	}

	c.JSON(http.StatusOK, gin.H{"status": "processed"})
}

// ─── Ledger bridge client (checked, retried; never silently skipped) ────────

// reserveLedger creates a pending TigerBeetle entry via the ledger bridge.
// Non-2xx responses and responses without a pending_id are ERRORS.
func (h *Handler) reserveLedger(ctx context.Context, intent store.PaymentIntentRow) (string, error) {
	// === W35 otel ===
	ctx, span := otel.Tracer("payment-orchestrator").Start(ctx, "tigerbeetle.reserve",
		trace.WithAttributes(
			attribute.String("db.system", "tigerbeetle"),
			attribute.String("tb.operation", "reserve"),
			attribute.String("tenant.id", intent.TenantID.String()),
		))
	defer span.End()
	// === END W35 otel ===
	body, _ := json.Marshal(map[string]interface{}{
		"action":          "reserve",
		"account_id":      intent.TenantID.String(),
		"amount":          intent.Amount,
		"currency":        intent.Currency,
		"ref":             intent.ID.String(),
		"idempotency_key": intent.ID.String(),
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, h.cfg.LedgerBridgeURL+"/ledger/reserve", bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := h.client.Do(req)
	if err != nil {
		return "", fmt.Errorf("ledger reserve request failed: %w", err)
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("ledger reserve returned %d: %s", resp.StatusCode, string(respBody))
	}
	var result map[string]interface{}
	if err := json.Unmarshal(respBody, &result); err != nil {
		return "", fmt.Errorf("ledger reserve returned unparseable body: %w", err)
	}
	pendingID, _ := result["pending_id"].(string)
	if pendingID == "" {
		return "", fmt.Errorf("ledger reserve returned %d without pending_id", resp.StatusCode)
	}
	return pendingID, nil
}

// ledgerSettle posts to a settle endpoint (commit/void/reverse) and returns an
// error unless the bridge confirms with a 2xx response.
func (h *Handler) ledgerSettle(ctx context.Context, path, pendingID string) error {
	if pendingID == "" || h.cfg.LedgerBridgeURL == "" {
		return nil
	}
	// === W35 otel ===
	op := strings.TrimPrefix(path, "/ledger/")
	ctx, span := otel.Tracer("payment-orchestrator").Start(ctx, "tigerbeetle."+op,
		trace.WithAttributes(
			attribute.String("db.system", "tigerbeetle"),
			attribute.String("tb.operation", op),
		))
	defer span.End()
	// === END W35 otel ===
	body, _ := json.Marshal(map[string]interface{}{"pending_id": pendingID})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, h.cfg.LedgerBridgeURL+path, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := h.client.Do(req)
	if err != nil {
		return fmt.Errorf("ledger %s request failed: %w", path, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		return fmt.Errorf("ledger %s returned %d: %s", path, resp.StatusCode, string(respBody))
	}
	return nil
}

// withRetry runs op up to 3 attempts with 300ms/1200ms backoff.
func withRetry(op func() error) error {
	var err error
	for attempt := 0; attempt < 3; attempt++ {
		if attempt > 0 {
			// 300ms, then 1200ms backoff between attempts
			time.Sleep(time.Duration(attempt*attempt) * 300 * time.Millisecond)
		}
		if err = op(); err == nil {
			return nil
		}
	}
	return err
}

func (h *Handler) commitLedgerWithRetry(ctx context.Context, pendingID string) error {
	return withRetry(func() error { return h.ledgerSettle(ctx, "/ledger/commit", pendingID) })
}

func (h *Handler) voidLedgerWithRetry(ctx context.Context, pendingID string) error {
	return withRetry(func() error { return h.ledgerSettle(ctx, "/ledger/void", pendingID) })
}

func (h *Handler) reverseLedgerWithRetry(ctx context.Context, pendingID string) error {
	return withRetry(func() error { return h.ledgerSettle(ctx, "/ledger/reverse", pendingID) })
}

// ─── Providers ──────────────────────────────────────────────────────────────

func (h *Handler) initiateMojaloop(ctx context.Context, intent store.PaymentIntentRow, phoneNumber string) (string, string, error) {
	transferID := uuid.New().String()
	body, _ := json.Marshal(map[string]interface{}{
		"transferId":          transferID,
		"payerFsp":            h.cfg.MojaloopFSPID,
		"payeeFsp":            "payee-fsp",
		"amount":              fmt.Sprintf("%.2f", intent.Amount),
		"currency":            intent.Currency,
		"ilpPacket":           "AQAAAAAAAADIEHByaXZhdGUucGF5ZWVmc3A",
		"condition":           "f5sqb7tBTWPd5Y8BDFdMm9BJR_MNI4isf8p8n4D5pHA",
		"expiration":          time.Now().Add(30 * time.Second).Format(time.RFC3339),
		"payerIdentifierType": "MSISDN",
		"payerIdentifier":     phoneNumber,
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, h.cfg.MojaloopURL+"/transfers", bytes.NewReader(body))
	if err != nil {
		return "", "", err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := h.client.Do(req)
	if err != nil {
		return "", "", fmt.Errorf("mojaloop transfer request failed: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return "", "", fmt.Errorf("mojaloop returned status %d", resp.StatusCode)
	}
	paymentURL := fmt.Sprintf("%s/transfers/%s", h.cfg.MojaloopURL, transferID)
	return transferID, paymentURL, nil
}

// minorUnits converts a major-unit amount to integer minor units with
// explicit round-half-up.
func minorUnits(amount float64) int64 {
	return int64(math.Round(amount * 100))
}

// initiateStripe creates a REAL Stripe Checkout Session via the Stripe API.
// When STRIPE_SECRET_KEY is unset it returns an explicit error — it never
// fabricates a checkout URL.
func (h *Handler) initiateStripe(ctx context.Context, intent store.PaymentIntentRow) (string, string, error) {
	if h.cfg.StripeSecretKey == "" {
		return "", "", errors.New("STRIPE_SECRET_KEY is not configured; cannot create a Stripe checkout session")
	}
	form := url.Values{}
	form.Set("mode", "payment")
	form.Set("success_url", h.cfg.StripeSuccessURL)
	form.Set("cancel_url", h.cfg.StripeCancelURL)
	form.Set("client_reference_id", intent.ID.String())
	form.Set("line_items[0][price_data][currency]", strings.ToLower(intent.Currency))
	form.Set("line_items[0][price_data][unit_amount]", strconv.FormatInt(minorUnits(intent.Amount), 10))
	form.Set("line_items[0][price_data][product_data][name]", "Order "+intent.OrderID.String())
	form.Set("line_items[0][quantity]", "1")
	form.Set("metadata[payment_intent_id]", intent.ID.String())
	form.Set("metadata[tenant_id]", intent.TenantID.String())
	form.Add("expand[]", "payment_intent")

	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		"https://api.stripe.com/v1/checkout/sessions", strings.NewReader(form.Encode()))
	if err != nil {
		return "", "", err
	}
	req.SetBasicAuth(h.cfg.StripeSecretKey, "")
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	resp, err := h.client.Do(req)
	if err != nil {
		return "", "", fmt.Errorf("stripe checkout session request failed: %w", err)
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", "", fmt.Errorf("stripe returned %d: %s", resp.StatusCode, string(respBody))
	}
	var session struct {
		ID            string `json:"id"`
		URL           string `json:"url"`
		PaymentIntent struct {
			ID string `json:"id"`
		} `json:"payment_intent"`
	}
	if err := json.Unmarshal(respBody, &session); err != nil {
		return "", "", fmt.Errorf("stripe returned unparseable session: %w", err)
	}
	if session.URL == "" {
		return "", "", errors.New("stripe returned a session without a checkout URL")
	}
	// Prefer the expandable payment_intent id (usable for refunds); fall back
	// to the session id.
	providerRef := session.PaymentIntent.ID
	if providerRef == "" {
		providerRef = session.ID
	}
	return providerRef, session.URL, nil
}

// ─── Provider refunds ───────────────────────────────────────────────────────

// providerReference returns the provider-side reference for an intent.
func providerReference(intent *store.PaymentIntentRow) string {
	if intent.MojaloopTransferID != "" {
		return intent.MojaloopTransferID
	}
	return intent.ID.String()
}

func (h *Handler) refundPaystack(ctx context.Context, intent *store.PaymentIntentRow) error {
	if h.cfg.PaystackSecretKey == "" {
		return errors.New("PAYSTACK_SECRET_KEY is not configured")
	}
	body, _ := json.Marshal(map[string]interface{}{
		"transaction": providerReference(intent),
		"amount":      minorUnits(intent.Amount),
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://api.paystack.co/refund", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+h.cfg.PaystackSecretKey)
	req.Header.Set("Content-Type", "application/json")
	resp, err := h.client.Do(req)
	if err != nil {
		return fmt.Errorf("paystack refund request failed: %w", err)
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("paystack refund returned %d: %s", resp.StatusCode, string(respBody))
	}
	return nil
}

func (h *Handler) refundFlutterwave(ctx context.Context, intent *store.PaymentIntentRow) error {
	if h.cfg.FlutterwaveSecretKey == "" {
		return errors.New("FLW_SECRET_KEY is not configured")
	}
	txRef := providerReference(intent)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		"https://api.flutterwave.com/v3/transactions/"+txRef+"/refund", bytes.NewReader([]byte("{}")))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+h.cfg.FlutterwaveSecretKey)
	req.Header.Set("Content-Type", "application/json")
	resp, err := h.client.Do(req)
	if err != nil {
		return fmt.Errorf("flutterwave refund request failed: %w", err)
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("flutterwave refund returned %d: %s", resp.StatusCode, string(respBody))
	}
	return nil
}

func (h *Handler) refundStripe(ctx context.Context, intent *store.PaymentIntentRow) error {
	if h.cfg.StripeSecretKey == "" {
		return errors.New("STRIPE_SECRET_KEY is not configured")
	}
	form := url.Values{}
	form.Set("payment_intent", providerReference(intent))
	form.Set("amount", strconv.FormatInt(minorUnits(intent.Amount), 10))
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		"https://api.stripe.com/v1/refunds", strings.NewReader(form.Encode()))
	if err != nil {
		return err
	}
	req.SetBasicAuth(h.cfg.StripeSecretKey, "")
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := h.client.Do(req)
	if err != nil {
		return fmt.Errorf("stripe refund request failed: %w", err)
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("stripe refund returned %d: %s", resp.StatusCode, string(respBody))
	}
	return nil
}

// emitRefundEvent notifies the platform (via the internal events endpoint)
// that a Mojaloop refund was requested and needs a manual/platform payout.
func (h *Handler) emitRefundEvent(ctx context.Context, intent *store.PaymentIntentRow) error {
	if h.cfg.PlatformURL == "" {
		return errors.New("PLATFORM_URL is not configured")
	}
	body, _ := json.Marshal(map[string]interface{}{
		"events": []map[string]interface{}{{
			"topic":     "payment.refund_requested",
			"offset":    time.Now().UnixMilli(),
			"partition": 0,
			"tenantId":  intent.TenantID.String(),
			"eventType": "payment.refund_requested",
			"payload": map[string]interface{}{
				"payment_intent_id": intent.ID.String(),
				"order_id":          intent.OrderID.String(),
				"amount":            intent.Amount,
				"currency":          intent.Currency,
				"provider":          intent.Provider,
				"reason":            "customer_request",
			},
		}},
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, h.cfg.PlatformURL+"/api/internal/events", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if h.cfg.InternalAPIKey != "" {
		req.Header.Set("X-Internal-Api-Key", h.cfg.InternalAPIKey)
	}
	resp, err := h.client.Do(req)
	if err != nil {
		return fmt.Errorf("platform events request failed: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		return fmt.Errorf("platform events returned %d: %s", resp.StatusCode, string(respBody))
	}
	return nil
}

func (h *Handler) notifyOrderPaid(ctx context.Context, intent *store.PaymentIntentRow) {
	body, _ := json.Marshal(map[string]interface{}{
		"order_id": intent.OrderID.String(),
		"status":   "paid",
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, h.cfg.CommerceEngineURL+"/orders/"+intent.OrderID.String()+"/confirm", bytes.NewReader(body))
	if err != nil {
		h.logger.Error("notify order paid: request build failed", zap.Error(err))
		return
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := h.client.Do(req)
	if err != nil {
		h.logger.Error("notify order paid failed", zap.Error(err))
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		h.logger.Error("commerce engine rejected order confirmation", zap.Int("status", resp.StatusCode))
	}
}
