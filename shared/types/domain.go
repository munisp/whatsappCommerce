package types

import (
	"time"

	"github.com/google/uuid"
)

// ─── Tenant ───────────────────────────────────────────────────────────────────

type TenantTier string

const (
	TenantTierShared    TenantTier = "shared"
	TenantTierPooled    TenantTier = "pooled"
	TenantTierDedicated TenantTier = "dedicated"
)

type Tenant struct {
	ID          uuid.UUID  `json:"id" db:"id"`
	Slug        string     `json:"slug" db:"slug"`
	Name        string     `json:"name" db:"name"`
	Tier        TenantTier `json:"tier" db:"tier"`
	PhoneNumber string     `json:"phone_number" db:"phone_number"`
	WebhookURL  string     `json:"webhook_url" db:"webhook_url"`
	APIKey      string     `json:"-" db:"api_key"`
	IsActive    bool       `json:"is_active" db:"is_active"`
	CreatedAt   time.Time  `json:"created_at" db:"created_at"`
	UpdatedAt   time.Time  `json:"updated_at" db:"updated_at"`
	Config      TenantConfig `json:"config" db:"config"`
}

type TenantConfig struct {
	AIEnabled        bool   `json:"ai_enabled"`
	MaxSessionsPerHr int    `json:"max_sessions_per_hr"`
	DefaultLanguage  string `json:"default_language"`
	CurrencyCode     string `json:"currency_code"`
	PaymentProvider  string `json:"payment_provider"`
	OdooURL          string `json:"odoo_url,omitempty"`
	TwentyURL        string `json:"twenty_url,omitempty"`
	ChatwootURL      string `json:"chatwoot_url,omitempty"`
	ChatwootToken    string `json:"chatwoot_token,omitempty"`
}

// ─── Customer ─────────────────────────────────────────────────────────────────

type Customer struct {
	ID          uuid.UUID `json:"id" db:"id"`
	TenantID    uuid.UUID `json:"tenant_id" db:"tenant_id"`
	PhoneNumber string    `json:"phone_number" db:"phone_number"`
	DisplayName string    `json:"display_name" db:"display_name"`
	Email       string    `json:"email,omitempty" db:"email"`
	IsVerified  bool      `json:"is_verified" db:"is_verified"`
	ExternalID  string    `json:"external_id,omitempty" db:"external_id"`
	CreatedAt   time.Time `json:"created_at" db:"created_at"`
	UpdatedAt   time.Time `json:"updated_at" db:"updated_at"`
}

// ─── Conversation ─────────────────────────────────────────────────────────────

type ConversationState string

const (
	ConvStateActive    ConversationState = "active"
	ConvStateHandedOff ConversationState = "handed_off"
	ConvStateResolved  ConversationState = "resolved"
	ConvStateExpired   ConversationState = "expired"
)

type ConversationMode string

const (
	ConvModeMenu  ConversationMode = "menu"
	ConvModeAI    ConversationMode = "ai"
	ConvModeAgent ConversationMode = "agent"
)

type Conversation struct {
	ID               uuid.UUID         `json:"id" db:"id"`
	TenantID         uuid.UUID         `json:"tenant_id" db:"tenant_id"`
	CustomerID       uuid.UUID         `json:"customer_id" db:"customer_id"`
	ChatwootConvID   int64             `json:"chatwoot_conv_id,omitempty" db:"chatwoot_conv_id"`
	State            ConversationState `json:"state" db:"state"`
	Mode             ConversationMode  `json:"mode" db:"mode"`
	CurrentFlowStep  string            `json:"current_flow_step" db:"current_flow_step"`
	CartID           *uuid.UUID        `json:"cart_id,omitempty" db:"cart_id"`
	WorkflowID       string            `json:"workflow_id,omitempty" db:"workflow_id"`
	LastMessageAt    time.Time         `json:"last_message_at" db:"last_message_at"`
	CreatedAt        time.Time         `json:"created_at" db:"created_at"`
	UpdatedAt        time.Time         `json:"updated_at" db:"updated_at"`
}

// ─── Message ──────────────────────────────────────────────────────────────────

type MessageDirection string

const (
	MsgDirectionInbound  MessageDirection = "inbound"
	MsgDirectionOutbound MessageDirection = "outbound"
)

type Message struct {
	ID               uuid.UUID        `json:"id" db:"id"`
	TenantID         uuid.UUID        `json:"tenant_id" db:"tenant_id"`
	ConversationID   uuid.UUID        `json:"conversation_id" db:"conversation_id"`
	Direction        MessageDirection `json:"direction" db:"direction"`
	Content          string           `json:"content" db:"content"`
	ContentType      string           `json:"content_type" db:"content_type"`
	IdempotencyKey   string           `json:"idempotency_key" db:"idempotency_key"`
	ExternalMsgID    string           `json:"external_msg_id,omitempty" db:"external_msg_id"`
	ProcessedAt      *time.Time       `json:"processed_at,omitempty" db:"processed_at"`
	CreatedAt        time.Time        `json:"created_at" db:"created_at"`
}

// ─── Product / Catalog ────────────────────────────────────────────────────────

type Product struct {
	ID          uuid.UUID `json:"id" db:"id"`
	TenantID    uuid.UUID `json:"tenant_id" db:"tenant_id"`
	SKU         string    `json:"sku" db:"sku"`
	Name        string    `json:"name" db:"name"`
	Description string    `json:"description" db:"description"`
	Category    string    `json:"category" db:"category"`
	Price       float64   `json:"price" db:"price"`
	Currency    string    `json:"currency" db:"currency"`
	ImageURL    string    `json:"image_url,omitempty" db:"image_url"`
	IsActive    bool      `json:"is_active" db:"is_active"`
	ExternalID  string    `json:"external_id,omitempty" db:"external_id"`
	CreatedAt   time.Time `json:"created_at" db:"created_at"`
	UpdatedAt   time.Time `json:"updated_at" db:"updated_at"`
}

type StockLevel struct {
	ProductID   uuid.UUID `json:"product_id" db:"product_id"`
	TenantID    uuid.UUID `json:"tenant_id" db:"tenant_id"`
	SKU         string    `json:"sku" db:"sku"`
	Available   int       `json:"available" db:"available"`
	Reserved    int       `json:"reserved" db:"reserved"`
	OnHand      int       `json:"on_hand" db:"on_hand"`
	WarehouseID string    `json:"warehouse_id" db:"warehouse_id"`
	UpdatedAt   time.Time `json:"updated_at" db:"updated_at"`
}

// ─── Cart ─────────────────────────────────────────────────────────────────────

type CartStatus string

const (
	CartStatusActive    CartStatus = "active"
	CartStatusCheckout  CartStatus = "checkout"
	CartStatusConverted CartStatus = "converted"
	CartStatusAbandoned CartStatus = "abandoned"
)

type Cart struct {
	ID         uuid.UUID  `json:"id" db:"id"`
	TenantID   uuid.UUID  `json:"tenant_id" db:"tenant_id"`
	CustomerID uuid.UUID  `json:"customer_id" db:"customer_id"`
	Status     CartStatus `json:"status" db:"status"`
	Currency   string     `json:"currency" db:"currency"`
	Items      []CartItem `json:"items"`
	TotalAmount float64   `json:"total_amount" db:"total_amount"`
	ExpiresAt  time.Time  `json:"expires_at" db:"expires_at"`
	CreatedAt  time.Time  `json:"created_at" db:"created_at"`
	UpdatedAt  time.Time  `json:"updated_at" db:"updated_at"`
}

type CartItem struct {
	ID          uuid.UUID `json:"id" db:"id"`
	CartID      uuid.UUID `json:"cart_id" db:"cart_id"`
	ProductID   uuid.UUID `json:"product_id" db:"product_id"`
	SKU         string    `json:"sku" db:"sku"`
	ProductName string    `json:"product_name" db:"product_name"`
	Quantity    int       `json:"quantity" db:"quantity"`
	UnitPrice   float64   `json:"unit_price" db:"unit_price"`
	TotalPrice  float64   `json:"total_price" db:"total_price"`
}

// ─── Order ────────────────────────────────────────────────────────────────────

type OrderStatus string

const (
	OrderStatusPending    OrderStatus = "pending"
	OrderStatusConfirmed  OrderStatus = "confirmed"
	OrderStatusPaid       OrderStatus = "paid"
	OrderStatusFulfilling OrderStatus = "fulfilling"
	OrderStatusShipped    OrderStatus = "shipped"
	OrderStatusDelivered  OrderStatus = "delivered"
	OrderStatusCancelled  OrderStatus = "cancelled"
	OrderStatusFailed     OrderStatus = "failed"
)

type Order struct {
	ID              uuid.UUID   `json:"id" db:"id"`
	TenantID        uuid.UUID   `json:"tenant_id" db:"tenant_id"`
	CustomerID      uuid.UUID   `json:"customer_id" db:"customer_id"`
	CartID          uuid.UUID   `json:"cart_id" db:"cart_id"`
	Status          OrderStatus `json:"status" db:"status"`
	Currency        string      `json:"currency" db:"currency"`
	TotalAmount     float64     `json:"total_amount" db:"total_amount"`
	WorkflowID      string      `json:"workflow_id" db:"workflow_id"`
	ExternalOrderID string      `json:"external_order_id,omitempty" db:"external_order_id"`
	PaymentIntentID *uuid.UUID  `json:"payment_intent_id,omitempty" db:"payment_intent_id"`
	Notes           string      `json:"notes,omitempty" db:"notes"`
	CreatedAt       time.Time   `json:"created_at" db:"created_at"`
	UpdatedAt       time.Time   `json:"updated_at" db:"updated_at"`
}

// ─── Payment ──────────────────────────────────────────────────────────────────

type PaymentStatus string

const (
	PaymentStatusPending   PaymentStatus = "pending"
	PaymentStatusReserved  PaymentStatus = "reserved"
	PaymentStatusInitiated PaymentStatus = "initiated"
	PaymentStatusCompleted PaymentStatus = "completed"
	PaymentStatusFailed    PaymentStatus = "failed"
	PaymentStatusVoided    PaymentStatus = "voided"
	PaymentStatusRefunded  PaymentStatus = "refunded"
)

type PaymentIntent struct {
	ID                  uuid.UUID     `json:"id" db:"id"`
	TenantID            uuid.UUID     `json:"tenant_id" db:"tenant_id"`
	OrderID             uuid.UUID     `json:"order_id" db:"order_id"`
	CustomerID          uuid.UUID     `json:"customer_id" db:"customer_id"`
	Status              PaymentStatus `json:"status" db:"status"`
	Amount              float64       `json:"amount" db:"amount"`
	Currency            string        `json:"currency" db:"currency"`
	WorkflowID          string        `json:"workflow_id" db:"workflow_id"`
	MojaloopTransferID  string        `json:"mojaloop_transfer_id,omitempty" db:"mojaloop_transfer_id"`
	TigerBeetlePendingID string       `json:"tigerbeetle_pending_id,omitempty" db:"tigerbeetle_pending_id"`
	IdempotencyKey      string        `json:"idempotency_key" db:"idempotency_key"`
	CreatedAt           time.Time     `json:"created_at" db:"created_at"`
	UpdatedAt           time.Time     `json:"updated_at" db:"updated_at"`
}

// ─── Event Envelope ───────────────────────────────────────────────────────────

type EventEnvelope struct {
	ID             uuid.UUID              `json:"id"`
	TenantID       uuid.UUID              `json:"tenant_id"`
	TraceID        string                 `json:"trace_id"`
	EventType      string                 `json:"event_type"`
	EventVersion   string                 `json:"event_version"`
	OccurredAt     time.Time              `json:"occurred_at"`
	Producer       string                 `json:"producer"`
	Subject        string                 `json:"subject"`
	CorrelationID  string                 `json:"correlation_id"`
	CausationID    string                 `json:"causation_id"`
	IdempotencyKey string                 `json:"idempotency_key"`
	Payload        map[string]interface{} `json:"payload"`
}

// ─── AI Intent ────────────────────────────────────────────────────────────────

type IntentType string

const (
	IntentBrowse       IntentType = "browse"
	IntentSearch       IntentType = "search"
	IntentViewProduct  IntentType = "view_product"
	IntentAddToCart    IntentType = "add_to_cart"
	IntentCheckout     IntentType = "checkout"
	IntentPayment      IntentType = "payment"
	IntentOrderStatus  IntentType = "order_status"
	IntentSupport      IntentType = "support"
	IntentHandoff      IntentType = "handoff"
	IntentGreeting     IntentType = "greeting"
	IntentUnknown      IntentType = "unknown"
)

type AIIntent struct {
	Type       IntentType             `json:"type"`
	Confidence float64                `json:"confidence"`
	Entities   map[string]interface{} `json:"entities"`
	RawText    string                 `json:"raw_text"`
}

// ─── Handoff ──────────────────────────────────────────────────────────────────

type HandoffReason string

const (
	HandoffReasonCustomerRequest HandoffReason = "customer_request"
	HandoffReasonLowConfidence   HandoffReason = "low_confidence"
	HandoffReasonPaymentIssue    HandoffReason = "payment_issue"
	HandoffReasonPolicyBlock     HandoffReason = "policy_block"
	HandoffReasonSentimentRisk   HandoffReason = "sentiment_risk"
	HandoffReasonInventoryIssue  HandoffReason = "inventory_issue"
)

type HandoffRequest struct {
	ConversationID uuid.UUID     `json:"conversation_id"`
	TenantID       uuid.UUID     `json:"tenant_id"`
	CustomerID     uuid.UUID     `json:"customer_id"`
	Reason         HandoffReason `json:"reason"`
	Summary        string        `json:"summary"`
	WorkflowID     string        `json:"workflow_id,omitempty"`
	CreatedAt      time.Time     `json:"created_at"`
}
