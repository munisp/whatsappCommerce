FROM golang:1.23-alpine AS builder
WORKDIR /app
# Root build context (docker-compose.yml's W35 comment): the go.mod
# `replace github.com/whatsapp-commerce/otelx => ../../shared/go/otelx`
# escapes a self-contained per-service context, so shared/go/otelx must be
# present in the build alongside this service's own source.
COPY shared/go/otelx ./shared/go/otelx
COPY services/commerce-engine/go.mod services/commerce-engine/go.sum ./services/commerce-engine/
WORKDIR /app/services/commerce-engine
RUN go mod download
COPY services/commerce-engine/. .
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /commerce-engine ./cmd/main.go

FROM gcr.io/distroless/static-debian12
COPY --from=builder /commerce-engine /commerce-engine
EXPOSE 8083
ENTRYPOINT ["/commerce-engine"]
