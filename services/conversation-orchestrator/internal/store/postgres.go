package store

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/jmoiron/sqlx"
	_ "github.com/lib/pq"
)

// Column names and shapes below match the real schema (drizzle/schema.ts).
// customers has no phone_number/display_name/is_verified columns — the real
// columns are whatsappPhone/name/chatIdentityVerifiedAt (a verification
// timestamp, not a bool). conversations has a single status enum
// (open|resolved|pending|snoozed|bot_active|human_active), not separate
// state+mode columns, no workflow_id or cart_id this service uses, and
// chatwootConversationId is a varchar, not an integer. There is no messages
// table at all in the real schema — message persistence has been removed
// rather than inventing a table the schema owner (the TS app) doesn't have.

type CustomerRow struct {
	ID            uuid.UUID `db:"id" json:"id"`
	TenantID      uuid.UUID `db:"tenantId" json:"tenant_id"`
	WhatsappPhone string    `db:"whatsappPhone" json:"whatsapp_phone"`
	Name          string    `db:"name" json:"name"`
}

// ConversationRow matches the real conversations columns this service needs.
// Several real columns (channel, assignedAgentId, lastIntent, cartId,
// aiHandled, escalatedAt, resolvedAt, firstResponseAt, metadata) are
// intentionally left to their schema defaults — this service's state
// machine has no basis to set them.
type ConversationRow struct {
	ID                     uuid.UUID `db:"id" json:"id"`
	TenantID               uuid.UUID `db:"tenantId" json:"tenant_id"`
	CustomerID             uuid.UUID `db:"customerId" json:"customer_id"`
	ChatwootConversationID string    `db:"chatwootConversationId" json:"chatwoot_conversation_id"`
	// Status is the real enum column. "open" is the schema default for a new
	// conversation; "human_active"/"bot_active" replace this service's old
	// "handed_off"/"bot_active" state values — "handed_off" was never a
	// valid enum member, so that transition could never actually persist.
	Status          string    `db:"status" json:"status"`
	CurrentFlowStep string    `db:"currentFlowStep" json:"current_flow_step"`
	CreatedAt       time.Time `db:"createdAt" json:"created_at"`
	UpdatedAt       time.Time `db:"updatedAt" json:"updated_at"`
}

type DB struct{ db *sqlx.DB }

func NewPostgres(dsn string) (*DB, error) {
	db, err := sqlx.Connect("postgres", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(25)
	db.SetMaxIdleConns(10)
	db.SetConnMaxLifetime(5 * time.Minute)
	return &DB{db: db}, nil
}

func (d *DB) UpsertCustomer(ctx context.Context, tenantID uuid.UUID, phone, name string) (*CustomerRow, error) {
	var c CustomerRow
	err := d.db.GetContext(ctx, &c, `
		INSERT INTO customers (id, "tenantId", "whatsappPhone", name, "createdAt", "updatedAt")
		VALUES ($1, $2, $3, $4, NOW(), NOW())
		ON CONFLICT ("tenantId", "whatsappPhone") DO UPDATE
		  SET name = EXCLUDED.name, "updatedAt" = NOW()
		RETURNING id, "tenantId", "whatsappPhone", name`,
		uuid.New(), tenantID, phone, name,
	)
	return &c, err
}

// GetOrCreateConversation takes chatwootConvID as a string — the real column
// is a varchar, not an integer (Chatwoot IDs are numeric but this schema
// never constrained them to a numeric type).
func (d *DB) GetOrCreateConversation(ctx context.Context, tenantID, customerID uuid.UUID, chatwootConvID string) (*ConversationRow, error) {
	var c ConversationRow
	err := d.db.GetContext(ctx, &c, `
		SELECT id, "tenantId", "customerId", "chatwootConversationId", status, "currentFlowStep", "createdAt", "updatedAt"
		FROM conversations
		WHERE "tenantId"=$1 AND "customerId"=$2 AND "chatwootConversationId"=$3 AND status NOT IN ('resolved')
		ORDER BY "createdAt" DESC LIMIT 1`, tenantID, customerID, chatwootConvID)
	if err != nil {
		c = ConversationRow{
			ID:                     uuid.New(),
			TenantID:               tenantID,
			CustomerID:             customerID,
			ChatwootConversationID: chatwootConvID,
			Status:                 "open",
			CurrentFlowStep:        "greeting",
			CreatedAt:              time.Now(),
			UpdatedAt:              time.Now(),
		}
		_, err = d.db.ExecContext(ctx, `
			INSERT INTO conversations (id, "tenantId", "customerId", "chatwootConversationId", status, "currentFlowStep", "createdAt", "updatedAt")
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
			c.ID, c.TenantID, c.CustomerID, c.ChatwootConversationID, c.Status, c.CurrentFlowStep, c.CreatedAt, c.UpdatedAt)
	}
	return &c, err
}

func (d *DB) UpdateConversationState(ctx context.Context, id uuid.UUID, status string) error {
	_, err := d.db.ExecContext(ctx, `UPDATE conversations SET status=$1, "updatedAt"=NOW() WHERE id=$2`, status, id)
	return err
}

// UpdateConversationLastMessage bumps the conversation's activity. There is
// no last_message_at column in the real schema — messageCount is the real
// column this schema uses to track conversation activity, so this
// increments it instead of writing a timestamp nothing reads.
func (d *DB) UpdateConversationLastMessage(ctx context.Context, id uuid.UUID) {
	d.db.ExecContext(ctx, `UPDATE conversations SET "messageCount" = "messageCount" + 1, "updatedAt"=NOW() WHERE id=$1`, id)
}

func (d *DB) ListConversations(ctx context.Context, tenantID uuid.UUID, limit, offset int) ([]ConversationRow, error) {
	var rows []ConversationRow
	err := d.db.SelectContext(ctx, &rows, `
		SELECT id, "tenantId", "customerId", "chatwootConversationId", status, "currentFlowStep", "createdAt", "updatedAt"
		FROM conversations WHERE "tenantId"=$1 ORDER BY "updatedAt" DESC LIMIT $2 OFFSET $3`,
		tenantID, limit, offset)
	return rows, err
}

// === W45 go-rust-services (MSG-17) ===
// GetConversationByID loads a conversation by primary key (tenant scope is
// enforced by callers that already authorized the tenant).
func (d *DB) GetConversationByID(ctx context.Context, id uuid.UUID) (*ConversationRow, error) {
	var c ConversationRow
	err := d.db.GetContext(ctx, &c, `
		SELECT id, "tenantId", "customerId", "chatwootConversationId", status, "currentFlowStep", "createdAt", "updatedAt"
		FROM conversations WHERE id=$1`, id)
	return &c, err
}

func (d *DB) GetConversation(ctx context.Context, tenantID, id uuid.UUID) (*ConversationRow, error) {
	var c ConversationRow
	err := d.db.GetContext(ctx, &c, `
		SELECT id, "tenantId", "customerId", "chatwootConversationId", status, "currentFlowStep", "createdAt", "updatedAt"
		FROM conversations WHERE "tenantId"=$1 AND id=$2`, tenantID, id)
	return &c, err
}
