ARG NODE_IMAGE=node:22.21.1-bookworm-slim@sha256:25b3eb23a00590b7499f2a2ce939322727fcce1b15fdd69754fcd09536a3ae2c

FROM ${NODE_IMAGE} AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

FROM base AS dependencies
COPY package.json package-lock.json ./
RUN npm ci

FROM base AS builder
COPY --from=dependencies /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM ${NODE_IMAGE} AS runner
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3100 \
    CRM_DATABASE_PATH=/data/relationships.db \
    CRM_BACKUP_DIRECTORY=/data/backups \
    CRM_AUTOMATIC_BACKUP_INTERVAL_HOURS=24 \
    CRM_SESSION_TTL_HOURS=168 \
    CRM_LOG_LEVEL=info \
    SEED_DEMO_DATA=false

COPY --from=builder --chown=node:node /app/.next/standalone ./

RUN mkdir -p /data /app/.next/cache \
  && chown -R node:node /data /app/.next/cache \
  && chmod 700 /data

USER node
EXPOSE 3100
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3100/api/health/ready').then(response => { if (!response.ok) process.exit(1) }).catch(() => process.exit(1))"]

CMD ["node", "server.js"]
