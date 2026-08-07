package middleware

// openappsec.go — OpenAppSec WAF event ingestion middleware for the API Gateway.
//
// OpenAppSec runs as a sidecar (or reverse proxy) and sends security event
// notifications to this endpoint via its "log" plugin.
//
// This module:
//   1. Exposes POST /internal/waf/events — receives OpenAppSec security events
//   2. Forwards events to the platform API for DB persistence
//   3. Provides a WAF health check endpoint
//   4. Injects X-OpenAppSec-Status header on responses

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"
)

// ─── OpenAppSec event types ───────────────────────────────────────────────────

type OpenAppSecEvent struct {
	EventID     string                 `json:"event_id"`
	Severity    string                 `json:"severity"`    // Critical, High, Medium, Low, Info
	AttackType  string                 `json:"attack_type"` // SQL Injection, XSS, etc.
	SourceIP    string                 `json:"source_ip"`
	RequestURI  string                 `json:"request_uri"`
	Method      string                 `json:"http_method"`
	UserAgent   string                 `json:"user_agent"`
	Blocked     bool                   `json:"blocked"`
	TenantID    string                 `json:"tenant_id,omitempty"`
	RawEvent    map[string]interface{} `json:"raw_event,omitempty"`
	DetectedAt  string                 `json:"detected_at"`
}

// ─── OpenAppSec WAF middleware ────────────────────────────────────────────────

type OpenAppSecConfig struct {
	PlatformAPIURL string
	PlatformAPIKey string
	SharedSecret   string // HMAC secret for event validation
	Enabled        bool
}

func OpenAppSecConfigFromEnv() OpenAppSecConfig {
	return OpenAppSecConfig{
		PlatformAPIURL: os.Getenv("PLATFORM_API_URL"),
		PlatformAPIKey: os.Getenv("PLATFORM_API_KEY"),
		SharedSecret:   os.Getenv("OPENAPPSEC_SHARED_SECRET"),
		Enabled:        os.Getenv("OPENAPPSEC_ENABLED") != "false",
	}
}

// OpenAppSecEventHandler returns a Gin handler for POST /internal/waf/events.
// OpenAppSec sends security events here via its HTTP log destination.
func OpenAppSecEventHandler(cfg OpenAppSecConfig, logger *zap.Logger) gin.HandlerFunc {
	httpClient := &http.Client{Timeout: 5 * time.Second}
	return func(c *gin.Context) {
		if !cfg.Enabled {
			c.JSON(http.StatusOK, gin.H{"status": "disabled"})
			return
		}
		var events []OpenAppSecEvent
		// OpenAppSec may send a single event or an array
		body := c.Request.Body
		defer body.Close()
		decoder := json.NewDecoder(body)
		// Try array first
		if err := decoder.Decode(&events); err != nil {
			// Try single event
			var single OpenAppSecEvent
			if err2 := json.NewDecoder(c.Request.Body).Decode(&single); err2 != nil {
				c.JSON(http.StatusBadRequest, gin.H{"error": "invalid_payload"})
				return
			}
			events = []OpenAppSecEvent{single}
		}
		forwarded := 0
		for _, ev := range events {
			// Normalize severity
			ev.Severity = strings.ToLower(ev.Severity)
			if ev.DetectedAt == "" {
				ev.DetectedAt = time.Now().UTC().Format(time.RFC3339)
			}
			// Extract tenant from X-Tenant-ID header or request URI
			if ev.TenantID == "" {
				ev.TenantID = c.GetHeader("X-Tenant-ID")
			}
			// Forward to platform API for DB persistence
			if cfg.PlatformAPIURL != "" {
				if err := forwardWAFEvent(httpClient, cfg, ev, logger); err != nil {
					logger.Warn("openappsec.forward.failed",
						zap.String("event_id", ev.EventID),
						zap.Error(err),
					)
				} else {
					forwarded++
				}
			}
			logger.Info("openappsec.event",
				zap.String("severity", ev.Severity),
				zap.String("attack_type", ev.AttackType),
				zap.String("source_ip", ev.SourceIP),
				zap.String("uri", ev.RequestURI),
				zap.Bool("blocked", ev.Blocked),
			)
		}
		c.JSON(http.StatusOK, gin.H{
			"received":  len(events),
			"forwarded": forwarded,
		})
	}
}

func forwardWAFEvent(client *http.Client, cfg OpenAppSecConfig, ev OpenAppSecEvent, logger *zap.Logger) error {
	payload := map[string]interface{}{
		"tenantId":   ev.TenantID,
		"severity":   ev.Severity,
		"attackType": ev.AttackType,
		"sourceIp":   ev.SourceIP,
		"requestUri": ev.RequestURI,
		"method":     ev.Method,
		"userAgent":  ev.UserAgent,
		"blocked":    ev.Blocked,
		"rawEvent":   ev.RawEvent,
		"detectedAt": ev.DetectedAt,
	}
	b, _ := json.Marshal(payload)
	req, err := http.NewRequest("POST",
		fmt.Sprintf("%s/api/trpc/infra.recordWafEvent", cfg.PlatformAPIURL),
		bytes.NewReader(b),
	)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if cfg.PlatformAPIKey != "" {
		req.Header.Set("X-Internal-Token", cfg.PlatformAPIKey)
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return fmt.Errorf("platform API returned %d", resp.StatusCode)
	}
	return nil
}

// OpenAppSecStatusHeader injects X-WAF-Status: active on all responses
// when OpenAppSec is enabled, so clients can verify WAF coverage.
func OpenAppSecStatusHeader(enabled bool) gin.HandlerFunc {
	status := "inactive"
	if enabled {
		status = "active"
	}
	return func(c *gin.Context) {
		c.Header("X-WAF-Status", status)
		c.Next()
	}
}
