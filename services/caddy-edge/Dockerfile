# syntax=docker/dockerfile:1
FROM caddy:2-builder AS builder
RUN xcaddy build \
    --with github.com/corazawaf/coraza-caddy/v2 \
    --with github.com/mholt/caddy-l4 \
    --with github.com/greenpau/caddy-security \
    --with github.com/caddy-dns/cloudflare

FROM caddy:2-alpine
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
COPY config/coraza/ /etc/caddy/coraza/
COPY Caddyfile /etc/caddy/Caddyfile
VOLUME ["/data"]
VOLUME ["/config"]
EXPOSE 80 443 443/udp 8443
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://localhost:2019/config/ || exit 1
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
