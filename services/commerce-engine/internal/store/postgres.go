package store

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/jmoiron/sqlx"
	_ "github.com/lib/pq"
)

// Column names below are quoted to match the real schema (drizzle/schema.ts),
// which uses camelCase identifiers, not the snake_case this file previously
// assumed. "carts" and "stock_levels" never existed as separate tables in the
// real schema: a cart is a cart_sessions row (the same session object the
// conversational flow uses — see cartSessions in schema.ts, which also carries
// chat-wizard fields like sessionData/currentStep that this service does not
// touch), and stock lives directly on products.stockQuantity.

type ProductRow struct {
	ID          uuid.UUID `db:"id" json:"id"`
	TenantID    uuid.UUID `db:"tenantId" json:"tenant_id"`
	SKU         string    `db:"sku" json:"sku"`
	Name        string    `db:"name" json:"name"`
	Description string    `db:"description" json:"description"`
	Category    string    `db:"category" json:"category"`
	Price       float64   `db:"price" json:"price"`
	Currency    string    `db:"currency" json:"currency"`
	ImageURL    string    `db:"imageUrl" json:"image_url"`
	// Status is the real enum column (product_status: active|inactive|archived).
	// The old code used a boolean is_active column that never existed.
	Status        string    `db:"status" json:"status"`
	StockQuantity int       `db:"stockQuantity" json:"stock_quantity"`
	CreatedAt     time.Time `db:"createdAt" json:"created_at"`
	UpdatedAt     time.Time `db:"updatedAt" json:"updated_at"`
}

// CartRow represents a cart_sessions row used as a cart. Only the fields
// commerce-engine actually needs are modelled here; the session also carries
// chat-wizard fields (sessionData/currentStep/language) this service leaves
// alone (and lets default) since they belong to the conversational flow.
type CartRow struct {
	ID         uuid.UUID `db:"id" json:"id"`
	TenantID   uuid.UUID `db:"tenantId" json:"tenant_id"`
	CustomerID uuid.UUID `db:"customerId" json:"customer_id"`
	ExpiresAt  time.Time `db:"expiresAt" json:"expires_at"`
	CreatedAt  time.Time `db:"createdAt" json:"created_at"`
	UpdatedAt  time.Time `db:"updatedAt" json:"updated_at"`
}

// CartItemRow matches the real cart_items columns. There is no stored sku or
// total_price — total is unitPrice * quantity, computed by callers.
type CartItemRow struct {
	ID            uuid.UUID `db:"id" json:"id"`
	CartSessionID uuid.UUID `db:"cartSessionId" json:"cart_session_id"`
	ProductID     uuid.UUID `db:"productId" json:"product_id"`
	ProductName   string    `db:"productName" json:"product_name"`
	Quantity      int       `db:"quantity" json:"quantity"`
	UnitPrice     float64   `db:"unitPrice" json:"unit_price"`
	Currency      string    `db:"currency" json:"currency"`
	CreatedAt     time.Time `db:"createdAt" json:"created_at"`
}

// TotalPrice is derived, not stored — kept as a method so handler code reads
// the same as before without a stored (and therefore staleness-prone) column.
func (c CartItemRow) TotalPrice() float64 { return c.UnitPrice * float64(c.Quantity) }

// OrderRow matches the real orders columns this service needs. Several real
// columns (tipCents, isGift, giftWrapFeeCents, codState, deliverySlotId,
// shippingAddress, conversationId, metadata...) are intentionally left to their
// schema defaults here — commerce-engine's checkout flow has no basis to set
// business values for fields it doesn't collect input for.
type OrderRow struct {
	ID            uuid.UUID       `db:"id" json:"id"`
	TenantID      uuid.UUID       `db:"tenantId" json:"tenant_id"`
	CustomerID    uuid.UUID       `db:"customerId" json:"customer_id"`
	OrderNumber   string          `db:"orderNumber" json:"order_number"`
	Status        string          `db:"status" json:"status"`
	TotalAmount   float64         `db:"totalAmount" json:"total_amount"`
	Currency      string          `db:"currency" json:"currency"`
	PaymentStatus string          `db:"paymentStatus" json:"payment_status"`
	Items         []byte          `db:"items" json:"items"` // JSON snapshot of the cart items at checkout
	Notes         string          `db:"notes" json:"notes"`
	ErpOrderID    *string         `db:"erpOrderId" json:"erp_order_id,omitempty"`
	CreatedAt     time.Time       `db:"createdAt" json:"created_at"`
	UpdatedAt     time.Time       `db:"updatedAt" json:"updated_at"`
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

func (d *DB) ListProducts(ctx context.Context, tenantID uuid.UUID, category string, limit, offset int) ([]ProductRow, error) {
	var rows []ProductRow
	query := `SELECT id, "tenantId", sku, name, description, category, price, currency, "imageUrl", status, "stockQuantity", "createdAt", "updatedAt"
		FROM products WHERE "tenantId"=$1 AND status='active'`
	args := []interface{}{tenantID}
	if category != "" {
		query += " AND category=$2 ORDER BY name LIMIT $3 OFFSET $4"
		args = append(args, category, limit, offset)
	} else {
		query += " ORDER BY name LIMIT $2 OFFSET $3"
		args = append(args, limit, offset)
	}
	err := d.db.SelectContext(ctx, &rows, query, args...)
	return rows, err
}

func (d *DB) GetProduct(ctx context.Context, tenantID, id uuid.UUID) (*ProductRow, error) {
	var p ProductRow
	err := d.db.GetContext(ctx, &p, `SELECT id, "tenantId", sku, name, description, category, price, currency, "imageUrl", status, "stockQuantity", "createdAt", "updatedAt" FROM products WHERE "tenantId"=$1 AND id=$2`, tenantID, id)
	return &p, err
}

func (d *DB) SearchProducts(ctx context.Context, tenantID uuid.UUID, q string, limit int) ([]ProductRow, error) {
	var rows []ProductRow
	err := d.db.SelectContext(ctx, &rows, `
		SELECT id, "tenantId", sku, name, description, category, price, currency, "imageUrl", status, "stockQuantity", "createdAt", "updatedAt"
		FROM products WHERE "tenantId"=$1 AND status='active'
		AND (name ILIKE $2 OR description ILIKE $2 OR sku ILIKE $2)
		ORDER BY name LIMIT $3`, tenantID, "%"+q+"%", limit)
	return rows, err
}

// GetStockLevel reads stock directly from products.stockQuantity — there is
// no separate stock_levels table (and therefore no warehouse/reserved/on-hand
// breakdown) in the real schema.
func (d *DB) GetStockLevel(ctx context.Context, tenantID uuid.UUID, sku string) (*ProductRow, error) {
	var p ProductRow
	err := d.db.GetContext(ctx, &p, `SELECT id, "tenantId", sku, name, description, category, price, currency, "imageUrl", status, "stockQuantity", "createdAt", "updatedAt" FROM products WHERE "tenantId"=$1 AND sku=$2`, tenantID, sku)
	return &p, err
}

func (d *DB) UpsertProduct(ctx context.Context, p ProductRow) error {
	_, err := d.db.ExecContext(ctx, `
		INSERT INTO products (id, "tenantId", sku, name, description, category, price, currency, "imageUrl", status, "stockQuantity", "createdAt", "updatedAt")
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
		ON CONFLICT ("tenantId", sku) DO UPDATE SET name=EXCLUDED.name, description=EXCLUDED.description, price=EXCLUDED.price, "updatedAt"=NOW()`,
		p.ID, p.TenantID, p.SKU, p.Name, p.Description, p.Category, p.Price, p.Currency, p.ImageURL, p.Status, p.StockQuantity, p.CreatedAt, p.UpdatedAt)
	return err
}

// UpsertStockLevel updates products.stockQuantity for the given SKU — see
// GetStockLevel for why this is a products update, not a separate table.
func (d *DB) UpsertStockLevel(ctx context.Context, tenantID uuid.UUID, sku string, quantity int) error {
	_, err := d.db.ExecContext(ctx, `UPDATE products SET "stockQuantity"=$1, "updatedAt"=NOW() WHERE "tenantId"=$2 AND sku=$3`, quantity, tenantID, sku)
	return err
}

// CreateCart creates a new cart_sessions row. Chat-wizard-only fields
// (sessionData/currentStep/language) are left to their schema defaults;
// commerce-engine has no input to set them meaningfully.
func (d *DB) CreateCart(ctx context.Context, c CartRow) error {
	_, err := d.db.ExecContext(ctx, `
		INSERT INTO cart_sessions (id, "tenantId", "customerId", "expiresAt", "createdAt", "updatedAt")
		VALUES ($1,$2,$3,$4,$5,$6)`,
		c.ID, c.TenantID, c.CustomerID, c.ExpiresAt, c.CreatedAt, c.UpdatedAt)
	return err
}

func (d *DB) GetCart(ctx context.Context, tenantID, id uuid.UUID) (*CartRow, error) {
	var c CartRow
	err := d.db.GetContext(ctx, &c, `SELECT id, "tenantId", "customerId", "expiresAt", "createdAt", "updatedAt" FROM cart_sessions WHERE "tenantId"=$1 AND id=$2`, tenantID, id)
	return &c, err
}

func (d *DB) GetCartItems(ctx context.Context, cartSessionID uuid.UUID) ([]CartItemRow, error) {
	var rows []CartItemRow
	err := d.db.SelectContext(ctx, &rows, `SELECT id, "cartSessionId", "productId", "productName", quantity, "unitPrice", currency, "createdAt" FROM cart_items WHERE "cartSessionId"=$1`, cartSessionID)
	return rows, err
}

func (d *DB) AddCartItem(ctx context.Context, item CartItemRow) error {
	_, err := d.db.ExecContext(ctx, `
		INSERT INTO cart_items (id, "cartSessionId", "productId", "productName", quantity, "unitPrice", currency, "createdAt")
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
		item.ID, item.CartSessionID, item.ProductID, item.ProductName, item.Quantity, item.UnitPrice, item.Currency, item.CreatedAt)
	return err
}

func (d *DB) RemoveCartItem(ctx context.Context, cartSessionID, itemID uuid.UUID) error {
	_, err := d.db.ExecContext(ctx, `DELETE FROM cart_items WHERE "cartSessionId"=$1 AND id=$2`, cartSessionID, itemID)
	return err
}

func (d *DB) CreateOrder(ctx context.Context, o OrderRow) error {
	_, err := d.db.ExecContext(ctx, `
		INSERT INTO orders (id, "tenantId", "customerId", "orderNumber", status, "totalAmount", currency, "paymentStatus", items, notes, "createdAt", "updatedAt")
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
		o.ID, o.TenantID, o.CustomerID, o.OrderNumber, o.Status, o.TotalAmount, o.Currency, o.PaymentStatus, o.Items, o.Notes, o.CreatedAt, o.UpdatedAt)
	return err
}

func (d *DB) GetOrder(ctx context.Context, tenantID, id uuid.UUID) (*OrderRow, error) {
	var o OrderRow
	err := d.db.GetContext(ctx, &o, `SELECT id, "tenantId", "customerId", "orderNumber", status, "totalAmount", currency, "paymentStatus", items, notes, "erpOrderId", "createdAt", "updatedAt" FROM orders WHERE "tenantId"=$1 AND id=$2`, tenantID, id)
	return &o, err
}

func (d *DB) ListOrders(ctx context.Context, tenantID uuid.UUID, limit, offset int) ([]OrderRow, error) {
	var rows []OrderRow
	err := d.db.SelectContext(ctx, &rows, `SELECT id, "tenantId", "customerId", "orderNumber", status, "totalAmount", currency, "paymentStatus", items, notes, "erpOrderId", "createdAt", "updatedAt" FROM orders WHERE "tenantId"=$1 ORDER BY "createdAt" DESC LIMIT $2 OFFSET $3`, tenantID, limit, offset)
	return rows, err
}

func (d *DB) UpdateOrderStatus(ctx context.Context, id uuid.UUID, status string) error {
	_, err := d.db.ExecContext(ctx, `UPDATE orders SET status=$1, "updatedAt"=NOW() WHERE id=$2`, status, id)
	return err
}
