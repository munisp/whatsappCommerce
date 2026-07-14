package ratelimit

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/redis/go-redis/v9"
	"github.com/whatsapp-commerce/gateway/internal/config"
)

var rdb *redis.Client

func init() {
	// Initialized lazily; real init happens in Middleware
}

// Middleware applies a sliding-window rate limit per tenant or IP.
func Middleware(cfg *config.Config) gin.HandlerFunc {
	rdb = redis.NewClient(&redis.Options{
		Addr:     cfg.Redis.Addr,
		Password: cfg.Redis.Password,
		DB:       cfg.Redis.DB,
	})
	return func(c *gin.Context) {
		key := rateLimitKey(c)
		limit := 300 // requests per minute
		window := time.Minute

		ctx := context.Background()
		pipe := rdb.Pipeline()
		now := time.Now().UnixMilli()
		windowStart := now - window.Milliseconds()

		pipe.ZRemRangeByScore(ctx, key, "0", fmt.Sprintf("%d", windowStart))
		pipe.ZAdd(ctx, key, redis.Z{Score: float64(now), Member: fmt.Sprintf("%d", now)})
		pipe.ZCard(ctx, key)
		pipe.Expire(ctx, key, window*2)

		cmds, err := pipe.Exec(ctx)
		if err != nil {
			// On Redis failure, allow request through (fail open)
			c.Next()
			return
		}

		count := cmds[2].(*redis.IntCmd).Val()
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

