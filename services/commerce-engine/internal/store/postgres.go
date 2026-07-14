package store

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/jmoiron/sqlx"
	_ "github.com/lib/pq"
)

type ProductRow struct {
	ID          uuid.UUID `db:"id"`
	TenantID    uuid.UUID `db:"tenant_id"`
	SKU         string    `db:"sku"`
	Name        string    `db:"name"`
	Description string    `db:"description"`
	Category    string    `db:"category"`
	Price       float64   `db:"price"`
	Currency    string    `db:"currency"`
	ImageURL    string    `db:"image_url"`
	IsActive    bool      `db:"is_active"`
	ExternalID  string    `db:"external_id"`
	CreatedAt   time.Time `db:"created_at"`
	UpdatedAt   time.Time `db:"updated_at"`
}

type StockRow struct {
	ProductID   uuid.UUID `db:"product_id"`
	TenantID    uuid.UUID `db:"tenant_id"`
	SKU         string    `db:"sku"`
	Available   int       `db:"available"`
	Reserved    int       `db:"reserved"`
	OnHand      int       `db:"on_hand"`
	WarehouseID string    `db:"warehouse_id"`
	UpdatedAt   time.Time `db:"updated_at"`
}

type CartRow struct {
	ID          uuid.UUID `db:"id"`
	TenantID    uuid.UUID `db:"tenant_id"`
	CustomerID  uuid.UUID `db:"customer_id"`
	Status      string    `db:"status"`
	Currency    string    `db:"currency"`
	TotalAmount float64   `db:"total_amount"`
	ExpiresAt   time.Time `db:"expires_at"`
	CreatedAt   time.Time `db:"created_at"`
	UpdatedAt   time.Time `db:"updated_at"`
}

type CartItemRow struct {
	ID          uuid.UUID `db:"id"`
	CartID      uuid.UUID `db:"cart_id"`
	ProductID   uuid.UUID `db:"product_id"`
	SKU         string    `db:"sku"`
	ProductName string    `db:"product_name"`
	Quantity    int       `db:"quantity"`
	UnitPrice   float64   `db:"unit_price"`
	TotalPrice  float64   `db:"total_price"`
}

type OrderRow struct {
	ID              uuid.UUID `db:"id"`
	TenantID        uuid.UUID `db:"tenant_id"`
	CustomerID      uuid.UUID `db:"customer_id"`
	CartID          uuid.UUID `db:"cart_id"`
	Status          string    `db:"status"`
	Currency        string    `db:"currency"`
	TotalAmount     float64   `db:"total_amount"`
	WorkflowID      string    `db:"workflow_id"`
	ExternalOrderID string    `db:"external_order_id"`
	PaymentIntentID *uuid.UUID `db:"payment_intent_id"`
	Notes           string    `db:"notes"`
	CreatedAt       time.Time `db:"created_at"`
	UpdatedAt       time.Time `db:"updated_at"`
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
	query := `SELECT id, tenant_id, sku, name, description, category, price, currency, image_url, is_active, external_id, created_at, updated_at
		FROM products WHERE tenant_id=$1 AND is_active=true`
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
	err := d.db.GetContext(ctx, &p, `SELECT id, tenant_id, sku, name, description, category, price, currency, image_url, is_active, external_id, created_at, updated_at FROM products WHERE tenant_id=$1 AND id=$2`, tenantID, id)
	return &p, err
}

func (d *DB) SearchProducts(ctx context.Context, tenantID uuid.UUID, q string, limit int) ([]ProductRow, error) {
	var rows []ProductRow
	err := d.db.SelectContext(ctx, &rows, `
		SELECT id, tenant_id, sku, name, description, category, price, currency, image_url, is_active, external_id, created_at, updated_at
		FROM products WHERE tenant_id=$1 AND is_active=true
		AND (name ILIKE $2 OR description ILIKE $2 OR sku ILIKE $2)
		ORDER BY name LIMIT $3`, tenantID, "%"+q+"%", limit)
	return rows, err
}

func (d *DB) GetStockLevel(ctx context.Context, tenantID uuid.UUID, sku string) (*StockRow, error) {
	var s StockRow
	err := d.db.GetContext(ctx, &s, `SELECT product_id, tenant_id, sku, available, reserved, on_hand, warehouse_id, updated_at FROM stock_levels WHERE tenant_id=$1 AND sku=$2`, tenantID, sku)
	return &s, err
}

func (d *DB) UpsertProduct(ctx context.Context, p ProductRow) error {
	_, err := d.db.ExecContext(ctx, `
		INSERT INTO products (id, tenant_id, sku, name, description, category, price, currency, image_url, is_active, external_id, created_at, updated_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
		ON CONFLICT (tenant_id, sku) DO UPDATE SET name=EXCLUDED.name, description=EXCLUDED.description, price=EXCLUDED.price, updated_at=NOW()`,
		p.ID, p.TenantID, p.SKU, p.Name, p.Description, p.Category, p.Price, p.Currency, p.ImageURL, p.IsActive, p.ExternalID, p.CreatedAt, p.UpdatedAt)
	return err
}

func (d *DB) UpsertStockLevel(ctx context.Context, s StockRow) error {
	_, err := d.db.ExecContext(ctx, `
		INSERT INTO stock_levels (product_id, tenant_id, sku, available, reserved, on_hand, warehouse_id, updated_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
		ON CONFLICT (tenant_id, sku) DO UPDATE SET available=EXCLUDED.available, reserved=EXCLUDED.reserved, on_hand=EXCLUDED.on_hand, updated_at=NOW()`,
		s.ProductID, s.TenantID, s.SKU, s.Available, s.Reserved, s.OnHand, s.WarehouseID, s.UpdatedAt)
	return err
}

func (d *DB) CreateCart(ctx context.Context, c CartRow) error {
	_, err := d.db.ExecContext(ctx, `
		INSERT INTO carts (id, tenant_id, customer_id, status, currency, total_amount, expires_at, created_at, updated_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
		c.ID, c.TenantID, c.CustomerID, c.Status, c.Currency, c.TotalAmount, c.ExpiresAt, c.CreatedAt, c.UpdatedAt)
	return err
}

func (d *DB) GetCart(ctx context.Context, tenantID, id uuid.UUID) (*CartRow, error) {
	var c CartRow
	err := d.db.GetContext(ctx, &c, `SELECT id, tenant_id, customer_id, status, currency, total_amount, expires_at, created_at, updated_at FROM carts WHERE tenant_id=$1 AND id=$2`, tenantID, id)
	return &c, err
}

func (d *DB) GetCartItems(ctx context.Context, cartID uuid.UUID) ([]CartItemRow, error) {
	var rows []CartItemRow
	err := d.db.SelectContext(ctx, &rows, `SELECT id, cart_id, product_id, sku, product_name, quantity, unit_price, total_price FROM cart_items WHERE cart_id=$1`, cartID)
	return rows, err
}

func (d *DB) AddCartItem(ctx context.Context, item CartItemRow) error {
	_, err := d.db.ExecContext(ctx, `
		INSERT INTO cart_items (id, cart_id, product_id, sku, product_name, quantity, unit_price, total_price)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
		ON CONFLICT (cart_id, sku) DO UPDATE SET quantity=cart_items.quantity+EXCLUDED.quantity, total_price=(cart_items.quantity+EXCLUDED.quantity)*EXCLUDED.unit_price`,
		item.ID, item.CartID, item.ProductID, item.SKU, item.ProductName, item.Quantity, item.UnitPrice, item.TotalPrice)
	return err
}

func (d *DB) RemoveCartItem(ctx context.Context, cartID, itemID uuid.UUID) error {
	_, err := d.db.ExecContext(ctx, `DELETE FROM cart_items WHERE cart_id=$1 AND id=$2`, cartID, itemID)
	return err
}

func (d *DB) UpdateCartStatus(ctx context.Context, id uuid.UUID, status string) error {
	_, err := d.db.ExecContext(ctx, `UPDATE carts SET status=$1, updated_at=NOW() WHERE id=$2`, status, id)
	return err
}

func (d *DB) CreateOrder(ctx context.Context, o OrderRow) error {
	_, err := d.db.ExecContext(ctx, `
		INSERT INTO orders (id, tenant_id, customer_id, cart_id, status, currency, total_amount, workflow_id, external_order_id, notes, created_at, updated_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
		o.ID, o.TenantID, o.CustomerID, o.CartID, o.Status, o.Currency, o.TotalAmount, o.WorkflowID, o.ExternalOrderID, o.Notes, o.CreatedAt, o.UpdatedAt)
	return err
}

func (d *DB) GetOrder(ctx context.Context, tenantID, id uuid.UUID) (*OrderRow, error) {
	var o OrderRow
	err := d.db.GetContext(ctx, &o, `SELECT id, tenant_id, customer_id, cart_id, status, currency, total_amount, workflow_id, external_order_id, payment_intent_id, notes, created_at, updated_at FROM orders WHERE tenant_id=$1 AND id=$2`, tenantID, id)
	return &o, err
}

func (d *DB) ListOrders(ctx context.Context, tenantID uuid.UUID, limit, offset int) ([]OrderRow, error) {
	var rows []OrderRow
	err := d.db.SelectContext(ctx, &rows, `SELECT id, tenant_id, customer_id, cart_id, status, currency, total_amount, workflow_id, external_order_id, payment_intent_id, notes, created_at, updated_at FROM orders WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`, tenantID, limit, offset)
	return rows, err
}

func (d *DB) UpdateOrderStatus(ctx context.Context, id uuid.UUID, status string) error {
	_, err := d.db.ExecContext(ctx, `UPDATE orders SET status=$1, updated_at=NOW() WHERE id=$2`, status, id)
	return err
}

