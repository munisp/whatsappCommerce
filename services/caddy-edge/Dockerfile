# Stage 1: Build custom Caddy binary with required modules
FROM caddy:2.9-builder AS builder

# Build Caddy with:
#   - caddy-l4: Layer 4 TCP/UDP proxy for non-HTTP services
#   - coraza-caddy: OWASP Coraza WAF integration
#   - caddy-security: OAuth2/OIDC middleware (Keycloak integration)
RUN xcaddy build \
    --with github.com/mholt/caddy-l4 \
    --with github.com/corazawaf/coraza-caddy/v2 \
    --with github.com/greenpau/caddy-security

# Stage 2: Production image
FROM caddy:2.9-alpine

# Copy custom binary
COPY --from=builder /usr/bin/caddy /usr/bin/caddy

# Copy Caddyfile and WAF rules
COPY config/Caddyfile /etc/caddy/Caddyfile
COPY config/coraza.conf /etc/caddy/coraza.conf
COPY config/crs-setup.conf /etc/caddy/crs-setup.conf

# Create directories for TLS data and logs
RUN mkdir -p /data/caddy /config/caddy /var/log/caddy

EXPOSE 80 443 443/udp 2019

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://localhost:2019/metrics || exit 1

CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
