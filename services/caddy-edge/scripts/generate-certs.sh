#!/usr/bin/env bash
# =============================================================================
# generate-certs.sh — Generate internal PKI certificates for development
# =============================================================================
# In production, Caddy's built-in ACME CA handles cert issuance automatically.
# This script generates self-signed certs for LOCAL DEVELOPMENT ONLY.
#
# Usage: ./scripts/generate-certs.sh
# =============================================================================
set -euo pipefail

CERTS_DIR="$(dirname "$0")/../certs"
mkdir -p "$CERTS_DIR"

echo "==> Generating internal CA..."
openssl genrsa -out "$CERTS_DIR/internal-ca.key" 4096
openssl req -new -x509 -days 3650 -key "$CERTS_DIR/internal-ca.key" \
    -out "$CERTS_DIR/internal-ca.crt" \
    -subj "/CN=WhatsApp Commerce Internal CA/O=WhatsApp Commerce/C=NG"

echo "==> Generating Caddy client cert (for mTLS to APISIX)..."
openssl genrsa -out "$CERTS_DIR/caddy-client.key" 2048
openssl req -new -key "$CERTS_DIR/caddy-client.key" \
    -out "$CERTS_DIR/caddy-client.csr" \
    -subj "/CN=caddy-edge/O=WhatsApp Commerce/C=NG"
openssl x509 -req -days 365 -in "$CERTS_DIR/caddy-client.csr" \
    -CA "$CERTS_DIR/internal-ca.crt" -CAkey "$CERTS_DIR/internal-ca.key" \
    -CAcreateserial -out "$CERTS_DIR/caddy-client.crt"

echo "==> Generating Keycloak server cert..."
openssl genrsa -out "$CERTS_DIR/keycloak.key" 2048
openssl req -new -key "$CERTS_DIR/keycloak.key" \
    -out "$CERTS_DIR/keycloak.csr" \
    -subj "/CN=keycloak/O=WhatsApp Commerce/C=NG"
cat > "$CERTS_DIR/keycloak-san.ext" << 'EXTEOF'
subjectAltName=DNS:keycloak,DNS:auth.whatsapp-commerce.example.com,DNS:localhost
EXTEOF
openssl x509 -req -days 365 -in "$CERTS_DIR/keycloak.csr" \
    -CA "$CERTS_DIR/internal-ca.crt" -CAkey "$CERTS_DIR/internal-ca.key" \
    -CAcreateserial -out "$CERTS_DIR/keycloak.crt" \
    -extfile "$CERTS_DIR/keycloak-san.ext"

echo "==> Generating APISIX server cert..."
openssl genrsa -out "$CERTS_DIR/apisix.key" 2048
openssl req -new -key "$CERTS_DIR/apisix.key" \
    -out "$CERTS_DIR/apisix.csr" \
    -subj "/CN=apisix/O=WhatsApp Commerce/C=NG"
cat > "$CERTS_DIR/apisix-san.ext" << 'EXTEOF'
subjectAltName=DNS:apisix,DNS:api.whatsapp-commerce.example.com,DNS:localhost
EXTEOF
openssl x509 -req -days 365 -in "$CERTS_DIR/apisix.csr" \
    -CA "$CERTS_DIR/internal-ca.crt" -CAkey "$CERTS_DIR/internal-ca.key" \
    -CAcreateserial -out "$CERTS_DIR/apisix.crt" \
    -extfile "$CERTS_DIR/apisix-san.ext"

# Cleanup CSR files
rm -f "$CERTS_DIR"/*.csr "$CERTS_DIR"/*.ext "$CERTS_DIR"/*.srl

echo ""
echo "==> Certificates generated in $CERTS_DIR:"
ls -lh "$CERTS_DIR"
echo ""
echo "==> IMPORTANT: These are development certs only."
echo "    In production, Caddy's internal ACME CA issues certs automatically."
echo "    Set ACME_CA_URL=https://<caddy-host>:2019/acme/local/directory in each service."
