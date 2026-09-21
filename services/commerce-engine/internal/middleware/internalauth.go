// Package middleware holds commerce-engine's own HTTP middleware. This is a deliberate, small duplicate of
// gateway's InternalTokenAuth (services/gateway/internal/middleware/middleware.go) rather than a shared
// package: the two services have no existing shared internal Go module, and ~30 lines is cheaper to
// duplicate than to coordinate a new cross-service dependency for.
package middleware

import (
	"crypto/subtle"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/whatsapp-commerce/commerce-engine/internal/config"
	"go.uber.org/zap"
)

// InternalAuth protects every route it is applied to with a shared secret, checked against
// X-Internal-Api-Key (X-Internal-Token / X-Api-Key also accepted, matching server's internalProcedure and
// gateway's InternalTokenAuth). Fails closed in production when INTERNAL_API_KEY is not configured.
//
// QA-038: commerce-engine's handlers trust an X-Tenant-ID header with no authentication of their own — the
// NetworkPolicy (QA-026) restricts WHO can reach the pod, this restricts WHAT they may ask it to do. The
// ONLY configured live caller of this service is event-processor (gateway's own COMMERCE_ENGINE_URL proxy
// routes exist in source but are unconfigured in this deployment, so protecting every route but /health is
// correct today — if that ever changes, gateway becomes a caller that also needs to send this header).
func InternalAuth(cfg *config.Config, logger *zap.Logger) gin.HandlerFunc {
	if cfg.InternalAPIKey == "" {
		if cfg.Env == "production" {
			logger.Error("INTERNAL_API_KEY is not set — every route except /health will reject all requests (fail closed)")
		} else {
			logger.Warn("INTERNAL_API_KEY is not set — every route except /health is UNAUTHENTICATED (rollout stage: deploy before callers send the header, then set this)")
		}
	}
	return func(c *gin.Context) {
		if cfg.InternalAPIKey == "" {
			if cfg.Env == "production" {
				c.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{"error": "internal authentication not configured"})
				return
			}
			c.Next()
			return
		}
		presented := c.GetHeader("X-Internal-Api-Key")
		if presented == "" {
			presented = c.GetHeader("X-Internal-Token")
		}
		if presented == "" {
			presented = c.GetHeader("X-Api-Key")
		}
		if subtle.ConstantTimeCompare([]byte(presented), []byte(cfg.InternalAPIKey)) != 1 {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "invalid_internal_api_key"})
			return
		}
		c.Next()
	}
}
