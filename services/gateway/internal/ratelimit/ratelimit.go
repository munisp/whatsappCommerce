package ratelimit

import (
	"context"
	"fmt"
	"net/http"
	"sync/atomic"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/redis/go-redis/v9"
	"github.com/whatsapp-commerce/gateway/internal/config"
)

var rdb *redis.Client

func init() {
	// Initialized lazily; real init happens in Middleware
}

// === W48 sidecars (PERF-SC-10) === atomic sliding-window script: one RTT
// (was a 4-command pipeline), unique members (was the millisecond timestamp —
// same-ms requests overwrote each other and undercounted), run under the
// request context with a hard timeout (was context.Background() — a hung
// Redis stalled every gateway request indefinitely).
var slidingWindowScript = redis.NewScript(`
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local member = ARGV[3]
redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
redis.call('ZADD', key, now, member)
local count = redis.call('ZCARD', key)
redis.call('PEXPIRE', key, window * 2)
return count
`)

var memberCounter uint64

// Middleware applies a sliding-window rate limit per tenant or IP.
func Middleware(cfg *config.Config) gin.HandlerFunc {
	rdb = redis.NewClient(&redis.Options{
		Addr:         cfg.Redis.Addr,
		Password:     cfg.Redis.Password,
		DB:           cfg.Redis.DB,
		ReadTimeout:  2 * time.Second,
		WriteTimeout: 2 * time.Second,
		DialTimeout:  2 * time.Second,
	})
	return func(c *gin.Context) {
		key := rateLimitKey(c)
		limit := 300 // requests per minute
		window := time.Minute

		ctx, cancel := context.WithTimeout(c.Request.Context(), 2*time.Second)
		defer cancel()
		now := time.Now().UnixMilli()
		// Unique member per request so same-ms requests cannot collide.
		member := fmt.Sprintf("%d-%s-%d", now, c.GetString("request_id"),
			atomic.AddUint64(&memberCounter, 1))

		count, err := slidingWindowScript.Run(ctx, rdb, []string{key},
			now, window.Milliseconds(), member).Int64()
		if err != nil {
			// On Redis failure/timeout, allow request through (fail open —
			// rate limiting must never take the gateway down; mutating-route
			// fail-closed is handled by auth layers instead).
			c.Next()
			return
		}

		c.Header("X-RateLimit-Limit", fmt.Sprintf("%d", limit))
		c.Header("X-RateLimit-Remaining", fmt.Sprintf("%d", max(0, int64(limit)-count)))

		if count > int64(limit) {
			c.AbortWithStatusJSON(http.StatusTooManyRequests, gin.H{
				"error":       "rate limit exceeded",
				"retry_after": "60",
			})
			return
		}
		c.Next()
	}
}

func rateLimitKey(c *gin.Context) string {
	if tid := c.GetString("tenant_id"); tid != "" {
		return fmt.Sprintf("rl:tenant:%s", tid)
	}
	return fmt.Sprintf("rl:ip:%s", c.ClientIP())
}

func max(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}

