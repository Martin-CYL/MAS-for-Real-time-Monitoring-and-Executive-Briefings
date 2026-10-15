# syntax=docker/dockerfile:1
ARG BUN_VERSION=1.4.2
FROM oven/bun:${BUN_VERSION}-debian AS bun-runtime
FROM node:22.16.0-bookworm-slim AS base
COPY --from=bun-runtime /usr/local/bin/bun /usr/local/bin/bun
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git python3 curl ripgrep \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS build
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run check

FROM base AS production-deps
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM base AS runtime
ARG CODEX_VERSION=0.162.0-alpha.2
RUN npm install --global @openai/codex@${CODEX_VERSION} && npm cache clean --force \
    && groupadd --gid 10001 nex && useradd --uid 10001 --gid 10001 --create-home --shell /bin/bash nex \
    && mkdir -p /home/nex/.nex /home/nex/.codex /workspace/projects \
    && chown -R nex:nex /home/nex /workspace
COPY --from=production-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json LICENSE ./
ENV HOME=/home/nex CODEX_HOME=/home/nex/.codex NEX_RUNTIME_PROFILE=prod NODE_ENV=production
ENV NEX_DEFAULT_PROVIDER=codex
ENV NEX_PROJECTS_DIR=/workspace/projects
USER 10001:10001
EXPOSE 3210
STOPSIGNAL SIGTERM
CMD ["bun", "/app/dist/server/entry.js", "--host", "0.0.0.0", "--port", "3210", "--strict-port", "--no-open"]

# Account gateway contains no Codex CLI, agent workspace or Docker socket.
FROM bun-runtime AS gateway
WORKDIR /app
COPY --from=production-deps /app/node_modules ./node_modules
COPY src/server/gateway ./gateway
RUN mkdir -p /data && chown 10002:10002 /data
USER 10002:10002
ENV NEX_ACCOUNTS_DIR=/data HOST=0.0.0.0 PORT=3220
EXPOSE 3220
CMD ["bun", "/app/gateway/entry.ts"]

FROM runtime AS production
