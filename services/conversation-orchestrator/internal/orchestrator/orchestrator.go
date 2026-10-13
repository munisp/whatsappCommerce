package orchestrator

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"sync"
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
	conv, err := o.db.GetOrCreateConversation(ctx, msg.TenantID, customer.ID, strconv.FormatInt(msg.ChatwootConvID, 10))
	if err != nil {
		return fmt.Errorf("get/create conversation: %w", err)
	}

	// 3. There is no messages table in the real schema (see store/postgres.go)
	// — inbound content is routed below but not persisted as a row.

	// 4. If conversation is handed off to a human agent, skip AI/menu processing.
	// === W45 go-rust-services (MSG-17) ===
	// "bot_active" is the path BACK from human_active (agent resolved the
	// Chatwoot conversation) — it is processed like "open".
	if conv.Status == "human_active" {
		o.logger.Info("conversation is handed off, skipping AI", zap.String("conv_id", conv.ID.String()))
		return nil
	}

	// 5. Route to AI agent for intent classification. There is no separate
	// "mode" column in the real schema — CurrentFlowStep (default "greeting")
	// is the real column standing in for "still in the menu flow".
	var reply string
	var escalate bool

	if conv.CurrentFlowStep == "greeting" || conv.CurrentFlowStep == "" {
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

	// === W48 sidecars (PERF-SC-23) === steps 7+8 are independent — run the
	// Chatwoot reply and the last_message_at update concurrently instead of
	// sequentially (one less RTT of latency per inbound message).
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		if reply != "" {
			if err := o.sendChatwootReply(ctx, msg.TenantID, msg.ChatwootConvID, reply); err != nil {
				o.logger.Error("failed to send chatwoot reply", zap.Error(err))
			}
		}
	}()
	go func() {
		defer wg.Done()
		o.db.UpdateConversationLastMessage(ctx, conv.ID)
	}()
	wg.Wait()

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

	// PERF-SC-23: was o.client.Post — the caller's ctx (cancellation, trace,
	// deadline) was silently dropped. Now the request runs under ctx.
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, o.cfg.AIAgentURL+"/intent", bytes.NewReader(reqBody))
	if err != nil {
		return o.buildMainMenu(conv.TenantID), false, nil
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := o.client.Do(req)
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
	// Update conversation status to human_active ("handed_off" was never a
	// valid status enum member in the real schema).
	if err := o.db.UpdateConversationState(ctx, conv.ID, "human_active"); err != nil {
		return err
	}

	// === W45 go-rust-services (MSG-17) ===
	// Notify Chatwoot to open the conversation for human agents. Checked:
	// a failure is logged AND returned so callers can surface it — never an
	// unchecked fire-and-forget.
	chatwootID, _ := strconv.ParseInt(conv.ChatwootConversationID, 10, 64)
	if err := o.setChatwootStatus(ctx, chatwootID, "open"); err != nil {
		o.logger.Error("chatwoot handoff status update failed",
			zap.String("chatwoot_conv_id", conv.ChatwootConversationID),
			zap.Error(err),
		)
		return fmt.Errorf("chatwoot handoff: %w", err)
	}

	o.logger.Info("handoff initiated",
		zap.String("conv_id", conv.ID.String()),
		zap.String("reason", reason),
	)
	return nil
}

// === W45 go-rust-services (MSG-17) ===
// ResolveToBot returns a conversation to the bot: marks the Chatwoot
// conversation resolved AND flips local state to bot_active so ProcessMessage
// resumes AI/menu handling. This is the previously-missing path back from
// handed_off.
func (o *Orchestrator) ResolveToBot(ctx context.Context, convID uuid.UUID) error {
	conv, err := o.db.GetConversationByID(ctx, convID)
	if err != nil {
		return fmt.Errorf("load conversation: %w", err)
	}
	chatwootID, _ := strconv.ParseInt(conv.ChatwootConversationID, 10, 64)
	if err := o.setChatwootStatus(ctx, chatwootID, "resolved"); err != nil {
		return fmt.Errorf("chatwoot resolve: %w", err)
	}
	if err := o.db.UpdateConversationState(ctx, conv.ID, "bot_active"); err != nil {
		return err
	}
	o.logger.Info("conversation resolved — bot reactivated",
		zap.String("conv_id", conv.ID.String()),
		zap.String("chatwoot_conv_id", conv.ChatwootConversationID),
	)
	return nil
}

// sendChatwootReply posts the bot reply to the Chatwoot conversation via the
// real Chatwoot API (POST /api/v1/accounts/{id}/conversations/{id}/messages).
// Errors propagate to the caller — a failed reply is never silently dropped.
func (o *Orchestrator) sendChatwootReply(ctx context.Context, tenantID uuid.UUID, chatwootConvID int64, content string) error {
	reqBody, _ := json.Marshal(map[string]interface{}{
		"content":      content,
		"message_type": "outgoing",
	})
	url := fmt.Sprintf("%s/api/v1/accounts/%s/conversations/%d/messages",
		o.cfg.ChatwootURL, o.cfg.ChatwootAccountID, chatwootConvID)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(reqBody))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("api_access_token", o.cfg.ChatwootAPIAccessToken)

	resp, err := o.client.Do(req)
	if err != nil {
		return fmt.Errorf("chatwoot reply POST failed: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return fmt.Errorf("chatwoot reply api %d", resp.StatusCode)
	}

	o.logger.Info("chatwoot reply sent",
		zap.String("tenant_id", tenantID.String()),
		zap.Int64("conv_id", chatwootConvID),
		zap.String("content_preview", content[:min(50, len(content))]),
	)
	return nil
}

// setChatwootStatus toggles a Chatwoot conversation status
// (open | resolved | pending) via the real API.
func (o *Orchestrator) setChatwootStatus(ctx context.Context, chatwootConvID int64, status string) error {
	reqBody, _ := json.Marshal(map[string]string{"status": status})
	url := fmt.Sprintf("%s/api/v1/accounts/%s/conversations/%d/toggle_status",
		o.cfg.ChatwootURL, o.cfg.ChatwootAccountID, chatwootConvID)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(reqBody))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("api_access_token", o.cfg.ChatwootAPIAccessToken)

	resp, err := o.client.Do(req)
	if err != nil {
		return fmt.Errorf("chatwoot status POST failed: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return fmt.Errorf("chatwoot status api %d", resp.StatusCode)
	}
	return nil
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

