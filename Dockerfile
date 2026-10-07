# syntax=docker/dockerfile:1
# Two stages: build everything with compilers available, then copy only what
# runs (server + shared code, production dependencies, built client) into a
# small image without compilers.

FROM node:22-alpine AS build
# better-sqlite3 is a native module; these are only needed if no prebuilt binary matches.
RUN apk add --no-cache python3 make g++
WORKDIR /app

# Dependencies first so they are cached between code changes.
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci

COPY shared/ shared/
COPY server/ server/
COPY client/ client/
RUN npm run build -w client

# Replace node_modules with the server's production dependencies only.
RUN rm -rf node_modules && npm ci --omit=dev -w server


FROM node:22-alpine
# tzdata so TZ=America/Toronto gives local times in logs and the backup schedule.
RUN apk add --no-cache tzdata
WORKDIR /app

ARG APP_COMMIT=""
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3100 \
    DATA_DIR=/app/data \
    BACKUP_OFFSITE_DIR=/offsite \
    TZ=America/Toronto \
    APP_COMMIT=${APP_COMMIT}

COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/shared ./shared
COPY --from=build /app/server ./server
COPY --from=build /app/client/dist ./client/dist

RUN mkdir -p /app/data /offsite && chown -R node:node /app/data /offsite
USER node

EXPOSE 3100
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3100/api/health > /dev/null || exit 1

CMD ["node", "server/src/index.js"]
