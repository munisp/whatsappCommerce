FROM rust:1.83-alpine AS builder
RUN apk add --no-cache musl-dev
WORKDIR /app
COPY Cargo.toml Cargo.lock* ./
RUN mkdir src && echo "fn main(){}" > src/main.rs && cargo build --release
COPY src ./src
RUN touch src/main.rs && cargo build --release

FROM gcr.io/distroless/static-debian12
COPY --from=builder /app/target/release/message-processor /message-processor
EXPOSE 8003
ENTRYPOINT ["/message-processor"]

