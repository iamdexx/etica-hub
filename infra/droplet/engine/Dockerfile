# Etica Protocol's open-source explorer engine (github.com/etica/etica-explorer-engine),
# pinned to a commit, run under pm2-runtime so one container hosts the 5 sync
# scripts + the /api server that apps/eticascan reads from.
FROM node:20-alpine
RUN apk add --no-cache git
WORKDIR /engine
ARG ENGINE_REPO=https://github.com/etica/etica-explorer-engine.git
ARG ENGINE_REF=8524d4d83619d80c436a37bf7bbeaea38c5e8faa
RUN git clone "$ENGINE_REPO" . && git checkout -q "$ENGINE_REF" && rm -rf .git \
 && npm ci --omit=dev --no-audit --no-fund && npm install -g pm2@5 --no-audit --no-fund
COPY ecosystem.config.js seed.js entrypoint.sh ./
RUN chmod +x entrypoint.sh
EXPOSE 6633
ENTRYPOINT ["./entrypoint.sh"]
