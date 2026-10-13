# Cache dependencies independently of product code; TLS's aws-lc-sys
# crypto provider requires cmake in the builder.
FROM lukemathwalker/cargo-chef:latest-rust-1.98.0-trixie@sha256:d21902576546863995017609e991178939e6f151f6b35fb00f3c0fa97a616ef5 AS chef
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

FROM debian:trixie-slim@sha256:a29215f6a35e51e22adffa17f89e9d2ef06214e64a2bad10d765c46aea49f11f AS runtime
# curl serves the healthcheck; ca-certificates serves the rustls native-roots
# TLS used by the LLM and Google calls.
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/target/release/chief-of-rust /usr/local/bin/chief-of-rust
RUN groupadd --gid 1000 app && useradd --uid 1000 --gid app --home-dir /data app \
  && mkdir -p /data/workspace && chown -R app:app /data
USER 1000:1000
EXPOSE 5317
CMD ["chief-of-rust"]
