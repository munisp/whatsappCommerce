package orchestrator

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/whatsapp-commerce/conversation-orchestrator/internal/config"
	"github.com/whatsapp-commerce/conversation-orchestrator/internal/store"
	"go.uber.org/zap"
)

// InboundMessage represents a normalized inbound message from any channel.
type InboundMessage struct {
	TenantID       uuid.UUID `json:"tenant_id"`
	PhoneNumber    string    `json:"phone_number"`
	SenderName     string    `json:"sender_name"`
	Content        string    `json:"content"`
	ContentType    string    `json:"content_type"`
	ChatwootConvID int64     `json:"chatwoot_conv_id"`
	ChatwootMsgID  int64     `json:"chatwoot_msg_id"`
	IdempotencyKey string    `json:"idempotency_key"`
	ReceivedAt     time.Time `json:"received_at"`
}

// AIIntentResponse is the response from the AI agent intent endpoint.
type AIIntentResponse struct {
	IntentType string                 `json:"intent_type"`
	Confidence float64                `json:"confidence"`
	Entities   map[string]interface{} `json:"entities"`
	NextAction string                 `json:"next_action"`
	Reply      string                 `json:"reply"`
	Escalate   bool                   `json:"escalate"`
}

// Orchestrator drives the conversation state machine.
type Orchestrator struct {
	cfg    *config.Config
	db     *store.DB
	logger *zap.Logger
	client *http.Client
}

func New(cfg *config.Config, db *store.DB, logger *zap.Logger) *Orchestrator {
	return &Orchestrator{
		cfg:    cfg,
		db:     db,
		logger: logger,
		client: &http.Client{Timeout: 15 * time.Second},
	}
}

// ProcessMessage is the main entry point for inbound message handling.
// It implements the conversation state machine:
//  1. Resolve or create session
//  2. Determine mode (menu, ai, agent)
//  3. Route to appropriate handler
//  4. Persist message and state
//  5. Send reply via Chatwoot
func (o *Orchestrator) ProcessMessage(ctx context.Context, msg InboundMessage) error {
	// 1. Resolve or create customer
	customer, err := o.db.UpsertCustomer(ctx, msg.TenantID, msg.PhoneNumber, msg.SenderName)
	if err != nil {
		return fmt.Errorf("upsert customer: %w", err)
	}

	// 2. Resolve or create conversation
	conv, err := o.db.GetOrCreateConversation(ctx, msg.TenantID, customer.ID, msg.ChatwootConvID)
	if err != nil {
		return fmt.Errorf("get/create conversation: %w", err)
	}

	// 3. Persist inbound message
	if err := o.db.SaveMessage(ctx, store.MessageRow{
		ID:             uuid.New(),
		TenantID:       msg.TenantID,
		ConversationID: conv.ID,
		Direction:      "inbound",
		Content:        msg.Content,
		ContentType:    msg.ContentType,
		IdempotencyKey: msg.IdempotencyKey,
		ExternalMsgID:  fmt.Sprintf("%d", msg.ChatwootMsgID),
		CreatedAt:      msg.ReceivedAt,
	}); err != nil {
		o.logger.Warn("failed to save message", zap.Error(err))
	}

	// 4. If conversation is handed off to a human agent, skip AI/menu processing
	if conv.State == "handed_off" {
		o.logger.Info("conversation is handed off, skipping AI", zap.String("conv_id", conv.ID.String()))
		return nil
	}

	// 5. Route to AI agent for intent classification
	var reply string
	var escalate bool

	if conv.Mode == "menu" || conv.Mode == "" {
		reply, escalate, err = o.routeToMenuOrAI(ctx, conv, customer, msg)
	} else {
		reply, escalate, err = o.routeToAI(ctx, conv, customer, msg)
	}

	if err != nil {
		o.logger.Error("routing error", zap.Error(err))
		reply = "I'm having trouble processing your request. Please try again or type 'agent' to speak with a human."
	}

	// 6. Handle escalation
	if escalate {
		if handoffErr := o.initiateHandoff(ctx, conv, customer, "low_confidence"); handoffErr != nil {
			o.logger.Error("handoff failed", zap.Error(handoffErr))
		}
		return nil
	}

	// 7. Send reply via Chatwoot
	if reply != "" {
		if err := o.sendChatwootReply(ctx, msg.TenantID, msg.ChatwootConvID, reply); err != nil {
			o.logger.Error("failed to send chatwoot reply", zap.Error(err))
		}
	}

	// 8. Update conversation last_message_at
	o.db.UpdateConversationLastMessage(ctx, conv.ID, time.Now())

	return nil
}

func (o *Orchestrator) routeToMenuOrAI(ctx context.Context, conv *store.ConversationRow, customer *store.CustomerRow, msg InboundMessage) (string, bool, error) {
	// Check for simple menu commands first
	switch msg.Content {
	case "1", "menu", "start", "hi", "hello":
		return o.buildMainMenu(conv.TenantID), false, nil
	case "0", "agent", "human", "help":
		return "", true, nil // escalate
	}
	// Fall through to AI for free text
	return o.routeToAI(ctx, conv, customer, msg)
}

func (o *Orchestrator) routeToAI(ctx context.Context, conv *store.ConversationRow, customer *store.CustomerRow, msg InboundMessage) (string, bool, error) {
	reqBody, _ := json.Marshal(map[string]interface{}{
		"tenant_id":       conv.TenantID.String(),
		"conversation_id": conv.ID.String(),
		"customer_id":     customer.ID.String(),
		"message":         msg.Content,
		"flow_step":       conv.CurrentFlowStep,
	})

	resp, err := o.client.Post(o.cfg.AIAgentURL+"/intent", "application/json", bytes.NewReader(reqBody))
	if err != nil {
		return o.buildMainMenu(conv.TenantID), false, nil // fallback to menu on AI failure
	}
	defer resp.Body.Close()

	var aiResp AIIntentResponse
	if err := json.NewDecoder(resp.Body).Decode(&aiResp); err != nil {
		return o.buildMainMenu(conv.TenantID), false, nil
	}

	if aiResp.Escalate || aiResp.Confidence < 0.4 {
		return "", true, nil
	}

	return aiResp.Reply, false, nil
}

func (o *Orchestrator) buildMainMenu(tenantID uuid.UUID) string {
	return `Welcome! How can I help you today?

1️⃣  Browse Products
2️⃣  Check Order Status
3️⃣  View Cart
4️⃣  Track Delivery
5️⃣  Get Support

Reply with a number or type your question.`
}

func (o *Orchestrator) initiateHandoff(ctx context.Context, conv *store.ConversationRow, customer *store.CustomerRow, reason string) error {
	// Update conversation state to handed_off
	if err := o.db.UpdateConversationState(ctx, conv.ID, "handed_off"); err != nil {
		return err
	}

	// Notify Chatwoot to assign to a human agent
	reqBody, _ := json.Marshal(map[string]interface{}{
		"assignee_type": "agent",
		"reason":        reason,
	})

	url := fmt.Sprintf("%s/api/v1/profile", o.cfg.ChatwootURL)
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(reqBody))
	req.Header.Set("Content-Type", "application/json")
	o.client.Do(req)

	o.logger.Info("handoff initiated",
		zap.String("conv_id", conv.ID.String()),
		zap.String("reason", reason),
	)
	return nil
}

func (o *Orchestrator) sendChatwootReply(ctx context.Context, tenantID uuid.UUID, chatwootConvID int64, content string) error {
	// In production this would use the Chatwoot API with tenant-specific token
	o.logger.Info("sending chatwoot reply",
		zap.String("tenant_id", tenantID.String()),
		zap.Int64("conv_id", chatwootConvID),
		zap.String("content_preview", content[:min(50, len(content))]),
	)
	return nil
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

