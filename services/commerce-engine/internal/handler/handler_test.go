package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/whatsapp-commerce/commerce-engine/internal/config"
	"github.com/whatsapp-commerce/commerce-engine/internal/store"
	"go.uber.org/zap"
)

var errNotFound = errors.New("not found")

// fakeStore is an in-memory Store for handler tests — no Postgres required.
type fakeStore struct {
	carts     map[uuid.UUID]store.CartRow
	cartItems map[uuid.UUID][]store.CartItemRow
	products  map[uuid.UUID]store.ProductRow
	orders    map[uuid.UUID]store.OrderRow
	createErr error
}

func newFakeStore() *fakeStore {
	return &fakeStore{
		carts:     map[uuid.UUID]store.CartRow{},
		cartItems: map[uuid.UUID][]store.CartItemRow{},
		products:  map[uuid.UUID]store.ProductRow{},
		orders:    map[uuid.UUID]store.OrderRow{},
	}
}

func (f *fakeStore) ListProducts(_ context.Context, _ uuid.UUID, _ string, _, _ int) ([]store.ProductRow, error) {
	return nil, nil
}
func (f *fakeStore) GetProduct(_ context.Context, tenantID, id uuid.UUID) (*store.ProductRow, error) {
	p, ok := f.products[id]
	if !ok || p.TenantID != tenantID {
		return nil, errNotFound
	}
	return &p, nil
}
func (f *fakeStore) SearchProducts(_ context.Context, _ uuid.UUID, _ string, _ int) ([]store.ProductRow, error) {
	return nil, nil
}
func (f *fakeStore) GetStockLevel(_ context.Context, _ uuid.UUID, _ string) (*store.ProductRow, error) {
	return nil, errNotFound
}
func (f *fakeStore) UpsertProduct(_ context.Context, p store.ProductRow) error {
	f.products[p.ID] = p
	return nil
}
func (f *fakeStore) UpsertStockLevel(_ context.Context, _ uuid.UUID, _ string, _ int) error {
	return nil
}
func (f *fakeStore) CreateCart(_ context.Context, c store.CartRow) error {
	f.carts[c.ID] = c
	return nil
}
func (f *fakeStore) GetCart(_ context.Context, tenantID, id uuid.UUID) (*store.CartRow, error) {
	c, ok := f.carts[id]
	if !ok || c.TenantID != tenantID {
		return nil, errNotFound
	}
	return &c, nil
}
func (f *fakeStore) GetCartItems(_ context.Context, cartID uuid.UUID) ([]store.CartItemRow, error) {
	return f.cartItems[cartID], nil
}
func (f *fakeStore) AddCartItem(_ context.Context, item store.CartItemRow) error {
	f.cartItems[item.CartSessionID] = append(f.cartItems[item.CartSessionID], item)
	return nil
}
func (f *fakeStore) RemoveCartItem(_ context.Context, cartID, itemID uuid.UUID) error {
	items := f.cartItems[cartID]
	for i, it := range items {
		if it.ID == itemID {
			f.cartItems[cartID] = append(items[:i], items[i+1:]...)
			return nil
		}
	}
	return nil
}
func (f *fakeStore) CreateOrder(_ context.Context, o store.OrderRow) error {
	if f.createErr != nil {
		return f.createErr
	}
	f.orders[o.ID] = o
	return nil
}
func (f *fakeStore) GetOrder(_ context.Context, tenantID, id uuid.UUID) (*store.OrderRow, error) {
	o, ok := f.orders[id]
	if !ok || o.TenantID != tenantID {
		return nil, errNotFound
	}
	return &o, nil
}
func (f *fakeStore) ListOrders(_ context.Context, _ uuid.UUID, _, _ int) ([]store.OrderRow, error) {
	return nil, nil
}
func (f *fakeStore) UpdateOrderStatus(_ context.Context, id uuid.UUID, status string) error {
	o := f.orders[id]
	o.Status = status
	f.orders[id] = o
	return nil
}

func newTestHandler(s Store) *Handler {
	return &Handler{cfg: &config.Config{}, db: s, logger: zap.NewNop()}
}

func newTestCtx(method, target string, body []byte) (*gin.Context, *httptest.ResponseRecorder) {
	gin.SetMode(gin.TestMode)
	rec := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(rec)
	if body != nil {
		c.Request = httptest.NewRequest(method, target, bytes.NewReader(body))
		c.Request.Header.Set("Content-Type", "application/json")
	} else {
		c.Request = httptest.NewRequest(method, target, nil)
	}
	return c, rec
}

// ─── (a) InitiateCheckout: order total is the SUM of cart item totals ───────

func TestInitiateCheckout_TotalIsSumOfItemTotals(t *testing.T) {
	s := newFakeStore()
	tenantID := uuid.New()
	cartID := uuid.New()
	custID := uuid.New()
	s.carts[cartID] = store.CartRow{ID: cartID, TenantID: tenantID, CustomerID: custID}
	s.cartItems[cartID] = []store.CartItemRow{
		{ID: uuid.New(), CartSessionID: cartID, Quantity: 2, UnitPrice: 1500.50, Currency: "NGN"},
		{ID: uuid.New(), CartSessionID: cartID, Quantity: 1, UnitPrice: 999.99, Currency: "NGN"},
	}
	h := newTestHandler(s)

	c, rec := newTestCtx(http.MethodPost, "/carts/"+cartID.String()+"/checkout", nil)
	c.Request.Header.Set("X-Tenant-ID", tenantID.String())
	c.Params = gin.Params{{Key: "id", Value: cartID.String()}}

	h.InitiateCheckout(c)

	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", rec.Code, rec.Body.String())
	}
	// store.OrderRow now carries real `json:` tags (snake_case) matching the
	// actual wire format.
	var resp struct {
		Order struct {
			TotalAmount float64 `json:"total_amount"`
			Status      string  `json:"status"`
		} `json:"order"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}
	const want = 3001.00 + 999.99
	if diff := resp.Order.TotalAmount - want; diff > 0.001 || diff < -0.001 {
		t.Fatalf("order total = %v, want %v (sum of item totals)", resp.Order.TotalAmount, want)
	}
	if resp.Order.Status != "pending" {
		t.Fatalf("new order status = %q, want %q", resp.Order.Status, "pending")
	}
}

func TestInitiateCheckout_EmptyCartRejected(t *testing.T) {
	s := newFakeStore()
	tenantID := uuid.New()
	cartID := uuid.New()
	s.carts[cartID] = store.CartRow{ID: cartID, TenantID: tenantID}
	// No items seeded — cart is empty.
	h := newTestHandler(s)

	c, rec := newTestCtx(http.MethodPost, "/carts/"+cartID.String()+"/checkout", nil)
	c.Request.Header.Set("X-Tenant-ID", tenantID.String())
	c.Params = gin.Params{{Key: "id", Value: cartID.String()}}

	h.InitiateCheckout(c)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for empty cart, got %d: %s", rec.Code, rec.Body.String())
	}
	if len(s.orders) != 0 {
		t.Fatal("an order was created from an empty cart")
	}
}

func TestInitiateCheckout_CrossTenantCartNotFound(t *testing.T) {
	s := newFakeStore()
	ownerTenant := uuid.New()
	attackerTenant := uuid.New()
	cartID := uuid.New()
	s.carts[cartID] = store.CartRow{ID: cartID, TenantID: ownerTenant}
	s.cartItems[cartID] = []store.CartItemRow{{ID: uuid.New(), CartSessionID: cartID, Quantity: 1, UnitPrice: 100}}
	h := newTestHandler(s)

	c, rec := newTestCtx(http.MethodPost, "/carts/"+cartID.String()+"/checkout", nil)
	c.Request.Header.Set("X-Tenant-ID", attackerTenant.String())
	c.Params = gin.Params{{Key: "id", Value: cartID.String()}}

	h.InitiateCheckout(c)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 (not found, tenant mismatch), got %d: %s", rec.Code, rec.Body.String())
	}
	if len(s.orders) != 0 {
		t.Fatal("an order was created for another tenant's cart")
	}
}

// ─── (b) CancelOrder: a paid/shipped/delivered order can never be cancelled ─

func TestCancelOrder_AllowsPending(t *testing.T) {
	s := newFakeStore()
	tenantID := uuid.New()
	orderID := uuid.New()
	s.orders[orderID] = store.OrderRow{ID: orderID, TenantID: tenantID, Status: "pending"}
	h := newTestHandler(s)

	c, rec := newTestCtx(http.MethodPost, "/orders/"+orderID.String()+"/cancel", nil)
	c.Request.Header.Set("X-Tenant-ID", tenantID.String())
	c.Params = gin.Params{{Key: "id", Value: orderID.String()}}

	h.CancelOrder(c)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 cancelling a pending order, got %d: %s", rec.Code, rec.Body.String())
	}
	if s.orders[orderID].Status != "cancelled" {
		t.Fatalf("order status = %q, want cancelled", s.orders[orderID].Status)
	}
}

func TestCancelOrder_RejectsPaidShippedDelivered(t *testing.T) {
	// "paid" was never a valid order status — payment is tracked separately
	// via PaymentStatus. The real guard (handler.go CancelOrder) checks
	// PaymentStatus == "completed" for the payment case, and Status for the
	// fulfillment cases.
	cases := []struct {
		name  string
		order store.OrderRow
	}{
		{"payment_completed", store.OrderRow{PaymentStatus: "completed"}},
		{"shipped", store.OrderRow{Status: "shipped"}},
		{"delivered", store.OrderRow{Status: "delivered"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s := newFakeStore()
			tenantID := uuid.New()
			orderID := uuid.New()
			order := tc.order
			order.ID = orderID
			order.TenantID = tenantID
			s.orders[orderID] = order
			h := newTestHandler(s)

			c, rec := newTestCtx(http.MethodPost, "/orders/"+orderID.String()+"/cancel", nil)
			c.Request.Header.Set("X-Tenant-ID", tenantID.String())
			c.Params = gin.Params{{Key: "id", Value: orderID.String()}}

			h.CancelOrder(c)

			if rec.Code != http.StatusBadRequest {
				t.Fatalf("expected 400 cancelling a %s order, got %d: %s", tc.name, rec.Code, rec.Body.String())
			}
			if s.orders[orderID].Status == "cancelled" {
				t.Fatalf("order was cancelled despite %s — must never be cancellable", tc.name)
			}
		})
	}
}

// ─── (c) AddCartItem: item total is unit price × quantity, unknown cart rejected ───

func TestAddCartItem_ComputesTotalPrice(t *testing.T) {
	s := newFakeStore()
	tenantID := uuid.New()
	cartID := uuid.New()
	productID := uuid.New()
	s.carts[cartID] = store.CartRow{ID: cartID, TenantID: tenantID}
	s.products[productID] = store.ProductRow{ID: productID, TenantID: tenantID, SKU: "SKU-1", Price: 250.75, Currency: "NGN"}
	h := newTestHandler(s)

	body, _ := json.Marshal(map[string]interface{}{"product_id": productID.String(), "quantity": 3})
	c, rec := newTestCtx(http.MethodPost, "/carts/"+cartID.String()+"/items", body)
	c.Request.Header.Set("X-Tenant-ID", tenantID.String())
	c.Params = gin.Params{{Key: "id", Value: cartID.String()}}

	h.AddCartItem(c)

	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", rec.Code, rec.Body.String())
	}
	items := s.cartItems[cartID]
	if len(items) != 1 {
		t.Fatalf("expected 1 cart item, got %d", len(items))
	}
	const want = 250.75 * 3
	if diff := items[0].TotalPrice() - want; diff > 0.001 || diff < -0.001 {
		t.Fatalf("item total = %v, want %v (unit price × quantity)", items[0].TotalPrice(), want)
	}
}

// cart_sessions has no status column (it's a shared chat-wizard session
// object, not an exclusively commerce-engine-owned cart with an
// active/checkout state machine) — AddCartItem's only guard left is
// existence + tenant match, exercised here via an unseeded cart ID.
func TestAddCartItem_UnknownCartRejected(t *testing.T) {
	s := newFakeStore()
	tenantID := uuid.New()
	cartID := uuid.New() // never created
	productID := uuid.New()
	s.products[productID] = store.ProductRow{ID: productID, TenantID: tenantID, Price: 100}
	h := newTestHandler(s)

	body, _ := json.Marshal(map[string]interface{}{"product_id": productID.String(), "quantity": 1})
	c, rec := newTestCtx(http.MethodPost, "/carts/"+cartID.String()+"/items", body)
	c.Request.Header.Set("X-Tenant-ID", tenantID.String())
	c.Params = gin.Params{{Key: "id", Value: cartID.String()}}

	h.AddCartItem(c)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404 adding an item to an unknown cart, got %d: %s", rec.Code, rec.Body.String())
	}
	if len(s.cartItems[cartID]) != 0 {
		t.Fatal("an item was added to an unknown cart")
	}
}
