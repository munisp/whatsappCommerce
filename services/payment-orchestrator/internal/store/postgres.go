package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jmoiron/sqlx"
	"github.com/lib/pq"
)

// ErrInvalidTransition is returned by UpdatePaymentStatus when the requested
// status change is not permitted from the intent's current status (including
// no-op writes to terminal states).
var ErrInvalidTransition = errors.New("invalid payment status transition")

// allowedTransitions is the payment intent state machine. States with an
// empty target list (failed/refunded/voided) are terminal and can never be
// regressed by out-of-order callbacks.
// "ledger_drift" marks intents whose provider-side state succeeded but whose
// ledger commit/void could not be confirmed — reconciliation must repair them.
var allowedTransitions = map[string][]string{
	"pending":        {"initiated", "failed", "voided", "ledger_drift"},
	"initiated":      {"completed", "failed", "voided", "ledger_drift"},
	"completed":      {"refunded", "refund_pending", "ledger_drift"},
	"refund_pending": {"refunded", "failed"},
	// ledger_drift is only left via explicit repair actions.
	"ledger_drift": {"completed", "voided"},
	"failed":       {},
	"refunded":     {},
	"voided":       {},
}

// predecessors returns the states from which `target` may be reached.
func predecessors(target string) []string {
	var from []string
	for state, targets := range allowedTransitions {
		for _, t := range targets {
			if t == target {
				from = append(from, state)
				break
			}
		}
	}
	return from
}

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

// CreatePaymentIntent inserts a new intent. It returns created=false (and a
// nil error) when the idempotency key already exists — the caller MUST load
// and return the existing intent instead of proceeding, or the payment would
// be initiated twice.
func (d *DB) CreatePaymentIntent(ctx context.Context, p PaymentIntentRow) (created bool, err error) {
	res, err := d.db.ExecContext(ctx, `
		INSERT INTO payment_intents (id, tenant_id, order_id, customer_id, status, amount, currency, provider, workflow_id, mojaloop_transfer_id, tigerbeetle_pending_id, idempotency_key, created_at, updated_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
		ON CONFLICT (idempotency_key) DO NOTHING`,
		p.ID, p.TenantID, p.OrderID, p.CustomerID, p.Status, p.Amount, p.Currency, p.Provider, p.WorkflowID, p.MojaloopTransferID, p.TigerBeetlePendingID, p.IdempotencyKey, p.CreatedAt, p.UpdatedAt)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, err
	}
	return n > 0, nil
}

const intentColumns = `id, tenant_id, order_id, customer_id, status, amount, currency, provider, workflow_id, mojaloop_transfer_id, tigerbeetle_pending_id, idempotency_key, failure_reason, completed_at, created_at, updated_at`

func (d *DB) GetPaymentIntent(ctx context.Context, tenantID, id uuid.UUID) (*PaymentIntentRow, error) {
	var p PaymentIntentRow
	err := d.db.GetContext(ctx, &p, `
		SELECT `+intentColumns+`
		FROM payment_intents WHERE tenant_id=$1 AND id=$2`, tenantID, id)
	return &p, err
}

// GetPaymentIntentByIdempotencyKey loads the existing intent for an
// idempotency key (used to make initiation idempotent).
func (d *DB) GetPaymentIntentByIdempotencyKey(ctx context.Context, tenantID uuid.UUID, key string) (*PaymentIntentRow, error) {
	var p PaymentIntentRow
	err := d.db.GetContext(ctx, &p, `
		SELECT `+intentColumns+`
		FROM payment_intents WHERE tenant_id=$1 AND idempotency_key=$2`, tenantID, key)
	return &p, err
}

func (d *DB) GetPaymentIntentByMojaloop(ctx context.Context, transferID string) (*PaymentIntentRow, error) {
	var p PaymentIntentRow
	err := d.db.GetContext(ctx, &p, `
		SELECT `+intentColumns+`
		FROM payment_intents WHERE mojaloop_transfer_id=$1`, transferID)
	return &p, err
}

// SetLedgerPendingID persists the TigerBeetle pending transfer id so that
// commit/void/reverse and reconciliation can find it later.
func (d *DB) SetLedgerPendingID(ctx context.Context, id uuid.UUID, pendingID string) error {
	_, err := d.db.ExecContext(ctx, `
		UPDATE payment_intents SET tigerbeetle_pending_id=$1, updated_at=NOW() WHERE id=$2`,
		pendingID, id)
	return err
}

// SetProviderReference persists the provider-side reference (Mojaloop transfer
// id, Stripe checkout session/payment_intent id, ...) used by callbacks and
// refunds.
func (d *DB) SetProviderReference(ctx context.Context, id uuid.UUID, providerRef string) error {
	_, err := d.db.ExecContext(ctx, `
		UPDATE payment_intents SET mojaloop_transfer_id=$1, updated_at=NOW() WHERE id=$2`,
		providerRef, id)
	return err
}

// UpdatePaymentStatus performs a GUARDED state-machine transition: the update
// only applies when the current status is an allowed predecessor of the
// target status. Terminal states (completed/refunded/voided/failed) can never
// be regressed by out-of-order callbacks. Returns ErrInvalidTransition when
// the transition is not permitted.
func (d *DB) UpdatePaymentStatus(ctx context.Context, id uuid.UUID, status, reason string) error {
	from := predecessors(status)
	if len(from) == 0 {
		return fmt.Errorf("%w: no state may transition to %q", ErrInvalidTransition, status)
	}
	now := time.Now()
	var completedAt *time.Time
	if status == "completed" || status == "failed" || status == "voided" || status == "refunded" {
		completedAt = &now
	}
	res, err := d.db.ExecContext(ctx, `
		UPDATE payment_intents SET status=$1, failure_reason=$2, completed_at=$3, updated_at=NOW()
		WHERE id=$4 AND status = ANY($5)`,
		status, reason, completedAt, id, pq.Array(from))
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return fmt.Errorf("%w: cannot move payment %s to %q from its current state", ErrInvalidTransition, id, status)
	}
	return nil
}
