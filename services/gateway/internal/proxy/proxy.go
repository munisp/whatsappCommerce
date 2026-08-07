package proxy

import (
	"bytes"
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

// forward performs the actual upstream request and copies the response back.
func forward(c *gin.Context, targetURL string) {
	body, err := io.ReadAll(c.Request.Body)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": "failed to read request body"})
		return
	}

	req, err := http.NewRequestWithContext(c.Request.Context(), c.Request.Method, targetURL, bytes.NewReader(body))
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": "failed to create upstream request"})
		return
	}

	// Forward relevant headers
	for _, h := range []string{"Content-Type", "Authorization", "X-Request-ID", "X-Tenant-ID", "X-Idempotency-Key"} {
		if v := c.GetHeader(h); v != "" {
			req.Header.Set(h, v)
		}
	}
	// Inject resolved context headers
	if tid := c.GetString("tenant_id"); tid != "" {
		req.Header.Set("X-Tenant-ID", tid)
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

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": "failed to read upstream response"})
		return
	}

	for k, vs := range resp.Header {
		for _, v := range vs {
			c.Header(k, v)
		}
	}
	c.Data(resp.StatusCode, resp.Header.Get("Content-Type"), respBody)
}
