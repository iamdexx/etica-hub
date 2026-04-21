# syntax=docker/dockerfile:1.6
# Reference keeper for the EticaHub trading stack.
# Keepers are public-good processes: anyone may run one; no privilege required.

FROM node:20-alpine AS build
WORKDIR /app

RUN corepack enable

# Copy workspace manifests first so installs cache.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/keeper/package.json ./apps/keeper/

RUN pnpm install --frozen-lockfile

COPY packages/shared ./packages/shared
COPY apps/keeper ./apps/keeper

RUN pnpm --filter @etica-hub/shared build \
 && pnpm --filter @etica-hub/keeper build

FROM node:20-alpine AS runtime
WORKDIR /app

RUN corepack enable
ENV NODE_ENV=production

COPY --from=build /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml ./
COPY --from=build /app/packages/shared ./packages/shared
COPY --from=build /app/apps/keeper ./apps/keeper

RUN pnpm install --prod --frozen-lockfile

WORKDIR /app/apps/keeper
CMD ["node", "dist/index.js"]
