# =============================================================================
# Kassa – Frontend  (Multi-Stage Build → nginx)
# Build-Kontext: Repo-Wurzel  (docker build -f packages/frontend/Dockerfile .)
# =============================================================================

# ── Basis-Image ───────────────────────────────────────────────────────────────
FROM node:22-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

# ── Abhängigkeiten installieren ───────────────────────────────────────────────
FROM base AS deps
WORKDIR /app

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/shared/package.json    ./packages/shared/
COPY packages/frontend/package.json  ./packages/frontend/
# Vendored xlsx-Tarball (file:-Dependency) muss vor dem Install vorhanden sein
COPY packages/frontend/vendor        ./packages/frontend/vendor

RUN pnpm install --frozen-lockfile

# ── Bauen ─────────────────────────────────────────────────────────────────────
FROM deps AS builder
WORKDIR /app

COPY tsconfig.base.json  ./
COPY packages/shared     ./packages/shared
COPY packages/frontend   ./packages/frontend

# shared zuerst bauen (frontend importiert Typen und Schemas daraus)
RUN pnpm --filter @kassa/shared   build && \
    pnpm --filter @kassa/frontend build

# ── Runtime: nginx ────────────────────────────────────────────────────────────
FROM nginx:1.27-alpine AS runtime

# Statische Dateien aus dem Build-Schritt
COPY --from=builder /app/packages/frontend/dist /usr/share/nginx/html

# nginx-Konfiguration (API-Proxy + React-Router-Fallback)
COPY packages/frontend/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

# nginx läuft standardmäßig als root im offiziellen Image — das ist in Ordnung,
# da nginx intern auf den worker-Benutzer wechselt.
CMD ["nginx", "-g", "daemon off;"]
