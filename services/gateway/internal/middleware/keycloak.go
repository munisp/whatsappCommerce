// keycloak.go — Keycloak JWKS-based RS256 JWT validation middleware
// Validates Bearer tokens issued by Keycloak using the JWKS endpoint.
// Falls back to token introspection when JWKS validation fails.
package middleware

import (
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
	"github.com/whatsapp-commerce/gateway/internal/config"
	"go.uber.org/zap"
)

// ─── JWKS Cache ───────────────────────────────────────────────────────────────

type jwksKey struct {
	Kid string `json:"kid"`
	Kty string `json:"kty"`
	Alg string `json:"alg"`
	Use string `json:"use"`
	N   string `json:"n"`
	E   string `json:"e"`
}

type jwksResponse struct {
	Keys []jwksKey `json:"keys"`
}

type jwksCache struct {
	mu        sync.RWMutex
	keys      map[string]*rsa.PublicKey
	fetchedAt time.Time
	ttl       time.Duration
	endpoint  string
}

var globalJWKSCache = &jwksCache{
	keys: make(map[string]*rsa.PublicKey),
	ttl:  10 * time.Minute,
}

func (c *jwksCache) getKey(kid string) (*rsa.PublicKey, error) {
	c.mu.RLock()
	if time.Since(c.fetchedAt) < c.ttl {
		if k, ok := c.keys[kid]; ok {
			c.mu.RUnlock()
			return k, nil
		}
	}
	c.mu.RUnlock()

	// Refresh
	c.mu.Lock()
	defer c.mu.Unlock()
	if err := c.fetch(); err != nil {
		return nil, err
	}
	if k, ok := c.keys[kid]; ok {
		return k, nil
	}
	return nil, fmt.Errorf("key %q not found in JWKS", kid)
}

func (c *jwksCache) fetch() error {
	resp, err := http.Get(c.endpoint) //nolint:gosec
	if err != nil {
		return fmt.Errorf("fetch JWKS: %w", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	var jwks jwksResponse
	if err := json.Unmarshal(body, &jwks); err != nil {
		return fmt.Errorf("parse JWKS: %w", err)
	}
	newKeys := make(map[string]*rsa.PublicKey, len(jwks.Keys))
	for _, k := range jwks.Keys {
		if k.Kty != "RSA" {
			continue
		}
		pub, err := rsaPublicKeyFromJWK(k)
		if err != nil {
			continue
		}
		newKeys[k.Kid] = pub
	}
	c.keys = newKeys
	c.fetchedAt = time.Now()
	return nil
}

func rsaPublicKeyFromJWK(k jwksKey) (*rsa.PublicKey, error) {
	nBytes, err := base64.RawURLEncoding.DecodeString(k.N)
	if err != nil {
		return nil, err
	}
	eBytes, err := base64.RawURLEncoding.DecodeString(k.E)
	if err != nil {
		return nil, err
	}
	n := new(big.Int).SetBytes(nBytes)
	e := int(new(big.Int).SetBytes(eBytes).Int64())
	return &rsa.PublicKey{N: n, E: e}, nil
}

// ─── Keycloak Claims ──────────────────────────────────────────────────────────

type KeycloakClaims struct {
	Sub               string   `json:"sub"`
	PreferredUsername string   `json:"preferred_username"`
	Email             string   `json:"email"`
	RealmRoles        []string `json:"realm_roles,omitempty"`
	TenantID          string   `json:"tenant_id,omitempty"`
	jwt.RegisteredClaims
}

// ─── Middleware ───────────────────────────────────────────────────────────────

// KeycloakJWTAuth validates Keycloak-issued RS256 Bearer tokens.
// It uses JWKS for validation and falls back to introspection on failure.
func KeycloakJWTAuth(cfg *config.Config, logger *zap.Logger) gin.HandlerFunc {
	globalJWKSCache.endpoint = cfg.Keycloak.JWKSEndpoint

	return func(c *gin.Context) {
		authHeader := c.GetHeader("Authorization")
		if authHeader == "" || !strings.HasPrefix(authHeader, "Bearer ") {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "missing_token"})
			return
		}
		tokenStr := strings.TrimPrefix(authHeader, "Bearer ")

		// Parse header to get kid
		unverified, _, err := new(jwt.Parser).ParseUnverified(tokenStr, &KeycloakClaims{})
		if err != nil {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "malformed_token"})
			return
		}
		kid, _ := unverified.Header["kid"].(string)

		// Try JWKS validation
		pubKey, err := globalJWKSCache.getKey(kid)
		if err != nil {
			// Fallback: introspect with Keycloak
			if !introspectToken(cfg, tokenStr) {
				logger.Warn("keycloak.auth.failed", zap.String("kid", kid), zap.Error(err))
				c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "invalid_token"})
				return
			}
			c.Next()
			return
		}

		claims := &KeycloakClaims{}
		token, err := jwt.ParseWithClaims(tokenStr, claims, func(t *jwt.Token) (interface{}, error) {
			if _, ok := t.Method.(*jwt.SigningMethodRSA); !ok {
				return nil, fmt.Errorf("unexpected signing method: %v", t.Header["alg"])
			}
			return pubKey, nil
		})
		if err != nil || !token.Valid {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "invalid_token"})
			return
		}

		c.Set("user_id", claims.Sub)
		c.Set("username", claims.PreferredUsername)
		c.Set("email", claims.Email)
		c.Set("tenant_id", claims.TenantID)
		c.Set("realm_roles", claims.RealmRoles)
		c.Next()
	}
}

// introspectToken calls Keycloak's token introspection endpoint.
func introspectToken(cfg *config.Config, tokenStr string) bool {
	if cfg.Keycloak.ClientID == "" || cfg.Keycloak.ClientSecret == "" {
		return false
	}
	form := url.Values{
		"token":         {tokenStr},
		"client_id":     {cfg.Keycloak.ClientID},
		"client_secret": {cfg.Keycloak.ClientSecret},
	}
	resp, err := http.PostForm(cfg.Keycloak.IntrospectURL, form)
	if err != nil || resp.StatusCode != http.StatusOK {
		return false
	}
	defer resp.Body.Close()
	var result struct {
		Active bool `json:"active"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return false
	}
	return result.Active
}
