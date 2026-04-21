FROM node:20-alpine AS build
WORKDIR /app

RUN apk add --no-cache python3 make g++

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/orderbook/package.json apps/orderbook/
COPY packages/shared/package.json packages/shared/

RUN npm i -g pnpm@9.15.1 && pnpm install --filter @etica-hub/orderbook... --frozen-lockfile

COPY packages/shared packages/shared
COPY apps/orderbook apps/orderbook
RUN pnpm --filter @etica-hub/orderbook build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV ORDERBOOK_HOST=0.0.0.0
ENV ORDERBOOK_PORT=3100
ENV ORDERBOOK_DB_PATH=/data/orderbook.db

COPY --from=build /app /app

VOLUME ["/data"]
EXPOSE 3100
CMD ["node", "apps/orderbook/dist/index.js"]
