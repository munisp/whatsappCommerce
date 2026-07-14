package store

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/jmoiron/sqlx"
	_ "github.com/lib/pq"
)

type CustomerRow struct {
	ID          uuid.UUID `db:"id"`
	TenantID    uuid.UUID `db:"tenant_id"`
	PhoneNumber string    `db:"phone_number"`
	DisplayName string    `db:"display_name"`
	IsVerified  bool      `db:"is_verified"`
}

type ConversationRow struct {
	ID              uuid.UUID `db:"id"`
	TenantID        uuid.UUID `db:"tenant_id"`
	CustomerID      uuid.UUID `db:"customer_id"`
	ChatwootConvID  int64     `db:"chatwoot_conv_id"`
	State           string    `db:"state"`
	Mode            string    `db:"mode"`
	CurrentFlowStep string    `db:"current_flow_step"`
	CartID          *uuid.UUID `db:"cart_id"`
	WorkflowID      string    `db:"workflow_id"`
	LastMessageAt   time.Time `db:"last_message_at"`
	CreatedAt       time.Time `db:"created_at"`
	UpdatedAt       time.Time `db:"updated_at"`
}

type MessageRow struct {
	ID             uuid.UUID  `db:"id"`
	TenantID       uuid.UUID  `db:"tenant_id"`
	ConversationID uuid.UUID  `db:"conversation_id"`
	Direction      string     `db:"direction"`
	Content        string     `db:"content"`
	ContentType    string     `db:"content_type"`
	IdempotencyKey string     `db:"idempotency_key"`
	ExternalMsgID  string     `db:"external_msg_id"`
	ProcessedAt    *time.Time `db:"processed_at"`
	CreatedAt      time.Time  `db:"created_at"`
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
		INSERT INTO customers (id, tenant_id, phone_number, display_name, is_verified, created_at, updated_at)
		VALUES ($1, $2, $3, $4, false, NOW(), NOW())
		ON CONFLICT (tenant_id, phone_number) DO UPDATE
		  SET display_name = EXCLUDED.display_name, updated_at = NOW()
		RETURNING id, tenant_id, phone_number, display_name, is_verified`,
		uuid.New(), tenantID, phone, name,
	)
	return &c, err
}

func (d *DB) GetOrCreateConversation(ctx context.Context, tenantID, customerID uuid.UUID, chatwootConvID int64) (*ConversationRow, error) {
	var c ConversationRow
	err := d.db.GetContext(ctx, &c, `
		SELECT id, tenant_id, customer_id, chatwoot_conv_id, state, mode, current_flow_step, cart_id, workflow_id, last_message_at, created_at, updated_at
		FROM conversations
		WHERE tenant_id=$1 AND customer_id=$2 AND chatwoot_conv_id=$3 AND state NOT IN ('resolved','expired')
		ORDER BY created_at DESC LIMIT 1`, tenantID, customerID, chatwootConvID)
	if err != nil {
		// Create new conversation
		c = ConversationRow{
			ID:             uuid.New(),
			TenantID:       tenantID,
			CustomerID:     customerID,
			ChatwootConvID: chatwootConvID,
			State:          "active",
			Mode:           "menu",
			LastMessageAt:  time.Now(),
			CreatedAt:      time.Now(),
			UpdatedAt:      time.Now(),
		}
		_, err = d.db.ExecContext(ctx, `
			INSERT INTO conversations (id, tenant_id, customer_id, chatwoot_conv_id, state, mode, current_flow_step, last_message_at, created_at, updated_at)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
			c.ID, c.TenantID, c.CustomerID, c.ChatwootConvID, c.State, c.Mode, "", c.LastMessageAt, c.CreatedAt, c.UpdatedAt)
	}
	return &c, err
}

func (d *DB) SaveMessage(ctx context.Context, m MessageRow) error {
	_, err := d.db.ExecContext(ctx, `
		INSERT INTO messages (id, tenant_id, conversation_id, direction, content, content_type, idempotency_key, external_msg_id, created_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
		ON CONFLICT (idempotency_key) DO NOTHING`,
		m.ID, m.TenantID, m.ConversationID, m.Direction, m.Content, m.ContentType, m.IdempotencyKey, m.ExternalMsgID, m.CreatedAt)
	return err
}

func (d *DB) UpdateConversationState(ctx context.Context, id uuid.UUID, state string) error {
	_, err := d.db.ExecContext(ctx, `UPDATE conversations SET state=$1, updated_at=NOW() WHERE id=$2`, state, id)
	return err
}

func (d *DB) UpdateConversationLastMessage(ctx context.Context, id uuid.UUID, t time.Time) {
	d.db.ExecContext(ctx, `UPDATE conversations SET last_message_at=$1, updated_at=NOW() WHERE id=$2`, t, id)
}

func (d *DB) ListConversations(ctx context.Context, tenantID uuid.UUID, limit, offset int) ([]ConversationRow, error) {
	var rows []ConversationRow
	err := d.db.SelectContext(ctx, &rows, `
		SELECT id, tenant_id, customer_id, chatwoot_conv_id, state, mode, current_flow_step, cart_id, workflow_id, last_message_at, created_at, updated_at
		FROM conversations WHERE tenant_id=$1 ORDER BY last_message_at DESC LIMIT $2 OFFSET $3`,
		tenantID, limit, offset)
	return rows, err
}

func (d *DB) GetConversation(ctx context.Context, tenantID, id uuid.UUID) (*ConversationRow, error) {
	var c ConversationRow
	err := d.db.GetContext(ctx, &c, `
		SELECT id, tenant_id, customer_id, chatwoot_conv_id, state, mode, current_flow_step, cart_id, workflow_id, last_message_at, created_at, updated_at
		FROM conversations WHERE tenant_id=$1 AND id=$2`, tenantID, id)
	return &c, err
}

func (d *DB) GetMessages(ctx context.Context, tenantID, convID uuid.UUID, limit int) ([]MessageRow, error) {
	var rows []MessageRow
	err := d.db.SelectContext(ctx, &rows, `
		SELECT id, tenant_id, conversation_id, direction, content, content_type, idempotency_key, external_msg_id, processed_at, created_at
		FROM messages WHERE tenant_id=$1 AND conversation_id=$2 ORDER BY created_at DESC LIMIT $3`,
		tenantID, convID, limit)
	return rows, err
}

