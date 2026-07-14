package handler

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/whatsapp-commerce/payment-orchestrator/internal/config"
	"github.com/whatsapp-commerce/payment-orchestrator/internal/store"
	"go.uber.org/zap"
)

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

// InitiatePayment creates a payment intent and dispatches to the appropriate provider.
// Implements the two-phase commit pattern:
//  1. Create a PENDING ledger entry in TigerBeetle (via ledger-bridge)
//  2. Initiate the transfer with Mojaloop or Stripe
//  3. Await async callback to COMMIT or VOID
func (h *Handler) InitiatePayment(c *gin.Context) {
	tenantID := mustUUID(c.GetHeader("X-Tenant-ID"))
	idempotencyKey := c.GetHeader("X-Idempotency-Key")
	if idempotencyKey == "" {
		idempotencyKey = uuid.New().String()
	}

	var req struct {
		OrderID    string  `json:"order_id" binding:"required"`
		CustomerID string  `json:"customer_id" binding:"required"`
		Amount     float64 `json:"amount" binding:"required,gt=0"`
		Currency   string  `json:"currency" binding:"required"`
		Provider   string  `json:"provider"` // "mojaloop" | "stripe"
		PhoneNumber string `json:"phone_number"` // for Mojaloop MSISDN lookup
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	provider := req.Provider
	if provider == "" {
		provider = "mojaloop"
	}

	intent := store.PaymentIntentRow{
		ID:             uuid.New(),
		TenantID:       tenantID,
		OrderID:        mustUUID(req.OrderID),
		CustomerID:     mustUUID(req.CustomerID),
		Status:         "pending",
		Amount:         req.Amount,
		Currency:       req.Currency,
		Provider:       provider,
		WorkflowID:     uuid.New().String(),
		IdempotencyKey: idempotencyKey,
		CreatedAt:      time.Now(),
		UpdatedAt:      time.Now(),
	}

	if err := h.db.CreatePaymentIntent(c.Request.Context(), intent); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create payment intent"})
		return
	}

	// Phase 1: Reserve funds in TigerBeetle ledger
	pendingID, err := h.reserveLedger(c.Request.Context(), intent)
	if err != nil {
		h.logger.Warn("ledger reservation failed, continuing", zap.Error(err))
	} else {
		intent.TigerBeetlePendingID = pendingID
	}

	// Phase 2: Initiate provider transfer
	var paymentURL string
	switch provider {
	case "mojaloop":
		transferID, url, err := h.initiateMojaloop(c.Request.Context(), intent, req.PhoneNumber)
		if err != nil {
			h.db.UpdatePaymentStatus(c.Request.Context(), intent.ID, "failed", err.Error())
			c.JSON(http.StatusBadGateway, gin.H{"error": "payment initiation failed", "detail": err.Error()})
			return
		}
		intent.MojaloopTransferID = transferID
		paymentURL = url
	case "stripe":
		url, err := h.initiateStripe(c.Request.Context(), intent)
		if err != nil {
			h.db.UpdatePaymentStatus(c.Request.Context(), intent.ID, "failed", err.Error())
			c.JSON(http.StatusBadGateway, gin.H{"error": "payment initiation failed", "detail": err.Error()})
			return
		}
		paymentURL = url
	default:
		c.JSON(http.StatusBadRequest, gin.H{"error": "unsupported payment provider: " + provider})
		return
	}

	h.db.UpdatePaymentStatus(c.Request.Context(), intent.ID, "initiated", "")

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

func (h *Handler) GetPaymentStatus(c *gin.Context) {
	tenantID := mustUUID(c.GetHeader("X-Tenant-ID"))
	id := mustUUID(c.Param("id"))
	intent, err := h.db.GetPaymentIntent(c.Request.Context(), tenantID, id)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "payment intent not found"})
		return
	}
	c.JSON(http.StatusOK, intent)
}

func (h *Handler) RefundPayment(c *gin.Context) {
	tenantID := mustUUID(c.GetHeader("X-Tenant-ID"))
	id := mustUUID(c.Param("id"))
	intent, err := h.db.GetPaymentIntent(c.Request.Context(), tenantID, id)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "payment intent not found"})
		return
	}
	if intent.Status != "completed" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "can only refund completed payments"})
		return
	}
	h.db.UpdatePaymentStatus(c.Request.Context(), id, "refunded", "customer_request")
	c.JSON(http.StatusOK, gin.H{"status": "refunded", "payment_intent_id": id})
}

func (h *Handler) VoidPayment(c *gin.Context) {
	tenantID := mustUUID(c.GetHeader("X-Tenant-ID"))
	id := mustUUID(c.Param("id"))
	intent, err := h.db.GetPaymentIntent(c.Request.Context(), tenantID, id)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "payment intent not found"})
		return
	}
	if intent.Status != "initiated" && intent.Status != "pending" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "can only void pending/initiated payments"})
		return
	}
	// Void TigerBeetle pending entry
	h.voidLedger(c.Request.Context(), intent.TigerBeetlePendingID)
	h.db.UpdatePaymentStatus(c.Request.Context(), id, "voided", "manual_void")
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
		// Commit the TigerBeetle pending entry
		h.commitLedger(c.Request.Context(), intent.TigerBeetlePendingID)
		h.db.UpdatePaymentStatus(c.Request.Context(), intent.ID, "completed", "")
		// Notify commerce engine to confirm order
		h.notifyOrderPaid(c.Request.Context(), intent)
		h.logger.Info("payment completed", zap.String("intent_id", intent.ID.String()), zap.String("transfer_id", transferID))
	case "ABORTED", "EXPIRED":
		h.voidLedger(c.Request.Context(), intent.TigerBeetlePendingID)
		h.db.UpdatePaymentStatus(c.Request.Context(), intent.ID, "failed", transferState)
		h.logger.Info("payment failed", zap.String("intent_id", intent.ID.String()), zap.String("state", transferState))
	}

	c.JSON(http.StatusOK, gin.H{"status": "processed"})
}

// reserveLedger creates a pending TigerBeetle entry via the Rust ledger bridge.
func (h *Handler) reserveLedger(ctx context.Context, intent store.PaymentIntentRow) (string, error) {
	if h.cfg.LedgerBridgeURL == "" {
		return "", nil
	}
	body, _ := json.Marshal(map[string]interface{}{
		"action":     "reserve",
		"account_id": intent.TenantID.String(),
		"amount":     intent.Amount,
		"currency":   intent.Currency,
		"ref":        intent.ID.String(),
	})
	resp, err := h.client.Post(h.cfg.LedgerBridgeURL+"/ledger/reserve", "application/json", bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	var result map[string]interface{}
	json.NewDecoder(resp.Body).Decode(&result)
	pendingID, _ := result["pending_id"].(string)
	return pendingID, nil
}

func (h *Handler) commitLedger(ctx context.Context, pendingID string) {
	if pendingID == "" || h.cfg.LedgerBridgeURL == "" {
		return
	}
	body, _ := json.Marshal(map[string]interface{}{"pending_id": pendingID})
	h.client.Post(h.cfg.LedgerBridgeURL+"/ledger/commit", "application/json", bytes.NewReader(body))
}

func (h *Handler) voidLedger(ctx context.Context, pendingID string) {
	if pendingID == "" || h.cfg.LedgerBridgeURL == "" {
		return
	}
	body, _ := json.Marshal(map[string]interface{}{"pending_id": pendingID})
	h.client.Post(h.cfg.LedgerBridgeURL+"/ledger/void", "application/json", bytes.NewReader(body))
}

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
	resp, err := h.client.Post(h.cfg.MojaloopURL+"/transfers", "application/json", bytes.NewReader(body))
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

func (h *Handler) initiateStripe(ctx context.Context, intent store.PaymentIntentRow) (string, error) {
	// Stripe payment link creation (simplified)
	return fmt.Sprintf("https://checkout.stripe.com/pay/%s", intent.ID.String()), nil
}

func (h *Handler) notifyOrderPaid(ctx context.Context, intent *store.PaymentIntentRow) {
	body, _ := json.Marshal(map[string]interface{}{
		"order_id": intent.OrderID.String(),
		"status":   "paid",
	})
	h.client.Post(h.cfg.CommerceEngineURL+"/orders/"+intent.OrderID.String()+"/confirm", "application/json", bytes.NewReader(body))
}

func mustUUID(s string) uuid.UUID {
	id, _ := uuid.Parse(s)
	return id
}

