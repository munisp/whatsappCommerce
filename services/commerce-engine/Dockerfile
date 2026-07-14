FROM golang:1.23-alpine AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /commerce-engine ./cmd/main.go

FROM gcr.io/distroless/static-debian12
COPY --from=builder /commerce-engine /commerce-engine
EXPOSE 8083
ENTRYPOINT ["/commerce-engine"]

