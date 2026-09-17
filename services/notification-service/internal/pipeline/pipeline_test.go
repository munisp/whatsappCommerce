// === W45 go-rust-services ===
package pipeline

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func testPipeline(notifyURL string, maxAttempts int) *Pipeline {
	return &Pipeline{
		cfg:    Config{NotifyURL: notifyURL, MaxAttempts: maxAttempts, IdempotencyTTL: time.Hour},
		http:   &http.Client{Timeout: 2 * time.Second},
		logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
}

// MSG-19: dispatch must actually POST the notification payload to the
// platform notify endpoint.
func TestDispatchPostsPayload(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		if r.Header.Get("Content-Type") != "application/json" {
			t.Error("missing content-type")
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	p := testPipeline(srv.URL, 3)
	err := p.dispatchWithRetry(context.Background(), Notification{ID: "n1", Channel: "whatsapp", To: "2348001234567", Body: "hi"})
	if err != nil {
		t.Fatal(err)
	}
	if hits.Load() != 1 {
		t.Fatalf("expected 1 dispatch, got %d", hits.Load())
	}
}

// Failures retry up to MaxAttempts then return an error (→ DLQ by handle()).
func TestDispatchRetriesThenFails(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	p := testPipeline(srv.URL, 2)
	if err := p.dispatchWithRetry(context.Background(), Notification{ID: "n2"}); err == nil {
		t.Fatal("expected terminal failure")
	}
	if hits.Load() != 2 {
		t.Fatalf("expected 2 attempts, got %d", hits.Load())
	}
}

// Config validation: a pipeline without a dispatch target is rejected.
func TestNewRequiresNotifyURL(t *testing.T) {
	if _, err := New(Config{}, slog.New(slog.NewTextHandler(io.Discard, nil))); err == nil {
		t.Fatal("expected error when NOTIFY_URL empty")
	}
}
