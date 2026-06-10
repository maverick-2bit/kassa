FROM node:22-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

FROM base AS deps
WORKDIR /app
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/shared/package.json  ./packages/shared/
COPY packages/kellner/package.json ./packages/kellner/
RUN pnpm install --frozen-lockfile

FROM deps AS builder
WORKDIR /app
COPY packages/shared  ./packages/shared
COPY packages/kellner ./packages/kellner
RUN pnpm --filter @kassa/kellner build

FROM nginx:1.27-alpine AS runtime
COPY --from=builder /app/packages/kellner/dist /usr/share/nginx/html
COPY packages/kellner/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
