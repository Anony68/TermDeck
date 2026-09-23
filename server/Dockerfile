# Build the sync server, then ship a slim runtime image.
FROM rust:1-bookworm AS build
WORKDIR /app
COPY . .
RUN cargo build --release --locked || cargo build --release

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/target/release/termdeck-sync-server /usr/local/bin/termdeck-sync-server
ENV BIND_ADDR=0.0.0.0:8787
EXPOSE 8787
CMD ["termdeck-sync-server"]
