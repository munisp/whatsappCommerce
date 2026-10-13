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

// allowedTransitions is the payment intent state machine, restricted to the
// real payment_intent_status enum members (drizzle/schema.ts:
// initiated|pending|completed|failed|cancelled|refunded). The previous
// version of this file also wrote "voided", "refund_pending" and
// "ledger_drift" — none of which are valid enum values, so every write of
// one of them would have failed at the database level. "voided" is now
// "cancelled" (a real top-level status). "refund_pending" and "ledger_drift"
// were never really separate terminal/intermediate STATUSES so much as
// operational flags layered on top of a real status while something needs
// manual reconciliation — they are now metadata flags (see
// SetLedgerDriftFlag / SetRefundPendingFlag) that don't consume a status
// transition at all, exactly matching the original comment that
// "ledger_drift is only left via explicit repair actions": entering it was
// never meant to look like an ordinary state change.
var allowedTransitions = map[string][]string{
	"pending":   {"initiated", "failed", "cancelled"},
	"initiated": {"completed", "failed", "cancelled"},
	"completed": {"refunded"},
	"failed":    {},
	"refunded":  {},
	"cancelled": {},
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

// PaymentIntentRow matches the real payment_intents columns. There is no
// workflow_id column at all in the real schema (every CreatePaymentIntent
// insert that included it was failing outright before this fix). Mojaloop's
// transfer id and TigerBeetle's pending id both live in the generic
// providerPaymentId / ledgerPendingId columns, not provider-specific ones.
type PaymentIntentRow struct {
	ID                uuid.UUID  `db:"id" json:"id"`
	TenantID          uuid.UUID  `db:"tenantId" json:"tenant_id"`
	OrderID           uuid.UUID  `db:"orderId" json:"order_id"`
	CustomerID        uuid.UUID  `db:"customerId" json:"customer_id"`
	Status            string     `db:"status" json:"status"`
	Amount            float64    `db:"amount" json:"amount"`
	Currency          string     `db:"currency" json:"currency"`
	Provider          string     `db:"provider" json:"provider"`
	ProviderPaymentID string     `db:"providerPaymentId" json:"provider_payment_id"`
	LedgerPendingID   string     `db:"ledgerPendingId" json:"ledger_pending_id"`
	IdempotencyKey    string     `db:"idempotencyKey" json:"idempotency_key"`
	FailureReason     string     `db:"failureReason" json:"failure_reason"`
	// Metadata carries operational flags the enum can't express — see
	// SetLedgerDriftFlag / SetRefundPendingFlag.
	Metadata    []byte     `db:"metadata" json:"metadata,omitempty"`
	CompletedAt *time.Time `db:"completedAt" json:"completed_at,omitempty"`
	CreatedAt   time.Time  `db:"createdAt" json:"created_at"`
	UpdatedAt   time.Time  `db:"updatedAt" json:"updated_at"`
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
		INSERT INTO payment_intents (id, "tenantId", "orderId", "customerId", status, amount, currency, provider, "providerPaymentId", "ledgerPendingId", "idempotencyKey", "createdAt", "updatedAt")
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
		ON CONFLICT ("idempotencyKey") DO NOTHING`,
		p.ID, p.TenantID, p.OrderID, p.CustomerID, p.Status, p.Amount, p.Currency, p.Provider, p.ProviderPaymentID, p.LedgerPendingID, p.IdempotencyKey, p.CreatedAt, p.UpdatedAt)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, err
	}
	return n > 0, nil
}

const intentColumns = `id, "tenantId", "orderId", "customerId", status, amount, currency, provider, "providerPaymentId", "ledgerPendingId", "idempotencyKey", "failureReason", metadata, "completedAt", "createdAt", "updatedAt"`

func (d *DB) GetPaymentIntent(ctx context.Context, tenantID, id uuid.UUID) (*PaymentIntentRow, error) {
	var p PaymentIntentRow
	err := d.db.GetContext(ctx, &p, `
		SELECT `+intentColumns+`
		FROM payment_intents WHERE "tenantId"=$1 AND id=$2`, tenantID, id)
	return &p, err
}

// GetPaymentIntentByIdempotencyKey loads the existing intent for an
// idempotency key (used to make initiation idempotent).
func (d *DB) GetPaymentIntentByIdempotencyKey(ctx context.Context, tenantID uuid.UUID, key string) (*PaymentIntentRow, error) {
	var p PaymentIntentRow
	err := d.db.GetContext(ctx, &p, `
		SELECT `+intentColumns+`
		FROM payment_intents WHERE "tenantId"=$1 AND "idempotencyKey"=$2`, tenantID, key)
	return &p, err
}

func (d *DB) GetPaymentIntentByMojaloop(ctx context.Context, transferID string) (*PaymentIntentRow, error) {
	var p PaymentIntentRow
	err := d.db.GetContext(ctx, &p, `
		SELECT `+intentColumns+`
		FROM payment_intents WHERE "providerPaymentId"=$1`, transferID)
	return &p, err
}

// SetLedgerPendingID persists the TigerBeetle pending transfer id so that
// commit/void/reverse and reconciliation can find it later.
func (d *DB) SetLedgerPendingID(ctx context.Context, id uuid.UUID, pendingID string) error {
	_, err := d.db.ExecContext(ctx, `
		UPDATE payment_intents SET "ledgerPendingId"=$1, "updatedAt"=NOW() WHERE id=$2`,
		pendingID, id)
	return err
}

// SetProviderReference persists the provider-side reference (Mojaloop transfer
// id, Stripe checkout session/payment_intent id, ...) used by callbacks and
// refunds.
func (d *DB) SetProviderReference(ctx context.Context, id uuid.UUID, providerRef string) error {
	_, err := d.db.ExecContext(ctx, `
		UPDATE payment_intents SET "providerPaymentId"=$1, "updatedAt"=NOW() WHERE id=$2`,
		providerRef, id)
	return err
}

// UpdatePaymentStatus performs a GUARDED state-machine transition: the update
// only applies when the current status is an allowed predecessor of the
// target status. Terminal states (completed/refunded/cancelled/failed) can
// never be regressed by out-of-order callbacks. Returns ErrInvalidTransition
// when the transition is not permitted.
func (d *DB) UpdatePaymentStatus(ctx context.Context, id uuid.UUID, status, reason string) error {
	from := predecessors(status)
	if len(from) == 0 {
		return fmt.Errorf("%w: no state may transition to %q", ErrInvalidTransition, status)
	}
	now := time.Now()
	var completedAt *time.Time
	if status == "completed" || status == "failed" || status == "cancelled" || status == "refunded" {
		completedAt = &now
	}
	res, err := d.db.ExecContext(ctx, `
		UPDATE payment_intents SET status=$1, "failureReason"=$2, "completedAt"=$3, "updatedAt"=NOW()
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

// SetLedgerDriftFlag merges a ledger_drift marker into metadata WITHOUT
// performing a guarded status transition — "ledger_drift" is not a valid
// payment_intent_status enum member in the real schema, and (per the
// original design intent) entering drift should never look like an ordinary
// state change: the status stays at whatever it already honestly was, and
// reconciliation finds drifted intents via metadata->>'ledger_drift'
// instead of status = 'ledger_drift'.
func (d *DB) SetLedgerDriftFlag(ctx context.Context, id uuid.UUID, reason string) error {
	_, err := d.db.ExecContext(ctx, `
		UPDATE payment_intents
		SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('ledger_drift', true, 'drift_reason', $1, 'drift_at', NOW()),
		    "updatedAt" = NOW()
		WHERE id = $2`, reason, id)
	return err
}

// SetRefundPendingFlag merges a refund-pending marker into metadata WITHOUT
// performing a guarded status transition. "refund_pending" is not a valid
// enum member — the intent stays "completed" (the real status closest to
// "paid, refund in flight but not provider-confirmed") while ops/
// reconciliation query metadata->>'refund_state' instead.
func (d *DB) SetRefundPendingFlag(ctx context.Context, id uuid.UUID, reason string) error {
	_, err := d.db.ExecContext(ctx, `
		UPDATE payment_intents
		SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('refund_state', 'pending', 'refund_pending_reason', $1, 'refund_pending_at', NOW()),
		    "updatedAt" = NOW()
		WHERE id = $2`, reason, id)
	return err
}
