package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/whatsapp-commerce/commerce-engine/internal/config"
	"github.com/whatsapp-commerce/commerce-engine/internal/handler"
	"github.com/whatsapp-commerce/commerce-engine/internal/store"
	"go.uber.org/zap"
)

// QA-038: every route except /health now requires X-Internal-Api-Key once INTERNAL_API_KEY is configured —
// before this, commerce-engine trusted an X-Tenant-ID header with no authentication of its own, so anyone
// who could reach the pod could act as any tenant.
//
// These tests exercise newRouter() itself, the function main() actually calls, not a hand-duplicated test
// router — a route mistakenly left out of the protected group is something these can catch (see
// rust/ledger-bridge and rust/recon-worker, where a duplicated test router hid exactly that mistake).

// errStore never succeeds — every handler call returns a real error (a clean 500 via the handler's own
// error path), never a panic, so a test that gets PAST the middleware fails predictably rather than
// relying on gin.Recovery() to catch a nil-pointer dereference.
type errStore struct{}

var errNotImplemented = errors.New("not implemented (test double)")

func (errStore) ListProducts(context.Context, uuid.UUID, string, int, int) ([]store.ProductRow, error) {
	return nil, errNotImplemented
}
func (errStore) GetProduct(context.Context, uuid.UUID, uuid.UUID) (*store.ProductRow, error) {
	return nil, errNotImplemented
}
func (errStore) SearchProducts(context.Context, uuid.UUID, string, int) ([]store.ProductRow, error) {
	return nil, errNotImplemented
}
func (errStore) GetStockLevel(context.Context, uuid.UUID, string) (*store.StockRow, error) {
	return nil, errNotImplemented
}
func (errStore) UpsertProduct(context.Context, store.ProductRow) error  { return errNotImplemented }
func (errStore) UpsertStockLevel(context.Context, store.StockRow) error { return errNotImplemented }
func (errStore) CreateCart(context.Context, store.CartRow) error        { return errNotImplemented }
func (errStore) GetCart(context.Context, uuid.UUID, uuid.UUID) (*store.CartRow, error) {
	return nil, errNotImplemented
}
func (errStore) GetCartItems(context.Context, uuid.UUID) ([]store.CartItemRow, error) {
	return nil, errNotImplemented
}
func (errStore) AddCartItem(context.Context, store.CartItemRow) error { return errNotImplemented }
func (errStore) RemoveCartItem(context.Context, uuid.UUID, uuid.UUID) error {
	return errNotImplemented
}
func (errStore) UpdateCartStatus(context.Context, uuid.UUID, string) error { return errNotImplemented }
func (errStore) CreateOrder(context.Context, store.OrderRow) error         { return errNotImplemented }
func (errStore) GetOrder(context.Context, uuid.UUID, uuid.UUID) (*store.OrderRow, error) {
	return nil, errNotImplemented
}
func (errStore) ListOrders(context.Context, uuid.UUID, int, int) ([]store.OrderRow, error) {
	return nil, errNotImplemented
}
func (errStore) UpdateOrderStatus(context.Context, uuid.UUID, string) error { return errNotImplemented }

func testRouter(t *testing.T, key string) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode) // quiet the per-route debug lines, same as handler_test.go
	cfg := &config.Config{Port: "8083", InternalAPIKey: key, Env: "test"}
	logger := zap.NewNop()
	h := handler.New(cfg, errStore{}, logger)
	return newRouter(cfg, h, logger)
}

func doReq(r *gin.Engine, method, path, key string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, nil)
	req.Header.Set("X-Tenant-ID", uuid.NewString())
	if key != "" {
		req.Header.Set("X-Internal-Api-Key", key)
	}
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	return rec
}

func TestWhenNoKeyConfiguredEveryRouteIsOpen(t *testing.T) {
	r := testRouter(t, "")
	rec := doReq(r, http.MethodGet, "/products", "")
	if rec.Code == http.StatusUnauthorized {
		t.Fatalf("expected the request to pass the auth gate (dev mode), got 401")
	}
}

func TestOnceConfiguredProtectedRoutesRefuseNoKey(t *testing.T) {
	r := testRouter(t, "s3cret")
	for _, tc := range []struct{ method, path string }{
		{http.MethodGet, "/products"},
		{http.MethodGet, "/products/" + uuid.NewString()},
		{http.MethodPost, "/carts"},
		{http.MethodPost, "/carts/" + uuid.NewString() + "/checkout"},
		{http.MethodGet, "/orders"},
		{http.MethodPost, "/orders/" + uuid.NewString() + "/confirm"},
		{http.MethodPost, "/internal/sync/product"},
	} {
		rec := doReq(r, tc.method, tc.path, "")
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("%s %s: expected 401 with no key, got %d", tc.method, tc.path, rec.Code)
		}
	}
}

func TestOnceConfiguredProtectedRoutesRefuseTheWrongKey(t *testing.T) {
	r := testRouter(t, "s3cret")
	rec := doReq(r, http.MethodGet, "/products", "wrong")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 with the wrong key, got %d", rec.Code)
	}
}

func TestOnceConfiguredProtectedRoutesAcceptTheRightKey(t *testing.T) {
	r := testRouter(t, "s3cret")
	rec := doReq(r, http.MethodGet, "/products", "s3cret")
	if rec.Code == http.StatusUnauthorized {
		t.Fatalf("expected the right key to pass the auth gate, got 401")
	}
}

func TestHealthNeverRequiresTheKey(t *testing.T) {
	r := testRouter(t, "s3cret")
	rec := doReq(r, http.MethodGet, "/health", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("expected /health to stay open for kubelet probes, got %d", rec.Code)
	}
}

func TestTheOtherTwoAcceptedHeaderNamesAlsoWork(t *testing.T) {
	r := testRouter(t, "s3cret")
	for _, header := range []string{"X-Internal-Token", "X-Api-Key"} {
		req := httptest.NewRequest(http.MethodGet, "/products", nil)
		req.Header.Set("X-Tenant-ID", uuid.NewString())
		req.Header.Set(header, "s3cret")
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		if rec.Code == http.StatusUnauthorized {
			t.Errorf("%s should have been accepted, got 401", header)
		}
	}
}

func TestA401FromTheGateIsJSONShapedLikeEveryOtherErrorHere(t *testing.T) {
	r := testRouter(t, "s3cret")
	rec := doReq(r, http.MethodGet, "/products", "")
	if got := rec.Body.String(); got != `{"error":"invalid_internal_api_key"}` {
		t.Fatalf("unexpected body: %s", got)
	}
}

// Mirrors gateway's InternalTokenAuth: in production an unset key must fail CLOSED (503), not silently
// leave every tenant-trusting route open because a Secret went missing. /health stays open for kubelet.
func TestInProductionAnUnsetKeyFailsClosed(t *testing.T) {
	gin.SetMode(gin.TestMode)
	cfg := &config.Config{Port: "8083", InternalAPIKey: "", Env: "production"}
	logger := zap.NewNop()
	r := newRouter(cfg, handler.New(cfg, errStore{}, logger), logger)

	if rec := doReq(r, http.MethodGet, "/products", ""); rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503 (fail closed) for a protected route, got %d", rec.Code)
	}
	if rec := doReq(r, http.MethodGet, "/health", ""); rec.Code != http.StatusOK {
		t.Fatalf("expected /health to stay open even when failing closed, got %d", rec.Code)
	}
}
