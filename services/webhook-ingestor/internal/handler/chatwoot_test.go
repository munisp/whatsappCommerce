package handler

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/whatsapp-commerce/webhook-ingestor/internal/config"
	"go.uber.org/zap"
)

// stubPublisher implements Publisher for tests (W42 PLT-6).
type stubPublisher struct{ err error }

func (s stubPublisher) Publish(_ context.Context, _, _ string, _ interface{}) error {
	return s.err
}

func newTestHandler(p Publisher) *Handler {
	return &Handler{
		cfg:      &config.Config{},
		producer: p,
		logger:   zap.NewNop(),
	}
}

func newTestContext() (*gin.Context, *httptest.ResponseRecorder) {
	gin.SetMode(gin.TestMode)
	rec := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(rec)
	c.Request = httptest.NewRequest(http.MethodPost, "/webhooks/test", nil)
	return c, rec
}

// PLT-6: a failed broker publish must NEVER be 200-acked — the sender needs a
// retryable 5xx so the event is not permanently lost.
func TestPublishOrFail_Returns503OnBrokerError(t *testing.T) {
	h := newTestHandler(stubPublisher{err: errors.New("broker unreachable")})
	c, rec := newTestContext()

	ok := h.publishOrFail(c, "payment.mojaloop.callback.received.v1", "key", map[string]interface{}{"id": "1"})
	if ok {
		t.Fatal("publishOrFail reported success despite broker error")
	}
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503 (retryable), got %d", rec.Code)
	}
}

func TestPublishOrFail_SuccessDoesNotWriteError(t *testing.T) {
	h := newTestHandler(stubPublisher{err: nil})
	c, rec := newTestContext()

	ok := h.publishOrFail(c, "chat.message.received.v1", "key", map[string]interface{}{"id": "1"})
	if !ok {
		t.Fatal("publishOrFail reported failure despite successful publish")
	}
	if rec.Code == http.StatusServiceUnavailable {
		t.Fatal("503 written on successful publish")
	}
}
