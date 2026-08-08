package ratelimit

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/whatsapp-commerce/gateway/internal/config"
)

// The Go gateway rate limiter fails OPEN when Redis is unreachable: a broken
// counter must never block checkout traffic at the edge. (Production-grade
// fail-closed limiting lives one hop downstream at the tRPC API layer — see
// server/_core/rateLimit.ts — while this gateway limiter is an advisory
// first line of defense.)
//
// NOTE: the Rust services (ledger-bridge, recon-worker) have ZERO Redis
// dependency — ledger idempotency/dedup is deterministic via
// uuid5(idempotency_key) against TigerBeetle (see
// rust/ledger-bridge/src/main.rs deterministic_id), so a Redis outage can
// never double-reserve or double-post at the ledger.

func testConfig(redisAddr string) *config.Config {
	cfg := &config.Config{}
	cfg.Redis.Addr = redisAddr
	return cfg
}

func newTestRouter(cfg *config.Config) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(Middleware(cfg))
	r.GET("/ping", func(c *gin.Context) { c.JSON(http.StatusOK, gin.H{"ok": true}) })
	return r
}

// Redis unreachable → requests pass through (fail open), no 5xx, no 429.
func TestMiddlewareFailsOpenWhenRedisUnreachable(t *testing.T) {
	// Port 1 (discard) is closed on loopback — connection refused immediately.
	r := newTestRouter(testConfig("127.0.0.1:1"))

	for i := 0; i < 5; i++ {
		w := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/ping", nil)
		r.ServeHTTP(w, req)
		if w.Code != http.StatusOK {
			t.Fatalf("request %d: expected 200 (fail-open), got %d body=%s", i, w.Code, w.Body.String())
		}
	}
}

// Even far beyond the 300 req/min limit, an unreachable Redis must never
// produce a 429 — the limiter only limits when it can actually count.
func TestMiddlewareNeverRateLimitsWithoutRedis(t *testing.T) {
	r := newTestRouter(testConfig("127.0.0.1:1"))
	for i := 0; i < 20; i++ {
		w := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/ping", nil)
		r.ServeHTTP(w, req)
		if w.Code == http.StatusTooManyRequests {
			t.Fatalf("request %d: got 429 with Redis down — limiter must fail open", i)
		}
	}
}

// rateLimitKey prefers the tenant id over the client IP.
func TestRateLimitKeyPrefersTenant(t *testing.T) {
	gin.SetMode(gin.TestMode)
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = httptest.NewRequest(http.MethodGet, "/", nil)
	c.Set("tenant_id", "tenant-abc")
	if got := rateLimitKey(c); got != "rl:tenant:tenant-abc" {
		t.Fatalf("expected tenant-scoped key, got %q", got)
	}

	c2, _ := gin.CreateTestContext(httptest.NewRecorder())
	c2.Request = httptest.NewRequest(http.MethodGet, "/", nil)
	c2.Request.RemoteAddr = "203.0.113.7:12345"
	if got := rateLimitKey(c2); got != "rl:ip:203.0.113.7" {
		t.Fatalf("expected ip-scoped key, got %q", got)
	}
}
