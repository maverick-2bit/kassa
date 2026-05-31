# =============================================================================
# Kassa – KDS  (Multi-Stage Build → nginx)
# Build-Kontext: Repo-Wurzel  (docker build -f packages/kds/Dockerfile .)
# =============================================================================

FROM node:22-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

FROM base AS deps
WORKDIR /app

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/kds/package.json    ./packages/kds/

RUN pnpm install --frozen-lockfile

FROM deps AS builder
WORKDIR /app

COPY tsconfig.base.json ./
COPY packages/shared    ./packages/shared
COPY packages/kds       ./packages/kds

RUN pnpm --filter @kassa/shared build && \
    pnpm --filter @kassa/kds    build

FROM nginx:1.27-alpine AS runtime

COPY --from=builder /app/packages/kds/dist /usr/share/nginx/html
COPY packages/kds/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
