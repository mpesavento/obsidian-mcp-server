# ---- Stage 1: Build ----
FROM node:24-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ---- Stage 2: Production ----
FROM node:24-alpine

# ripgrep for fast vault search; git for vault clone/sync
RUN apk add --no-cache ripgrep git ca-certificates

USER node
WORKDIR /app

COPY --from=builder --chown=node:node /app/package.json /app/package-lock.json ./
RUN npm ci --omit=dev

COPY --from=builder --chown=node:node /app/dist/ ./dist/
COPY --chown=node:node docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

# Cloud Run injects PORT (default 8080); app config respects it
ENV PORT=3100
EXPOSE 3100

ENTRYPOINT ["./docker-entrypoint.sh"]
