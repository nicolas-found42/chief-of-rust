# Build the Rust workspace, then copy the release binary into a clean runtime
# image. The stub (issue #8) has no dependencies; this file grows when the web
# framework lands.
FROM rust:1.98-slim-bookworm AS build
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY crates crates
RUN cargo build --release --locked

FROM debian:bookworm-slim
COPY --from=build /app/target/release/chief-of-rust /usr/local/bin/chief-of-rust
# Non-root: the image runs only this binary, and nothing in it needs to write.
RUN useradd --system --home-dir /nonexistent app
USER app
CMD ["chief-of-rust"]
