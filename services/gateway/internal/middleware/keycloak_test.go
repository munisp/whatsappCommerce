// keycloak_test.go — JWT structure/algorithm/expiry validation tests for the
// gateway Keycloak middleware, plus a concurrency check that expired tokens
// are rejected even under parallel load.
package middleware

import (
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
	"github.com/whatsapp-commerce/gateway/internal/config"
	"go.uber.org/zap"
)

// ─── Test JWKS server ─────────────────────────────────────────────────────────

func newTestJWKS(t *testing.T) (*httptest.Server, *rsa.PrivateKey, string) {
	t.Helper()
	priv, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("generate RSA key: %v", err)
	}
	kid := "test-kid-1"
	jwks := map[string]any{
		"keys": []map[string]any{{
			"kid": kid,
			"kty": "RSA",
			"alg": "RS256",
			"use": "sig",
			"n":   base64.RawURLEncoding.EncodeToString(priv.PublicKey.N.Bytes()),
			"e":   base64.RawURLEncoding.EncodeToString(big.NewInt(int64(priv.PublicKey.E)).Bytes()),
		}},
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(jwks)
	}))
	t.Cleanup(srv.Close)
	return srv, priv, kid
}

func newTestGateway(t *testing.T, jwksURL, issuer, audience string) *httptest.Server {
	t.Helper()
	gin.SetMode(gin.TestMode)
	cfg := &config.Config{}
	cfg.Keycloak.JWKSEndpoint = jwksURL
	cfg.Keycloak.URL = issuer
	cfg.Keycloak.Realm = "wacommerce"
	cfg.Keycloak.Audience = audience
	// Introspection disabled — unknown keys must fail closed to 401.
	cfg.Keycloak.ClientID = ""
	cfg.Keycloak.ClientSecret = ""

	// Reset the package-level JWKS cache so each test gateway is isolated.
	globalJWKSCache.mu.Lock()
	globalJWKSCache.keys = make(map[string]*rsa.PublicKey)
	globalJWKSCache.fetchedAt = time.Time{}
	globalJWKSCache.endpoint = jwksURL
	globalJWKSCache.mu.Unlock()

	r := gin.New()
	r.Use(KeycloakJWTAuth(cfg, zap.NewNop()))
	r.GET("/ping", func(c *gin.Context) { c.JSON(http.StatusOK, gin.H{"ok": true}) })
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)
	return srv
}

func signToken(t *testing.T, priv *rsa.PrivateKey, kid string, claims jwt.MapClaims) string {
	t.Helper()
	tok := jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
	tok.Header["kid"] = kid
	s, err := tok.SignedString(priv)
	if err != nil {
		t.Fatalf("sign token: %v", err)
	}
	return s
}

func doGet(t *testing.T, baseURL, token string) int {
	t.Helper()
	req, err := http.NewRequest("GET", baseURL+"/ping", nil)
	if err != nil {
		t.Fatal(err)
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("GET /ping: %v", err)
	}
	defer resp.Body.Close()
	return resp.StatusCode
}

// ─── Tests ────────────────────────────────────────────────────────────────────

func TestKeycloakJWTAuth_AcceptsValidRS256(t *testing.T) {
	jwks, priv, kid := newTestJWKS(t)
	issuer := jwks.URL
	gw := newTestGateway(t, jwks.URL, issuer, "")

	tok := signToken(t, priv, kid, jwt.MapClaims{
		"sub": "user-1",
		"iss": issuer + "/realms/wacommerce",
		"exp": time.Now().Add(5 * time.Minute).Unix(),
		"iat": time.Now().Unix(),
	})
	if code := doGet(t, gw.URL, tok); code != http.StatusOK {
		t.Fatalf("valid token: got %d, want 200", code)
	}
}

func TestKeycloakJWTAuth_RejectsAlgNone(t *testing.T) {
	jwks, _, _ := newTestJWKS(t)
	issuer := jwks.URL
	gw := newTestGateway(t, jwks.URL, issuer, "")

	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"none","typ":"JWT"}`))
	payload := base64.RawURLEncoding.EncodeToString([]byte(`{"sub":"attacker","iss":"` + issuer + `/realms/wacommerce","exp":9999999999}`))
	noneTok := header + "." + payload + "."
	if code := doGet(t, gw.URL, noneTok); code != http.StatusUnauthorized {
		t.Fatalf("alg=none token: got %d, want 401", code)
	}
}

func TestKeycloakJWTAuth_RejectsMalformed(t *testing.T) {
	jwks, _, _ := newTestJWKS(t)
	gw := newTestGateway(t, jwks.URL, jwks.URL, "")

	for name, tok := range map[string]string{
		"empty":          "",
		"single-part":    "abc",
		"two-part":       "abc.def",
		"four-part":      "a.b.c.d",
		"bad-base64":     "!!!.@@@.###",
		"not-json":       base64.RawURLEncoding.EncodeToString([]byte("x")) + "." + base64.RawURLEncoding.EncodeToString([]byte("y")) + ".z",
	} {
		if code := doGet(t, gw.URL, tok); code != http.StatusUnauthorized {
			t.Fatalf("%s token: got %d, want 401", name, code)
		}
	}
}

func TestKeycloakJWTAuth_RejectsExpired(t *testing.T) {
	jwks, priv, kid := newTestJWKS(t)
	issuer := jwks.URL
	gw := newTestGateway(t, jwks.URL, issuer, "")

	tok := signToken(t, priv, kid, jwt.MapClaims{
		"sub": "user-1",
		"iss": issuer + "/realms/wacommerce",
		"exp": time.Now().Add(-time.Hour).Unix(),
		"iat": time.Now().Add(-2 * time.Hour).Unix(),
	})
	if code := doGet(t, gw.URL, tok); code != http.StatusUnauthorized {
		t.Fatalf("expired token: got %d, want 401", code)
	}
}

func TestKeycloakJWTAuth_RejectsMissingExp(t *testing.T) {
	jwks, priv, kid := newTestJWKS(t)
	issuer := jwks.URL
	gw := newTestGateway(t, jwks.URL, issuer, "")

	tok := signToken(t, priv, kid, jwt.MapClaims{
		"sub": "user-1",
		"iss": issuer + "/realms/wacommerce",
		// no exp claim — jwt.WithExpirationRequired must reject
	})
	if code := doGet(t, gw.URL, tok); code != http.StatusUnauthorized {
		t.Fatalf("no-exp token: got %d, want 401", code)
	}
}

func TestKeycloakJWTAuth_RejectsWrongIssuer(t *testing.T) {
	jwks, priv, kid := newTestJWKS(t)
	gw := newTestGateway(t, jwks.URL, jwks.URL, "")

	tok := signToken(t, priv, kid, jwt.MapClaims{
		"sub": "user-1",
		"iss": "https://evil.example.com/realms/wacommerce",
		"exp": time.Now().Add(5 * time.Minute).Unix(),
	})
	if code := doGet(t, gw.URL, tok); code != http.StatusUnauthorized {
		t.Fatalf("wrong-issuer token: got %d, want 401", code)
	}
}

func TestKeycloakJWTAuth_RejectsWrongAudience(t *testing.T) {
	jwks, priv, kid := newTestJWKS(t)
	issuer := jwks.URL
	gw := newTestGateway(t, jwks.URL, issuer, "wacommerce-app")

	wrongAud := signToken(t, priv, kid, jwt.MapClaims{
		"sub": "user-1",
		"iss": issuer + "/realms/wacommerce",
		"aud": "some-other-app",
		"exp": time.Now().Add(5 * time.Minute).Unix(),
	})
	if code := doGet(t, gw.URL, wrongAud); code != http.StatusUnauthorized {
		t.Fatalf("wrong-audience token: got %d, want 401", code)
	}

	rightAud := signToken(t, priv, kid, jwt.MapClaims{
		"sub": "user-1",
		"iss": issuer + "/realms/wacommerce",
		"aud": "wacommerce-app",
		"exp": time.Now().Add(5 * time.Minute).Unix(),
	})
	if code := doGet(t, gw.URL, rightAud); code != http.StatusOK {
		t.Fatalf("right-audience token: got %d, want 200", code)
	}
}

func TestKeycloakJWTAuth_RejectsWrongKey(t *testing.T) {
	jwks, _, kid := newTestJWKS(t)
	issuer := jwks.URL
	gw := newTestGateway(t, jwks.URL, issuer, "")

	other, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	tok := signToken(t, other, kid, jwt.MapClaims{
		"sub": "user-1",
		"iss": issuer + "/realms/wacommerce",
		"exp": time.Now().Add(5 * time.Minute).Unix(),
	})
	if code := doGet(t, gw.URL, tok); code != http.StatusUnauthorized {
		t.Fatalf("wrong-key token: got %d, want 401", code)
	}
}

// Expired tokens must be rejected even under concurrent load; valid tokens
// must keep verifying against the shared (concurrently-refreshed) JWKS cache.
func TestKeycloakJWTAuth_ConcurrentExpiryEnforcement(t *testing.T) {
	jwks, priv, kid := newTestJWKS(t)
	issuer := jwks.URL
	gw := newTestGateway(t, jwks.URL, issuer, "")

	expired := signToken(t, priv, kid, jwt.MapClaims{
		"sub": "user-1",
		"iss": issuer + "/realms/wacommerce",
		"exp": time.Now().Add(-time.Minute).Unix(),
	})
	valid := signToken(t, priv, kid, jwt.MapClaims{
		"sub": "user-1",
		"iss": issuer + "/realms/wacommerce",
		"exp": time.Now().Add(5 * time.Minute).Unix(),
	})

	const workers = 64
	var wg sync.WaitGroup
	errCh := make(chan string, workers*2)
	for i := 0; i < workers; i++ {
		wg.Add(2)
		go func() {
			defer wg.Done()
			if code := doGet(t, gw.URL, expired); code != http.StatusUnauthorized {
				errCh <- "expired token accepted under load"
			}
		}()
		go func() {
			defer wg.Done()
			if code := doGet(t, gw.URL, valid); code != http.StatusOK {
				errCh <- "valid token rejected under load"
			}
		}()
	}
	wg.Wait()
	close(errCh)
	for msg := range errCh {
		t.Fatal(msg)
	}
}

// The JWKS cache TTL must be ≤ 10 minutes so revoked/rotated keys propagate
// quickly (documented in docs/SECURITY_AUDIT.md).
func TestJWKSCacheTTL(t *testing.T) {
	if globalJWKSCache.ttl > 10*time.Minute {
		t.Fatalf("JWKS cache TTL %v exceeds 10 minutes", globalJWKSCache.ttl)
	}
}
