# ── Stage 1: build the frontend SPA bundle ──────────────────────────────────
FROM node:20-alpine AS frontend-build
WORKDIR /app
COPY package*.json ./
# Build-time only — won't end up in the final image
RUN npm ci --no-audit --no-fund
COPY vite.config.js index.html ./
COPY src ./src
# Pass VITE_* envs in at build time via --build-arg if you need to bake a
# remote API base into the bundle (e.g. when SPA and API live on diff origins).
ARG VITE_API_BASE=""
ARG VITE_SENTRY_DSN=""
ARG VITE_SENTRY_RELEASE=""
ENV VITE_API_BASE=$VITE_API_BASE \
    VITE_SENTRY_DSN=$VITE_SENTRY_DSN \
    VITE_SENTRY_RELEASE=$VITE_SENTRY_RELEASE
RUN npm run build

# ── Stage 2: production server image ────────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app

# better-sqlite3 needs build toolchain at install time. Install, build, then
# wipe the toolchain so the runtime image stays small.
RUN apk add --no-cache --virtual .build-deps python3 make g++ \
 && apk add --no-cache tini

COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
 && apk del .build-deps

# Server source
COPY server ./server

# Static SPA from stage 1 — served by Express via express.static (optional).
# If you serve the SPA from a separate origin (S3+CloudFront), you can drop
# this COPY and keep the image even smaller.
COPY --from=frontend-build /app/dist ./dist

# Persistent volumes:
#   /data    SQLite db file lives here (mount EBS volume to this path)
#   /backups daily snapshots written here (point BACKUP_DIR at it)
VOLUME ["/data", "/backups"]
ENV DB_PATH=/data/knowl.db \
    BACKUP_DIR=/backups \
    PORT=3001 \
    NODE_ENV=production

EXPOSE 3001

# tini reaps zombie children + forwards SIGTERM cleanly so cron jobs and
# DB connections shut down without corruption.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server/index.js"]
