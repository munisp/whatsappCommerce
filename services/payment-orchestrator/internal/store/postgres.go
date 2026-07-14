package store

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/jmoiron/sqlx"
	_ "github.com/lib/pq"
)

type PaymentIntentRow struct {
	ID                    uuid.UUID  `db:"id"`
	TenantID              uuid.UUID  `db:"tenant_id"`
	OrderID               uuid.UUID  `db:"order_id"`
	CustomerID            uuid.UUID  `db:"customer_id"`
	Status                string     `db:"status"`
	Amount                float64    `db:"amount"`
	Currency              string     `db:"currency"`
	Provider              string     `db:"provider"`
	WorkflowID            string     `db:"workflow_id"`
	MojaloopTransferID    string     `db:"mojaloop_transfer_id"`
	TigerBeetlePendingID  string     `db:"tigerbeetle_pending_id"`
	IdempotencyKey        string     `db:"idempotency_key"`
	FailureReason         string     `db:"failure_reason"`
	CompletedAt           *time.Time `db:"completed_at"`
	CreatedAt             time.Time  `db:"created_at"`
	UpdatedAt             time.Time  `db:"updated_at"`
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

func (d *DB) CreatePaymentIntent(ctx context.Context, p PaymentIntentRow) error {
	_, err := d.db.ExecContext(ctx, `
		INSERT INTO payment_intents (id, tenant_id, order_id, customer_id, status, amount, currency, provider, workflow_id, mojaloop_transfer_id, tigerbeetle_pending_id, idempotency_key, created_at, updated_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
		ON CONFLICT (idempotency_key) DO NOTHING`,
		p.ID, p.TenantID, p.OrderID, p.CustomerID, p.Status, p.Amount, p.Currency, p.Provider, p.WorkflowID, p.MojaloopTransferID, p.TigerBeetlePendingID, p.IdempotencyKey, p.CreatedAt, p.UpdatedAt)
	return err
}

func (d *DB) GetPaymentIntent(ctx context.Context, tenantID, id uuid.UUID) (*PaymentIntentRow, error) {
	var p PaymentIntentRow
	err := d.db.GetContext(ctx, &p, `
		SELECT id, tenant_id, order_id, customer_id, status, amount, currency, provider, workflow_id, mojaloop_transfer_id, tigerbeetle_pending_id, idempotency_key, failure_reason, completed_at, created_at, updated_at
		FROM payment_intents WHERE tenant_id=$1 AND id=$2`, tenantID, id)
	return &p, err
}

func (d *DB) GetPaymentIntentByMojaloop(ctx context.Context, transferID string) (*PaymentIntentRow, error) {
	var p PaymentIntentRow
	err := d.db.GetContext(ctx, &p, `
		SELECT id, tenant_id, order_id, customer_id, status, amount, currency, provider, workflow_id, mojaloop_transfer_id, tigerbeetle_pending_id, idempotency_key, failure_reason, completed_at, created_at, updated_at
		FROM payment_intents WHERE mojaloop_transfer_id=$1`, transferID)
	return &p, err
}

func (d *DB) UpdatePaymentStatus(ctx context.Context, id uuid.UUID, status, reason string) error {
	now := time.Now()
	var completedAt *time.Time
	if status == "completed" || status == "failed" || status == "voided" {
		completedAt = &now
	}
	_, err := d.db.ExecContext(ctx, `
		UPDATE payment_intents SET status=$1, failure_reason=$2, completed_at=$3, updated_at=NOW() WHERE id=$4`,
		status, reason, completedAt, id)
	return err
}

