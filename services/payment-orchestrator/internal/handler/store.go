package handler

import (
	"context"

	"github.com/google/uuid"
	"github.com/whatsapp-commerce/payment-orchestrator/internal/store"
)

// Store is the subset of *store.DB the Handler depends on. Extracted so
// tests can inject a fake instead of a real Postgres connection (same
// pattern as commerce-engine/internal/handler and webhook-ingestor's
// Publisher interface).
type Store interface {
	CreatePaymentIntent(ctx context.Context, p store.PaymentIntentRow) (created bool, err error)
	GetPaymentIntent(ctx context.Context, tenantID, id uuid.UUID) (*store.PaymentIntentRow, error)
	GetPaymentIntentByIdempotencyKey(ctx context.Context, tenantID uuid.UUID, key string) (*store.PaymentIntentRow, error)
	GetPaymentIntentByMojaloop(ctx context.Context, transferID string) (*store.PaymentIntentRow, error)
	SetLedgerPendingID(ctx context.Context, id uuid.UUID, pendingID string) error
	SetProviderReference(ctx context.Context, id uuid.UUID, providerRef string) error
	UpdatePaymentStatus(ctx context.Context, id uuid.UUID, status, reason string) error
}

var _ Store = (*store.DB)(nil)
