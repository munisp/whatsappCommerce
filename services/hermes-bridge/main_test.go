// === W45 go-rust-services ===
package main

import (
	"context"
	"io"
	"log/slog"
	"testing"
	"time"
)

func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func TestParseApprovalReplyButtonPayloads(t *testing.T) {
	// Quick-reply button payloads arrive as "APPROVE <token>" / "REJECT <token>"
	// — the same shape parseApprovalReply already accepts for typed replies.
	dec, tok, ok := parseApprovalReply("APPROVE abc123")
	if !ok || dec != "approve" || tok != "abc123" {
		t.Fatalf("approve payload: got %q %q %v", dec, tok, ok)
	}
	dec, tok, ok = parseApprovalReply("reject XYZ-789")
	if !ok || dec != "reject" || tok != "xyz-789" {
		t.Fatalf("reject payload: got %q %q %v", dec, tok, ok)
	}
	if _, _, ok := parseApprovalReply("hello"); ok {
		t.Fatal("non-approval text must not parse")
	}
}

func TestValidateConfigCallbackBaseURL(t *testing.T) {
	prod := Config{Env: "production"}
	if err := validateConfig(prod); err == nil {
		t.Fatal("production without HERMES_CALLBACK_BASE_URL must fail")
	}
	prod.PublicCallbackBaseURL = "http://localhost:8095"
	if err := validateConfig(prod); err == nil {
		t.Fatal("loopback callback base URL must fail in production")
	}
	prod.PublicCallbackBaseURL = "not-a-url"
	if err := validateConfig(prod); err == nil {
		t.Fatal("non-URL callback base must fail")
	}
	prod.PublicCallbackBaseURL = "https://bridge.example.com"
	if err := validateConfig(prod); err != nil {
		t.Fatalf("valid public URL rejected: %v", err)
	}
	dev := Config{Env: "development"}
	if err := validateConfig(dev); err != nil {
		t.Fatalf("dev without callback base must be allowed: %v", err)
	}
}

func TestMemoryApprovalStoreExpiryAndReminders(t *testing.T) {
	ctx := context.Background()
	store := newMemoryApprovalStore()
	po := PODraftPayload{POID: "po-1", ApprovalToken: "tok-1", MerchantPhone: "2348001234567"}

	if err := store.Save(ctx, po, 50*time.Millisecond); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Get(ctx, "tok-1"); err != nil {
		t.Fatalf("expected hit before expiry: %v", err)
	}
	// Reminder scheduling + due query.
	_ = store.MarkReminded(ctx, "tok-1", time.Now().Add(-time.Second))
	due, _ := store.DueReminders(ctx, time.Now())
	if len(due) != 1 || due[0] != "tok-1" {
		t.Fatalf("due reminders: %v", due)
	}
	// Expiry: after TTL the approval is gone and reported expired.
	time.Sleep(60 * time.Millisecond)
	if _, err := store.Get(ctx, "tok-1"); err != ErrApprovalNotFound {
		t.Fatalf("expected ErrApprovalNotFound after expiry, got %v", err)
	}
	expired, _ := store.Expired(ctx, time.Now())
	if len(expired) != 1 {
		t.Fatalf("expired sweep should report token: %v", expired)
	}
	// Delete is idempotent-ish and clears reminder tracking.
	if err := store.Delete(ctx, "tok-1"); err != nil {
		t.Fatal(err)
	}
	expired, _ = store.Expired(ctx, time.Now())
	if len(expired) != 0 {
		t.Fatalf("deleted token must not expire again: %v", expired)
	}
}

func TestCallbackURLDevFallback(t *testing.T) {
	ep := &EventProcessor{cfg: Config{Port: "8095"}, logger: testLogger()}
	if got := ep.callbackURL(); got != "http://localhost:8095/hermes/callback" {
		t.Fatalf("dev fallback: %q", got)
	}
	ep.cfg.PublicCallbackBaseURL = "https://bridge.example.com/"
	if got := ep.callbackURL(); got != "https://bridge.example.com/hermes/callback" {
		t.Fatalf("public base: %q", got)
	}
}
