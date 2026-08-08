// keycloak_bench_test.go — benchmarks for Keycloak RS256 JWT validation.
//
// The validation path is RS256-dominated: RSA-2048 signature verification
// costs ~80µs/op, dwarfing JSON parsing and claims checks.
//
// Caveat: rsa.GenerateKey with >= 2048-bit modulus is slow (~100-500ms), so the
// key is generated ONCE outside the benchmark loop. Never generate keys inside
// b.Run — it would measure keygen, not validation.
package middleware

import (
	"crypto/rand"
	"crypto/rsa"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
	"github.com/whatsapp-commerce/gateway/internal/config"
	"go.uber.org/zap"
)

// benchRSAKey is a 2048-bit key generated lazily, once per test binary.
var benchRSAKey *rsa.PrivateKey

func getBenchKey(b testing.TB) *rsa.PrivateKey {
	if benchRSAKey != nil {
		return benchRSAKey
	}
	// 2048-bit minimum — anything smaller is rejected by policy and by
	// jwt/v5's signing method constraints in hardened deployments.
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		b.Fatalf("generate RSA key: %v", err)
	}
	benchRSAKey = key
	return key
}

func benchToken(b testing.TB, key *rsa.PrivateKey, issuer string) string {
	claims := &KeycloakClaims{
		Sub:               "kc-user-bench",
		PreferredUsername: "bench",
		Email:             "bench@example.com",
		RealmRoles:        []string{"user"},
		TenantID:          "tenant-bench",
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    issuer,
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(5 * time.Minute)),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
		},
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
	tok.Header["kid"] = "bench-key"
	signed, err := tok.SignedString(key)
	if err != nil {
		b.Fatalf("sign token: %v", err)
	}
	return signed
}

// BenchmarkKeycloakJWTValidate measures raw RS256 parse+verify cost against a
// pre-resolved public key (the JWKS cache hot path).
func BenchmarkKeycloakJWTValidate(b *testing.B) {
	key := getBenchKey(b)
	issuer := "http://localhost:8080/realms/wacommerce"
	tokenStr := benchToken(b, key, issuer)
	pub := &key.PublicKey

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		claims := &KeycloakClaims{}
		tok, err := jwt.ParseWithClaims(tokenStr, claims, func(t *jwt.Token) (interface{}, error) {
			return pub, nil
		},
			jwt.WithValidMethods([]string{"RS256"}),
			jwt.WithIssuer(issuer),
			jwt.WithExpirationRequired(),
		)
		if err != nil || !tok.Valid {
			b.Fatalf("validation failed: %v", err)
		}
	}
}

// BenchmarkKeycloakMiddleware measures the full gin middleware path
// (header extraction, JWKS cache hit, RS256 verify, context injection).
func BenchmarkKeycloakMiddleware(b *testing.B) {
	key := getBenchKey(b)
	issuer := "http://localhost:8080/realms/wacommerce"
	tokenStr := benchToken(b, key, issuer)

	// Seed the global JWKS cache so the middleware takes the hot path.
	globalJWKSCache.mu.Lock()
	globalJWKSCache.keys["bench-key"] = &key.PublicKey
	globalJWKSCache.fetchedAt = time.Now()
	globalJWKSCache.mu.Unlock()

	cfg := &config.Config{}
	cfg.Keycloak.URL = "http://localhost:8080"
	cfg.Keycloak.Realm = "wacommerce"
	cfg.Keycloak.JWKSEndpoint = "http://localhost:8080/realms/wacommerce/protocol/openid-connect/certs"
	logger := zap.NewNop()

	gin.SetMode(gin.TestMode)
	handler := KeycloakJWTAuth(cfg, logger)

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		w := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(w)
		c.Request = httptest.NewRequest(http.MethodGet, "/v1/bench", nil)
		c.Request.Header.Set("Authorization", "Bearer "+tokenStr)
		handler(c)
		if w.Code == http.StatusUnauthorized {
			b.Fatalf("middleware rejected valid token: %s", w.Body.String())
		}
	}
}
