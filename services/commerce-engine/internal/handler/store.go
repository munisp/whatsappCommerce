package handler

import (
	"context"

	"github.com/google/uuid"
	"github.com/whatsapp-commerce/commerce-engine/internal/store"
)

// Store is the subset of *store.DB the Handler depends on. Extracted so tests
// can inject a fake instead of a real Postgres connection (same pattern as
// webhook-ingestor/internal/handler's Publisher interface).
type Store interface {
	ListProducts(ctx context.Context, tenantID uuid.UUID, category string, limit, offset int) ([]store.ProductRow, error)
	GetProduct(ctx context.Context, tenantID, id uuid.UUID) (*store.ProductRow, error)
	SearchProducts(ctx context.Context, tenantID uuid.UUID, q string, limit int) ([]store.ProductRow, error)
	GetStockLevel(ctx context.Context, tenantID uuid.UUID, sku string) (*store.StockRow, error)
	UpsertProduct(ctx context.Context, p store.ProductRow) error
	UpsertStockLevel(ctx context.Context, s store.StockRow) error
	CreateCart(ctx context.Context, c store.CartRow) error
	GetCart(ctx context.Context, tenantID, id uuid.UUID) (*store.CartRow, error)
	GetCartItems(ctx context.Context, cartID uuid.UUID) ([]store.CartItemRow, error)
	AddCartItem(ctx context.Context, item store.CartItemRow) error
	RemoveCartItem(ctx context.Context, cartID, itemID uuid.UUID) error
	UpdateCartStatus(ctx context.Context, id uuid.UUID, status string) error
	CreateOrder(ctx context.Context, o store.OrderRow) error
	GetOrder(ctx context.Context, tenantID, id uuid.UUID) (*store.OrderRow, error)
	ListOrders(ctx context.Context, tenantID uuid.UUID, limit, offset int) ([]store.OrderRow, error)
	UpdateOrderStatus(ctx context.Context, id uuid.UUID, status string) error
}

var _ Store = (*store.DB)(nil)
