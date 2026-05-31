FROM node:22-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

FROM base AS deps
WORKDIR /app
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/kundendisplay/package.json ./packages/kundendisplay/
RUN pnpm install --frozen-lockfile

FROM deps AS builder
WORKDIR /app
COPY tsconfig.base.json ./
COPY packages/kundendisplay ./packages/kundendisplay
RUN pnpm --filter @kassa/kundendisplay build

FROM nginx:1.27-alpine AS runtime
COPY --from=builder /app/packages/kundendisplay/dist /usr/share/nginx/html
COPY packages/kundendisplay/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
