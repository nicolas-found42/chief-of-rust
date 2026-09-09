# Walking-skeleton prototype (issue #2): cargo-chef three-stage build per the
# stack survey (#3). The planner/builder split caches dependency compilation,
# so source-only changes recompile just the app crate. The builder needs cmake
# for aws-lc-sys (rig-core's rustls default crypto provider).
FROM lukemathwalker/cargo-chef:latest-rust-1.98.0-trixie AS chef
WORKDIR /app

FROM chef AS planner
COPY . .
RUN cargo chef prepare --recipe-path recipe.json

FROM chef AS builder
RUN apt-get update && apt-get install -y --no-install-recommends cmake \
  && rm -rf /var/lib/apt/lists/*
COPY --from=planner /app/recipe.json recipe.json
RUN cargo chef cook --release --recipe-path recipe.json
COPY . .
RUN cargo build --release --locked

FROM debian:trixie-slim AS runtime
# curl serves the healthcheck; ca-certificates serves the rustls native-roots
# TLS used by the LLM and Google calls.
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/target/release/chief-of-rust /usr/local/bin/chief-of-rust
RUN useradd --system --home-dir /nonexistent app
USER app
EXPOSE 4317
CMD ["chief-of-rust"]
