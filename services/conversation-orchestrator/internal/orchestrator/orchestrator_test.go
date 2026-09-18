// === W45 go-rust-services ===
package orchestrator

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"
	"github.com/whatsapp-commerce/conversation-orchestrator/internal/config"
	"go.uber.org/zap"
)

// MSG-17: sendChatwootReply must hit the REAL Chatwoot messages API with the
// access-token header — no longer a log-only stub.
func TestSendChatwootReplyRealAPI(t *testing.T) {
	var gotPath, gotToken, gotType string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotToken = r.Header.Get("api_access_token")
		var body map[string]interface{}
		_ = json.NewDecoder(r.Body).Decode(&body)
		gotType, _ = body["message_type"].(string)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	o := New(&config.Config{
		ChatwootURL:            srv.URL,
		ChatwootAccountID:      "7",
		ChatwootAPIAccessToken: "tok-abc",
	}, nil, zap.NewNop())

	if err := o.sendChatwootReply(context.Background(), uuid.New(), 42, "hello"); err != nil {
		t.Fatalf("sendChatwootReply: %v", err)
	}
	if gotPath != "/api/v1/accounts/7/conversations/42/messages" {
		t.Fatalf("path: %q", gotPath)
	}
	if gotToken != "tok-abc" {
		t.Fatalf("api_access_token header missing: %q", gotToken)
	}
	if gotType != "outgoing" {
		t.Fatalf("message_type: %q", gotType)
	}
}

// Errors propagate (4xx → error), never silently swallowed.
func TestSendChatwootReplyErrorPropagates(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer srv.Close()
	o := New(&config.Config{ChatwootURL: srv.URL, ChatwootAccountID: "1"}, nil, zap.NewNop())
	if err := o.sendChatwootReply(context.Background(), uuid.New(), 1, "hi"); err == nil {
		t.Fatal("expected error on 401")
	}
}

func TestSetChatwootStatus(t *testing.T) {
	var gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()
	o := New(&config.Config{ChatwootURL: srv.URL, ChatwootAccountID: "3"}, nil, zap.NewNop())
	if err := o.setChatwootStatus(context.Background(), 9, "resolved"); err != nil {
		t.Fatal(err)
	}
	if gotPath != "/api/v1/accounts/3/conversations/9/toggle_status" {
		t.Fatalf("path: %q", gotPath)
	}
}
