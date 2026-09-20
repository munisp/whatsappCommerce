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
	"github.com/whatsapp-commerce/payment-orchestrator/internal/config"
	"github.com/whatsapp-commerce/payment-orchestrator/internal/store"
	"go.uber.org/zap"
)

var errNotFound = errors.New("not found")

// fakeStore is an in-memory Store for handler tests — no Postgres required.
type fakeStore struct {
	intents      map[uuid.UUID]store.PaymentIntentRow
	byIdempotent map[string]uuid.UUID // tenant|key -> intent id
}

func newFakeStore() *fakeStore {
	return &fakeStore{
		intents:      map[uuid.UUID]store.PaymentIntentRow{},
		byIdempotent: map[string]uuid.UUID{},
	}
}

func (f *fakeStore) CreatePaymentIntent(_ context.Context, p store.PaymentIntentRow) (bool, error) {
	key := p.TenantID.String() + "|" + p.IdempotencyKey
	if existing, ok := f.byIdempotent[key]; ok {
		_ = existing
		return false, nil
	}
	f.intents[p.ID] = p
	f.byIdempotent[key] = p.ID
	return true, nil
}
func (f *fakeStore) GetPaymentIntent(_ context.Context, tenantID, id uuid.UUID) (*store.PaymentIntentRow, error) {
	i, ok := f.intents[id]
	if !ok || i.TenantID != tenantID {
		return nil, errNotFound
	}
	return &i, nil
}
func (f *fakeStore) GetPaymentIntentByIdempotencyKey(_ context.Context, tenantID uuid.UUID, key string) (*store.PaymentIntentRow, error) {
	id, ok := f.byIdempotent[tenantID.String()+"|"+key]
	if !ok {
		return nil, errNotFound
	}
	i := f.intents[id]
	return &i, nil
}
func (f *fakeStore) GetPaymentIntentByMojaloop(_ context.Context, transferID string) (*store.PaymentIntentRow, error) {
	for _, i := range f.intents {
		if i.MojaloopTransferID == transferID {
			return &i, nil
		}
	}
	return nil, errNotFound
}
func (f *fakeStore) SetLedgerPendingID(_ context.Context, id uuid.UUID, pendingID string) error {
	i := f.intents[id]
	i.TigerBeetlePendingID = pendingID
	f.intents[id] = i
	return nil
}
func (f *fakeStore) SetProviderReference(_ context.Context, id uuid.UUID, ref string) error {
	i := f.intents[id]
	i.MojaloopTransferID = ref
	f.intents[id] = i
	return nil
}
func (f *fakeStore) UpdatePaymentStatus(_ context.Context, id uuid.UUID, status, reason string) error {
	i := f.intents[id]
	i.Status = status
	i.FailureReason = reason
	f.intents[id] = i
	return nil
}

func newTestHandler(s Store, cfg *config.Config) *Handler {
	if cfg == nil {
		cfg = &config.Config{}
	}
	return &Handler{cfg: cfg, db: s, logger: zap.NewNop(), client: &http.Client{}}
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

// ─── AuthMiddleware: fail-closed security boundary on every route but /health ───

func runAuth(cfg *config.Config, path, presentedToken string) *httptest.ResponseRecorder {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(AuthMiddleware(cfg, zap.NewNop()))
	r.GET(path, func(c *gin.Context) { c.JSON(http.StatusOK, gin.H{"ok": true}) })
	req := httptest.NewRequest(http.MethodGet, path, nil)
	if presentedToken != "" {
		req.Header.Set("X-Internal-Token", presentedToken)
	}
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	return rec
}

func TestAuthMiddleware_ProductionNoTokenConfigured_FailsClosed(t *testing.T) {
	cfg := &config.Config{Environment: "production", InternalToken: ""}
	rec := runAuth(cfg, "/payments", "")
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("prod + unconfigured token: expected 503 (fail closed), got %d", rec.Code)
	}
}

func TestAuthMiddleware_ProductionWrongToken_Rejected(t *testing.T) {
	cfg := &config.Config{Environment: "production", InternalToken: "correct-token"}
	rec := runAuth(cfg, "/payments", "wrong-token")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("wrong token: expected 401, got %d", rec.Code)
	}
}

func TestAuthMiddleware_ProductionCorrectToken_Allowed(t *testing.T) {
	cfg := &config.Config{Environment: "production", InternalToken: "correct-token"}
	rec := runAuth(cfg, "/payments", "correct-token")
	if rec.Code != http.StatusOK {
		t.Fatalf("correct token: expected 200, got %d", rec.Code)
	}
}

func TestAuthMiddleware_DevNoTokenConfigured_AllowedWithWarning(t *testing.T) {
	cfg := &config.Config{Environment: "development", InternalToken: ""}
	rec := runAuth(cfg, "/payments", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("dev + unconfigured token: expected 200 (dev convenience), got %d", rec.Code)
	}
}

func TestAuthMiddleware_HealthAlwaysAllowed(t *testing.T) {
	cfg := &config.Config{Environment: "production", InternalToken: "secret"}
	rec := runAuth(cfg, "/health", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("/health without a token: expected 200, got %d", rec.Code)
	}
}

// ─── Pure helpers ────────────────────────────────────────────────────────────

func TestMinorUnits_RoundHalfUp(t *testing.T) {
	cases := []struct {
		major float64
		want  int64
	}{
		{1000.00, 100000},
		{19.99, 1999},
		{0.005, 1}, // round-half-up, not banker's rounding
		{0, 0},
		{1500.505, 150051}, // 150050.5 rounds up
	}
	for _, tc := range cases {
		if got := minorUnits(tc.major); got != tc.want {
			t.Errorf("minorUnits(%v) = %d, want %d", tc.major, got, tc.want)
		}
	}
}

func TestParseUUID_InvalidReturns400(t *testing.T) {
	c, rec := newTestCtx(http.MethodGet, "/x", nil)
	_, ok := parseUUID(c, "not-a-uuid", "order_id")
	if ok {
		t.Fatal("parseUUID accepted a non-UUID string")
	}
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for invalid UUID, got %d", rec.Code)
	}
}

func TestParseUUID_ValidPasses(t *testing.T) {
	c, _ := newTestCtx(http.MethodGet, "/x", nil)
	id := uuid.New()
	got, ok := parseUUID(c, id.String(), "order_id")
	if !ok || got != id {
		t.Fatalf("parseUUID(%s) = (%v, %v), want (%v, true)", id, got, ok, id)
	}
}

// ─── InitiatePayment: idempotency replay must NEVER re-initiate a charge ────

func TestInitiatePayment_IdempotentReplay_NoSecondCharge(t *testing.T) {
	s := newFakeStore()
	tenantID := uuid.New()
	key := "same-key"
	// Pre-seed as if a first call already created this intent.
	existingID := uuid.New()
	s.intents[existingID] = store.PaymentIntentRow{
		ID: existingID, TenantID: tenantID, Status: "initiated", Provider: "mojaloop",
		WorkflowID: "wf-1", IdempotencyKey: key,
	}
	s.byIdempotent[tenantID.String()+"|"+key] = existingID

	h := newTestHandler(s, &config.Config{}) // LedgerBridgeURL unset — reserve step skipped either way
	body, _ := json.Marshal(map[string]interface{}{
		"order_id": uuid.New().String(), "customer_id": uuid.New().String(),
		"amount": 500, "currency": "NGN", "provider": "mojaloop",
	})
	c, rec := newTestCtx(http.MethodPost, "/payments", body)
	c.Request.Header.Set("X-Tenant-ID", tenantID.String())
	c.Request.Header.Set("X-Idempotency-Key", key)

	h.InitiatePayment(c)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 on idempotent replay, got %d: %s", rec.Code, rec.Body.String())
	}
	var resp struct {
		PaymentIntentID  string `json:"payment_intent_id"`
		IdempotentReplay bool   `json:"idempotent_replay"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if !resp.IdempotentReplay {
		t.Fatal("response did not flag idempotent_replay")
	}
	if resp.PaymentIntentID != existingID.String() {
		t.Fatalf("replay returned a different intent id: got %s, want %s", resp.PaymentIntentID, existingID)
	}
	// Exactly one intent must exist — no second row created for the replay.
	if len(s.intents) != 1 {
		t.Fatalf("expected exactly 1 intent after replay, got %d", len(s.intents))
	}
}

// ─── InitiatePayment: unsupported provider is rejected, never silently charged ───

func TestInitiatePayment_UnsupportedProvider_Rejected(t *testing.T) {
	s := newFakeStore()
	tenantID := uuid.New()
	h := newTestHandler(s, &config.Config{}) // no LedgerBridgeURL — reserve phase skipped
	body, _ := json.Marshal(map[string]interface{}{
		"order_id": uuid.New().String(), "customer_id": uuid.New().String(),
		"amount": 500, "currency": "NGN", "provider": "dogecoin",
	})
	c, rec := newTestCtx(http.MethodPost, "/payments", body)
	c.Request.Header.Set("X-Tenant-ID", tenantID.String())

	h.InitiatePayment(c)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for unsupported provider, got %d: %s", rec.Code, rec.Body.String())
	}
	// The intent must land in a terminal "failed" state — never stuck pending.
	found := false
	for _, i := range s.intents {
		if i.Status == "failed" {
			found = true
		}
	}
	if !found {
		t.Fatal("intent was not marked failed for an unsupported provider")
	}
}

// ─── InitiatePayment: reserve succeeds, provider fails → the reservation is
// voided (2-phase commit safety net) instead of leaving funds locked ────────

func TestInitiatePayment_ProviderFailsAfterReserve_VoidsLedgerAndMarksFailed(t *testing.T) {
	var reserved, voided bool
	var voidedPendingID string
	ledger := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/ledger/reserve":
			reserved = true
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]string{"pending_id": "pending-123"})
		case "/ledger/void":
			var body map[string]string
			json.NewDecoder(r.Body).Decode(&body)
			voided = true
			voidedPendingID = body["pending_id"]
			w.WriteHeader(http.StatusOK)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer ledger.Close()

	s := newFakeStore()
	tenantID := uuid.New()
	cfg := &config.Config{LedgerBridgeURL: ledger.URL, StripeSecretKey: ""} // Stripe deliberately unconfigured
	h := newTestHandler(s, cfg)

	body, _ := json.Marshal(map[string]interface{}{
		"order_id": uuid.New().String(), "customer_id": uuid.New().String(),
		"amount": 750, "currency": "NGN", "provider": "stripe",
	})
	c, rec := newTestCtx(http.MethodPost, "/payments", body)
	c.Request.Header.Set("X-Tenant-ID", tenantID.String())

	h.InitiatePayment(c)

	if !reserved {
		t.Fatal("ledger reserve was never called")
	}
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("expected 502 when the provider fails post-reserve, got %d: %s", rec.Code, rec.Body.String())
	}
	if !voided {
		t.Fatal("the ledger reservation was never voided after the provider failed — funds would stay locked")
	}
	if voidedPendingID != "pending-123" {
		t.Fatalf("voided the wrong pending id: got %q, want %q", voidedPendingID, "pending-123")
	}
	found := false
	for _, i := range s.intents {
		if i.Status == "failed" {
			found = true
		}
	}
	if !found {
		t.Fatal("intent was not marked failed after the reserve was voided")
	}
}

// ─── RefundPayment: only a completed payment can ever be refunded ──────────

func TestRefundPayment_RejectsNonCompletedStatus(t *testing.T) {
	for _, status := range []string{"pending", "initiated", "failed", "voided"} {
		t.Run(status, func(t *testing.T) {
			s := newFakeStore()
			tenantID := uuid.New()
			id := uuid.New()
			s.intents[id] = store.PaymentIntentRow{ID: id, TenantID: tenantID, Status: status, Provider: "paystack"}
			h := newTestHandler(s, &config.Config{})

			c, rec := newTestCtx(http.MethodPost, "/payments/"+id.String()+"/refund", nil)
			c.Request.Header.Set("X-Tenant-ID", tenantID.String())
			c.Params = gin.Params{{Key: "id", Value: id.String()}}

			h.RefundPayment(c)

			if rec.Code != http.StatusBadRequest {
				t.Fatalf("refunding a %s payment: expected 400, got %d: %s", status, rec.Code, rec.Body.String())
			}
			if s.intents[id].Status != status {
				t.Fatalf("status changed to %q refunding a %s payment — must be untouched", s.intents[id].Status, status)
			}
		})
	}
}

// ─── VoidPayment: only pending/initiated payments can be voided ────────────

func TestVoidPayment_RejectsCompletedStatus(t *testing.T) {
	s := newFakeStore()
	tenantID := uuid.New()
	id := uuid.New()
	s.intents[id] = store.PaymentIntentRow{ID: id, TenantID: tenantID, Status: "completed"}
	h := newTestHandler(s, &config.Config{})

	c, rec := newTestCtx(http.MethodPost, "/payments/"+id.String()+"/void", nil)
	c.Request.Header.Set("X-Tenant-ID", tenantID.String())
	c.Params = gin.Params{{Key: "id", Value: id.String()}}

	h.VoidPayment(c)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("voiding a completed payment: expected 400, got %d: %s", rec.Code, rec.Body.String())
	}
	if s.intents[id].Status != "completed" {
		t.Fatalf("a completed payment's status changed to %q via void", s.intents[id].Status)
	}
}
