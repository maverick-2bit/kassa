FROM node:22-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

FROM base AS deps
WORKDIR /app
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/gast/package.json ./packages/gast/
RUN pnpm install --frozen-lockfile

FROM deps AS builder
WORKDIR /app
COPY packages/gast ./packages/gast
RUN pnpm --filter @kassa/gast build

FROM nginx:1.27-alpine AS runtime
COPY --from=builder /app/packages/gast/dist /usr/share/nginx/html
COPY packages/gast/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
