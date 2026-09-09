# Build server + web, drop dev dependencies, then copy the result into a clean
# runtime image. One image: Node serves the API and the built web UI.
FROM node:22.18.0-bookworm-slim AS build
WORKDIR /app

# pnpm is the workspace manager (pnpm-lock.yaml); pin the version the dev loop
# uses so the image resolves the same tree.
# The bundled Corepack expects pnpm's old JS layout; pnpm 12 ships native launchers.
RUN npm install --global pnpm@12.3.4

# Manifests first, so `pnpm install` is only re-run when dependencies change.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY tests/package.json tests/
RUN pnpm install --frozen-lockfile

COPY tsconfig.base.json tsconfig.json ./
COPY packages/shared packages/shared
COPY apps/server apps/server
COPY apps/web apps/web
# pnpm 11 cannot prune this workspace: the hoisted top-level links (including
# the @chief-of-staff-demo/shared workspace link) do not survive a prune, and
# the runtime would fail to resolve the shared package. Drop the dev tree and
# reinstall production dependencies from the lockfile instead; CI=true because
# the install purges node_modules and the build stage has no TTY.
RUN pnpm run build \
  && rm -rf node_modules \
  && CI=true pnpm install --prod --frozen-lockfile

FROM debian:bookworm-slim AS whisper-build
ARG WHISPER_CPP_VERSION=v1.7.6
ARG WHISPER_CPP_SHA256=166140e9a6d8a36f787a2bd77f8f44dd64874f12dd8359ff7c1f4f9acb86202e
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates cmake curl g++ git make \
  && curl -fsSL "https://github.com/ggml-org/whisper.cpp/archive/refs/tags/${WHISPER_CPP_VERSION}.tar.gz" -o /tmp/whisper.cpp.tar.gz \
  && echo "${WHISPER_CPP_SHA256}  /tmp/whisper.cpp.tar.gz" | sha256sum --check - \
  && tar -xzf /tmp/whisper.cpp.tar.gz -C /tmp \
  && cmake -S "/tmp/whisper.cpp-${WHISPER_CPP_VERSION#v}" -B /tmp/whisper-build \
  -DCMAKE_BUILD_TYPE=Release \
  -DBUILD_SHARED_LIBS=OFF \
  -DGGML_NATIVE=OFF \
  -DWHISPER_BUILD_EXAMPLES=ON \
  -DWHISPER_BUILD_TESTS=OFF \
  -DWHISPER_BUILD_SERVER=OFF \
  && cmake --build /tmp/whisper-build --config Release --target whisper-cli --parallel 2

# This release tag pins Playwright's Chromium revision and its system libraries.
FROM mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27 AS runtime
ARG YT_DLP_VERSION=2025.08.22
ARG YOUTUBE_TRANSCRIPT_API_VERSION=1.2.2
ARG INSTALOADER_VERSION=4.14.2
ARG PYTHON_VERSION=3.12.3-0ubuntu2.1
ARG FFMPEG_VERSION=7:6.1.1-3ubuntu5
ARG WHISPER_CPP_VERSION=v1.7.6
WORKDIR /app
# HOST=0.0.0.0 because the loopback interface inside a container is not
# reachable from the host; the host-side binding stays on 127.0.0.1 (compose).
ENV NODE_ENV=production \
  PORT=4317 \
  HOST=0.0.0.0 \
  WORKSPACE_DIR=/app/workspace \
  PATH=/opt/content-scout-python/bin:$PATH

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
  "ffmpeg=${FFMPEG_VERSION}" \
  "python3=${PYTHON_VERSION}" \
  "python3-venv=${PYTHON_VERSION}" \
  && python3 -m venv /opt/content-scout-python \
  && /opt/content-scout-python/bin/pip install --no-cache-dir \
  "instaloader==${INSTALOADER_VERSION}" \
  "youtube-transcript-api==${YOUTUBE_TRANSCRIPT_API_VERSION}" \
  "yt-dlp==${YT_DLP_VERSION}" \
  && chromium_path="$(find /ms-playwright -type f \( -path '*/chrome-linux/chrome' -o -path '*/chrome-linux64/chrome' -o -path '*/chrome-linux-arm64/chrome' \) | head -n 1)" \
  && test -n "$chromium_path" \
  && ln -s "$chromium_path" /usr/local/bin/chromium \
  && rm -rf /var/lib/apt/lists/*

COPY --from=whisper-build /tmp/whisper-build/bin/whisper-cli /usr/local/bin/whisper-cli
RUN mkdir -p /usr/local/share/content-scout \
  && printf '%s\n' "${WHISPER_CPP_VERSION}" > /usr/local/share/content-scout/whisper-cpp-version

COPY --from=build /app/package.json /app/pnpm-lock.yaml ./
COPY --from=build /app/node_modules node_modules
# pnpm links each importer's dependencies inside that importer's own
# node_modules (the workspace link to packages/shared lives in
# apps/server/node_modules), so the runtime needs the consumers' trees too.
COPY --from=build /app/apps/server/node_modules apps/server/node_modules
COPY --from=build /app/packages/shared/node_modules packages/shared/node_modules
COPY --from=build /app/packages/shared/package.json packages/shared/
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/apps/server/package.json apps/server/
COPY --from=build /app/apps/server/dist apps/server/dist
COPY --from=build /app/apps/web/dist apps/web/dist

# Hermetic runtime smoke checks: command boundaries only, with no social-network calls.
RUN chromium --version \
  | grep -F "153.0.8010.12" \
  && printf '%s\n' '<!doctype html><html><body><h1>browser-render-probe</h1></body></html>' > /tmp/browser-render-probe.html \
  && chromium --headless --no-sandbox --disable-gpu --dump-dom "file:///tmp/browser-render-probe.html" 2>/dev/null | grep -F "browser-render-probe" \
  && rm -f /tmp/browser-render-probe.html \
  && python3 --version | grep -F "3.12.3" \
  && python3 -c "import importlib.metadata; print(importlib.metadata.version('youtube-transcript-api'))" | grep -Fx "${YOUTUBE_TRANSCRIPT_API_VERSION}" \
  && instaloader --version | grep -F "${INSTALOADER_VERSION}" \
  && ffmpeg -version 2>&1 | head -n 1 | grep -F "6.1.1-3ubuntu5" \
  && yt-dlp --version | grep -Fx "${YT_DLP_VERSION}" \
  && whisper-cli --help >/dev/null

# Runs and secrets live in the mounted workspace, never in a layer.
RUN mkdir -p /app/workspace && chown -R pwuser:pwuser /app/workspace
USER pwuser
VOLUME ["/app/workspace"]
EXPOSE 4317
CMD ["node", "apps/server/dist/main.js"]
