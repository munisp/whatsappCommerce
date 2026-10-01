package proxy

import (
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

var httpClient = &http.Client{
	Timeout: 30 * time.Second,
	Transport: &http.Transport{
		MaxIdleConns:        200,
		MaxIdleConnsPerHost: 50,
		IdleConnTimeout:     90 * time.Second,
	},
}

// internalAPIKey, when set via SetInternalAPIKey, is forwarded to upstream
// services as X-Internal-Token so they can authenticate gateway-originated
// requests (defense-in-depth behind the gateway's own auth middleware).
var internalAPIKey string

// SetInternalAPIKey configures the shared secret forwarded to internal services.
func SetInternalAPIKey(key string) { internalAPIKey = key }

// ForwardTo returns a gin handler that reverse-proxies the request to the given upstream base URL.
// The full incoming path and query string are preserved.
func ForwardTo(baseURL string) gin.HandlerFunc {
	return func(c *gin.Context) {
		forward(c, baseURL+c.Request.URL.RequestURI())
	}
}

// ForwardToStripPrefix returns a gin handler that reverse-proxies the request to the
// given upstream base URL after stripping stripPrefix from the front of the request
// path. The query string is preserved. Use this when the gateway route carries a
// prefix the upstream does not serve (e.g. /api/v1/ai/intent → /intent).
func ForwardToStripPrefix(baseURL, stripPrefix string) gin.HandlerFunc {
	return func(c *gin.Context) {
		path := c.Request.URL.Path
		rewritten := strings.TrimPrefix(path, stripPrefix)
		if rewritten == "" {
			rewritten = "/"
		}
		if !strings.HasPrefix(rewritten, "/") {
			rewritten = "/" + rewritten
		}
		targetURL := baseURL + rewritten
		if q := c.Request.URL.RawQuery; q != "" {
			targetURL += "?" + q
		}
		forward(c, targetURL)
	}
}

// === W48 sidecars (PERF-SC-22) === maxProxyBodyBytes caps proxied request
// bodies (previously io.ReadAll with no limit — OOM vector).
const maxProxyBodyBytes = 10 << 20 // 10 MiB

// forward performs the actual upstream request and copies the response back.
// PERF-SC-22: bodies are STREAMED both ways (no full io.ReadAll buffering of
// request + response in gateway memory); the inbound body is capped by
// http.MaxBytesReader.
func forward(c *gin.Context, targetURL string) {
	reqBody := http.MaxBytesReader(c.Writer, c.Request.Body, maxProxyBodyBytes)
	req, err := http.NewRequestWithContext(c.Request.Context(), c.Request.Method, targetURL, reqBody)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": "failed to create upstream request"})
		return
	}
	if c.Request.ContentLength > 0 {
		req.ContentLength = c.Request.ContentLength
	}

	// Forward relevant headers. NOTE: the client-supplied X-Tenant-ID header is
	// deliberately NOT forwarded — the tenant context is only ever set from the
	// authenticated token's tenant_id claim (see TenantResolver/auth middleware).
	for _, h := range []string{"Content-Type", "Authorization", "X-Request-ID", "X-Idempotency-Key"} {
		if v := c.GetHeader(h); v != "" {
			req.Header.Set(h, v)
		}
	}
	// Inject resolved context headers
	if tid := c.GetString("tenant_id"); tid != "" {
		req.Header.Set("X-Tenant-ID", tid)
	}
	if internalAPIKey != "" {
		req.Header.Set("X-Internal-Token", internalAPIKey)
	}
	if uid := c.GetString("user_id"); uid != "" {
		req.Header.Set("X-User-ID", uid)
	}
	if role := c.GetString("role"); role != "" {
		req.Header.Set("X-User-Role", role)
	}
	if rid := c.GetString("request_id"); rid != "" {
		req.Header.Set("X-Request-ID", rid)
	}

	resp, err := httpClient.Do(req)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": "upstream unavailable", "detail": err.Error()})
		return
	}
	defer resp.Body.Close()

	for k, vs := range resp.Header {
		for _, v := range vs {
			c.Header(k, v)
		}
	}
	// Stream the upstream response straight to the client (no full-buffer).
	c.Status(resp.StatusCode)
	if _, err := io.Copy(c.Writer, resp.Body); err != nil {
		// Headers already sent — only log-worthy, nothing to return.
		_ = c.Error(err)
	}
}
