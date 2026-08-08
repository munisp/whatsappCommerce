package middleware

// permify.go — Permify fine-grained authorization middleware for the API Gateway.
//
// Integrates with Permify's gRPC/HTTP API to enforce relationship-based access
// control (ReBAC) on every authenticated request.
//
// Permission model (mirrors permify-schema.perm):
//   tenant:  member, admin, owner
//   product: view, edit, delete
//   order:   view, fulfill, cancel
//   system:  manage
//
// Usage:
//   r.Use(middleware.PermifyAuthz(cfg, logger))
//   r.GET("/orders/:id", middleware.RequirePermify("order", "view"), handler)

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/whatsapp-commerce/gateway/internal/config"
	"go.uber.org/zap"
)

// ─── Permify HTTP API types ───────────────────────────────────────────────────

type permifyEntity struct {
	Type string `json:"type"`
	ID   string `json:"id"`
}

type permifySubject struct {
	Type     string `json:"type"`
	ID       string `json:"id"`
	Relation string `json:"relation,omitempty"`
}

type permifyCheckRequest struct {
	Metadata   permifyCheckMeta `json:"metadata"`
	Entity     permifyEntity    `json:"entity"`
	Permission string           `json:"permission"`
	Subject    permifySubject   `json:"subject"`
}

type permifyCheckMeta struct {
	SchemaVersion  string `json:"schema_version"`
	SnapToken      string `json:"snap_token"`
	Depth          int    `json:"depth"`
}

type permifyCheckResponse struct {
	Can string `json:"can"` // "RESULT_ALLOWED" | "RESULT_DENIED"
}

type permifyWriteRequest struct {
	Metadata permifyWriteMeta    `json:"metadata"`
	Tuples   []permifyTuple      `json:"tuples"`
}

type permifyWriteMeta struct {
	SchemaVersion string `json:"schema_version"`
}

type permifyTuple struct {
	Entity   permifyEntity  `json:"entity"`
	Relation string         `json:"relation"`
	Subject  permifySubject `json:"subject"`
}

// ─── PermifyClient ────────────────────────────────────────────────────────────

type PermifyClient struct {
	baseURL    string
	tenantID   string
	apiKey     string
	http       *http.Client
	logger     *zap.Logger
	failClosed bool
}

// NewPermifyClient builds a client. failClosed should be
// cfg.IsProductionLike(): in production-like environments an unconfigured,
// unreachable or erroring Permify DENIES the check; in explicit dev/test it
// fails open with a loud log so local dev doesn't require a running Permify.
// This mirrors the TS server/permify.ts semantics.
func NewPermifyClient(baseURL, tenantID, apiKey string, failClosed bool, logger *zap.Logger) *PermifyClient {
	return &PermifyClient{
		baseURL:    strings.TrimRight(baseURL, "/"),
		tenantID:   tenantID,
		apiKey:     apiKey,
		http:       &http.Client{Timeout: 3 * time.Second},
		logger:     logger,
		failClosed: failClosed,
	}
}

// denyOrAllow applies the failure policy: deny (fail closed) in
// production-like environments, allow with a loud log only in dev/test.
func (c *PermifyClient) denyOrAllow(reason string, fields ...zap.Field) (bool, error) {
	if c.failClosed {
		c.logger.Error("permify.check."+reason+" — DENYING (fail closed)", fields...)
		return false, nil
	}
	c.logger.Warn("permify.check."+reason+" — allowing (dev fail-open)", fields...)
	return true, nil
}

func (c *PermifyClient) headers() http.Header {
	h := http.Header{}
	h.Set("Content-Type", "application/json")
	if c.apiKey != "" {
		h.Set("Authorization", "Bearer "+c.apiKey)
	}
	return h
}

// Check returns true if the subject has the given permission on the entity.
// Failure policy (mirrors TS server/permify.ts): fail CLOSED (deny) in
// production-like environments when Permify is unconfigured, unreachable,
// returns 5xx, or its response cannot be parsed; fail open with a loud log
// only in explicit dev/test.
func (c *PermifyClient) Check(entityType, entityID, permission, subjectType, subjectID string) (bool, error) {
	if c.baseURL == "" {
		return c.denyOrAllow("unconfigured")
	}
	body := permifyCheckRequest{
		Metadata:   permifyCheckMeta{Depth: 20},
		Entity:     permifyEntity{Type: entityType, ID: entityID},
		Permission: permission,
		Subject:    permifySubject{Type: subjectType, ID: subjectID},
	}
	b, _ := json.Marshal(body)
	url := fmt.Sprintf("%s/v1/tenants/%s/permissions/check", c.baseURL, c.tenantID)
	req, _ := http.NewRequest("POST", url, bytes.NewReader(b))
	req.Header = c.headers()
	resp, err := c.http.Do(req)
	if err != nil {
		return c.denyOrAllow("unreachable", zap.Error(err))
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 500 {
		return c.denyOrAllow("server_error", zap.Int("status", resp.StatusCode))
	}
	data, _ := io.ReadAll(resp.Body)
	var result permifyCheckResponse
	if err := json.Unmarshal(data, &result); err != nil {
		return c.denyOrAllow("parse_error", zap.Error(err))
	}
	return result.Can == "RESULT_ALLOWED", nil
}

// WriteRelationship grants a relationship tuple in Permify.
func (c *PermifyClient) WriteRelationship(entityType, entityID, relation, subjectType, subjectID string) error {
	if c.baseURL == "" {
		return nil
	}
	body := permifyWriteRequest{
		Tuples: []permifyTuple{{
			Entity:   permifyEntity{Type: entityType, ID: entityID},
			Relation: relation,
			Subject:  permifySubject{Type: subjectType, ID: subjectID},
		}},
	}
	b, _ := json.Marshal(body)
	url := fmt.Sprintf("%s/v1/tenants/%s/relationships/write", c.baseURL, c.tenantID)
	req, _ := http.NewRequest("POST", url, bytes.NewReader(b))
	req.Header = c.headers()
	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("permify write: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("permify write failed %d: %s", resp.StatusCode, string(body))
	}
	return nil
}

// Health checks Permify connectivity.
func (c *PermifyClient) Health() (bool, int64) {
	if c.baseURL == "" {
		return false, 0
	}
	start := time.Now()
	resp, err := c.http.Get(c.baseURL + "/healthz")
	latency := time.Since(start).Milliseconds()
	if err != nil || resp.StatusCode >= 400 {
		return false, latency
	}
	return true, latency
}

// ─── Gin Middleware ───────────────────────────────────────────────────────────

// PermifyAuthz is a Gin middleware that injects the PermifyClient into context.
// Place this after JWTAuth so user_id and tenant_id are available.
func PermifyAuthz(cfg *config.Config, logger *zap.Logger) gin.HandlerFunc {
	permifyURL := cfg.Permify.URL
	tenantID := cfg.Permify.TenantID
	apiKey := cfg.Permify.APIKey
	client := NewPermifyClient(permifyURL, tenantID, apiKey, cfg.IsProductionLike(), logger)
	return func(c *gin.Context) {
		c.Set("permify", client)
		c.Next()
	}
}

// RequirePermify returns a Gin handler that enforces a Permify permission check.
// entityType: "tenant" | "order" | "product" | "system"
// permission: "view" | "edit" | "delete" | "manage" | "fulfill" | "cancel"
// entityIDParam: gin path param name for the entity ID, or "" for system-level checks.
func RequirePermify(entityType, permission, entityIDParam string) gin.HandlerFunc {
	return func(c *gin.Context) {
		client, exists := c.Get("permify")
		if !exists {
			c.Next()
			return
		}
		pc := client.(*PermifyClient)
		userID := c.GetString("user_id")
		if userID == "" {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "unauthenticated"})
			return
		}
		entityID := "global"
		if entityIDParam != "" {
			entityID = c.Param(entityIDParam)
			if entityID == "" {
				entityID = c.Query("id")
			}
		}
		// For tenant-scoped resources, use the tenant_id from the JWT
		if entityType == "tenant" && entityID == "global" {
			entityID = c.GetString("tenant_id")
		}
		allowed, err := pc.Check(entityType, entityID, permission, "user", userID)
		if err != nil || !allowed {
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{
				"error":      "permission_denied",
				"entity":     entityType + ":" + entityID,
				"permission": permission,
			})
			return
		}
		c.Next()
	}
}

// RequireRealmRole checks that the user has one of the given Keycloak realm roles.
// This is a fast local check that doesn't call Permify. It requires
// KeycloakJWTAuth (which populates "realm_roles"); use middleware.RequireRole
// with the plain JWTAuth middleware, which populates "role".
func RequireRealmRole(roles ...string) gin.HandlerFunc {
	roleSet := make(map[string]struct{}, len(roles))
	for _, r := range roles {
		roleSet[r] = struct{}{}
	}
	return func(c *gin.Context) {
		realmRoles, _ := c.Get("realm_roles")
		userRoles, _ := realmRoles.([]string)
		for _, r := range userRoles {
			if _, ok := roleSet[r]; ok {
				c.Next()
				return
			}
		}
		c.AbortWithStatusJSON(http.StatusForbidden, gin.H{
			"error":          "insufficient_role",
			"required_roles": roles,
		})
	}
}
