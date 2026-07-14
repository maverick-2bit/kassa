# =============================================================================
# Kassa – Backend  (Multi-Stage Build)
# Build-Kontext: Repo-Wurzel  (docker build -f packages/backend/Dockerfile .)
# =============================================================================

# ── Basis-Image ───────────────────────────────────────────────────────────────
FROM node:22-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

# ── Abhängigkeiten installieren ───────────────────────────────────────────────
FROM base AS deps
WORKDIR /app

# Nur package.json-Dateien zuerst kopieren → besseres Layer-Caching
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/shared/package.json   ./packages/shared/
COPY packages/rksv/package.json     ./packages/rksv/
COPY packages/backend/package.json  ./packages/backend/

RUN pnpm install --frozen-lockfile

# ── Bauen ─────────────────────────────────────────────────────────────────────
FROM deps AS builder
WORKDIR /app

COPY tsconfig.base.json ./
COPY packages/shared    ./packages/shared
COPY packages/rksv      ./packages/rksv
COPY packages/backend   ./packages/backend

# Workspace-Pakete in Reihenfolge bauen
RUN pnpm --filter @kassa/shared  build && \
    pnpm --filter @kassa/rksv    build && \
    pnpm --filter @kassa/backend build

# Standalone-Deployment erstellen:
# pnpm deploy kopiert alle Produktions-Abhängigkeiten in ein flaches Verzeichnis
# (keine Symlinks mehr — ideal für Container)
RUN pnpm --filter @kassa/backend deploy --prod /standalone

# ── Runtime ───────────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /app

# postgresql-client für pg_dump (DB-Backups)
RUN apk add --no-cache postgresql-client

# Nur das Nötigste:  node_modules aus dem Deploy-Schritt …
COPY --from=builder /standalone/node_modules ./node_modules

# … gebauter Code …
COPY --from=builder /app/packages/backend/dist ./dist

# … Datenbank-Migrationen (werden beim Start automatisch eingespielt) …
COPY --from=builder /app/packages/backend/drizzle ./drizzle

# … und die package.json: health-/monitoring-Route lesen daraus zur Laufzeit
# die Version (require('../../package.json') relativ zu /app/dist/routes → /app)
COPY --from=builder /app/packages/backend/package.json ./package.json

# Nicht als root laufen
USER node

EXPOSE 3000

# Kein --env-file: Umgebungsvariablen kommen vom Container-Runtime (docker-compose / k8s)
CMD ["node", "dist/index.js"]
