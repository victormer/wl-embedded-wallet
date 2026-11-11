# Built from the monorepo root:
#   docker build -f apps/vault/Dockerfile -t wl-embedded-wallet-vault:local .
# The image carries no configuration: all of it is passed at startup (see docs/DEPLOYMENT.md#environment-variables).
FROM node:22-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d AS build
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm install --global pnpm@10.5.1
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile --filter "@wl-embedded-wallet/vault..."
RUN pnpm --filter "@wl-embedded-wallet/vault" build
# The macOS `sodium-native` binaries are of no use here.
RUN find apps/vault/.next/standalone -type d -path '*/sodium-native/prebuilds/darwin-*' -prune -exec rm -rf {} +

FROM node:22-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d AS runtime
LABEL org.opencontainers.image.title="wl-embedded-wallet-vault" \
      org.opencontainers.image.licenses="Apache-2.0"
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000
WORKDIR /app/apps/vault
COPY --from=build --chown=node:node /repo/apps/vault/.next/standalone/ /app/
COPY --from=build --chown=node:node /repo/apps/vault/.next/static/ /app/apps/vault/.next/static/
COPY --from=build --chown=node:node /repo/scripts/generate-secrets.mjs /app/apps/vault/scripts/generate-secrets.mjs
# Gives route handlers the socket address, which the startup check requires in production.
COPY --from=build --chown=node:node /repo/apps/vault/scripts/peer-address.cjs /app/apps/vault/peer-address.cjs
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "--require", "./peer-address.cjs", "server.js"]
