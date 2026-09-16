FROM golang:1.23-alpine AS builder
WORKDIR /app
# Root build context (docker-compose.yml's W35 comment): the go.mod
# `replace github.com/whatsapp-commerce/otelx => ../../shared/go/otelx`
# escapes a self-contained per-service context, so shared/go/otelx must be
# present in the build alongside this service's own source.
COPY shared/go/otelx ./shared/go/otelx
COPY services/gateway/go.mod services/gateway/go.sum ./services/gateway/
WORKDIR /app/services/gateway
RUN go mod download
COPY services/gateway/. .
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /gateway ./cmd/main.go

FROM gcr.io/distroless/static-debian12
COPY --from=builder /gateway /gateway
EXPOSE 8080
ENTRYPOINT ["/gateway"]
