# =============================================================================
# Kassa – SB-Bestellterminal  (Multi-Stage Build → nginx)
# Build-Kontext: Repo-Wurzel  (docker build -f packages/terminal/Dockerfile .)
# =============================================================================

FROM node:22-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

FROM base AS deps
WORKDIR /app
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/terminal/package.json ./packages/terminal/
RUN pnpm install --frozen-lockfile

FROM deps AS builder
WORKDIR /app
COPY packages/terminal ./packages/terminal
RUN pnpm --filter @kassa/terminal build

FROM nginx:1.27-alpine AS runtime
COPY --from=builder /app/packages/terminal/dist /usr/share/nginx/html
COPY packages/terminal/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
