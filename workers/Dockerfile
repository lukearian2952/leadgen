FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
# `npm ci` when a lockfile exists, `npm install` on first build before one is
# committed. Commit the lockfile as soon as you have it — reproducible builds
# matter more here than convenience.
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Florida's registry has no API: its unit of distribution is a fixed-width file
# on a public SFTP host, and the quarterly snapshot is a 1.8 GB zip. These three
# are what the FL adapter shells out to.
#
# Deliberately not an npm SFTP client: adding a dependency to this package means
# asking you to run the install, and `sftp` + `unzip` are both already-audited
# system tools that stream, which is what a multi-gigabyte archive needs.
RUN apk add --no-cache openssh-client sshpass unzip

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# graphile-worker looks for ./crontab at boot and disables cron without it.
# Safe to ship to every worker: `known_crontabs` makes a slot fire once
# regardless of how many containers are watching it.
COPY crontab ./crontab

RUN addgroup -g 10001 worker && adduser -D -u 10001 -G worker worker
USER worker

EXPOSE 9100

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${METRICS_PORT:-9100}/healthz || exit 1

CMD ["node", "dist/src/index.js"]
