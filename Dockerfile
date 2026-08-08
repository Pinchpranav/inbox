# ── build stage ────────────────────────────────────────────────────────────
# Debian-based Node 24 (not alpine). Builds the Vite app.
FROM node:24-bookworm AS build
WORKDIR /app

# pnpm — the lockfile is v9.0, so use pnpm 9.
RUN npm install -g pnpm@9

# Install deps first for layer caching.
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Copy sources + the committed .env.production (sets VITE_GATEWAY_URL=/gw so the
# bundle targets the same-origin /gw reverse proxy).
COPY . .
RUN pnpm build

# ── serve stage ───────────────────────────────────────────────────────────
# Debian-based nginx (not alpine). Serves the built SPA at / and reverse-proxies
# /gw/ (REST + WebSocket) to the openclaw gateway container on the docker network.
FROM nginx:stable
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80