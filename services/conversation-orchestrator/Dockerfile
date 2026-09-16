FROM golang:1.23-alpine AS builder
WORKDIR /app
# Root build context (docker-compose.yml's W35 comment): the go.mod
# `replace github.com/whatsapp-commerce/otelx => ../../shared/go/otelx`
# escapes a self-contained per-service context, so shared/go/otelx must be
# present in the build alongside this service's own source.
COPY shared/go/otelx ./shared/go/otelx
COPY services/conversation-orchestrator/go.mod services/conversation-orchestrator/go.sum ./services/conversation-orchestrator/
WORKDIR /app/services/conversation-orchestrator
RUN go mod download
COPY services/conversation-orchestrator/. .
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /conversation-orchestrator ./cmd/main.go

FROM gcr.io/distroless/static-debian12
COPY --from=builder /conversation-orchestrator /conversation-orchestrator
EXPOSE 8082
ENTRYPOINT ["/conversation-orchestrator"]
