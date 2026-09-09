# Minimal opaque relay — ADR-0031, issue://80 + issue://81
FROM node:22.18.0-bookworm-slim AS build
WORKDIR /app
# The bundled Corepack expects pnpm's old JS layout; pnpm 12 ships native launchers.
RUN npm install --global pnpm@12.3.4

# Resolve the same locked workspace graph that the test and typecheck gates use.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY tests/package.json tests/
COPY relay/package.json relay/
RUN pnpm install --frozen-lockfile --filter @chief-of-staff-demo/relay...

COPY tsconfig.base.json ./
COPY relay/src relay/src
COPY relay/tsconfig.json relay/
RUN pnpm --filter @chief-of-staff-demo/relay build \
  && pnpm --filter @chief-of-staff-demo/relay deploy --legacy --prod /out

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=4318 \
    HOST=0.0.0.0
COPY --from=build /out ./
EXPOSE 4318
# The relay is the piece meant for public hosting, so it must not run as root.
# `node` (UID/GID 1000) ships in the base image; relay state is in memory and
# nothing under /app is written at runtime, so no ownership change is needed.
USER node
HEALTHCHECK --interval=30s --timeout=3s --retries=3 CMD node -e "fetch('http://127.0.0.1:4318/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
