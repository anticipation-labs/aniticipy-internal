# Canopy on Railway.
#
# The app is written for Cloudflare Workers; server/ adapts it to Node (see
# server/d1.ts for the database seam). The build produces a single self-contained
# bundle, so the runtime stage carries no node_modules at all — only the bundle,
# the built web assets and the SQL migrations it applies at boot.
#
# Node 24 is required, not merely preferred: the database driver is the built-in
# node:sqlite module, which is where the FTS5 support Canopy's search depends on
# comes from.

# ── build ────────────────────────────────────────────────────────────────────
FROM node:24-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
# esbuild's postinstall links its platform binary; the build cannot run without
# it. Scripts stay blocked for every other dependency.
RUN npm ci --allow-scripts esbuild

COPY tsconfig*.json vitest.config.ts ./
COPY shared ./shared
COPY src ./src
COPY server ./server
COPY web ./web
COPY scripts ./scripts
COPY migrations ./migrations

RUN npm run build:node

# ── runtime ──────────────────────────────────────────────────────────────────
FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/dist-server ./dist-server
COPY --from=build /app/web/dist ./web/dist
COPY --from=build /app/migrations ./migrations

# The database lives on the Railway volume mounted here, not on the container
# filesystem, which is replaced on every deploy. The mount is declared in
# Railway (a volume attached to this service at /data), not with a Docker
# VOLUME instruction — the builder rejects those outright.
ENV DATA_DIR=/data

# Railway injects PORT; this default only matters when running the image locally.
ENV PORT=8080
EXPOSE 8080

# The entrypoint fixes ownership of the mounted volume and then drops to the
# unprivileged `node` user. It runs as root only long enough to do that.
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
