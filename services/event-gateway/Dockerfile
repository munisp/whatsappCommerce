FROM golang:1.23-alpine AS builder
WORKDIR /app
COPY go.mod ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o gateway .

FROM gcr.io/distroless/static-debian12
COPY --from=builder /app/gateway /gateway
EXPOSE 8002
ENTRYPOINT ["/gateway"]

