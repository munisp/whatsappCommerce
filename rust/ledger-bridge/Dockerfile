FROM rust:1.82-slim AS builder
RUN apt-get update && apt-get install -y libssl-dev pkg-config && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# === W35 fix: nonexistent Cargo.lock COPY removed === (cargo generates it at build)
COPY Cargo.toml ./
RUN mkdir src && echo "fn main() {}" > src/main.rs && cargo build --release && rm -rf src
COPY src ./src
RUN touch src/main.rs && cargo build --release

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y ca-certificates libssl3 && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/target/release/ledger-bridge /ledger-bridge
EXPOSE 8095
ENTRYPOINT ["/ledger-bridge"]

